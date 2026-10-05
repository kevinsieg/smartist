// The S3 SDK (~300 ms to load) is required on first use, not at module load:
// songs, gigs, setlists and config import this module for keyFromUrl or a rare
// upload, and loading the SDK on every cold start slowed their plain reads.
let _sdk;
function sdk() {
  if (!_sdk) {
    _sdk = {
      ...require('@aws-sdk/client-s3'),
      getSignedUrl: require('@aws-sdk/s3-request-presigner').getSignedUrl,
    };
  }
  return _sdk;
}

// ── Object storage provider ───────────────────────────────────────────────────
// Current: Cloudflare R2 (S3-compatible, free tier: 10 GB storage, no egress fees)
// The @aws-sdk/client-s3 package works with any S3-compatible provider.
// To switch providers, update STORAGE and the env vars in .env / Vercel dashboard.
//
//   AWS S3:       remove endpoint, set region to your bucket's region (e.g. 'eu-west-1')
//                 env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME, S3_PUBLIC_URL
//   Backblaze B2: endpoint = 'https://s3.{region}.backblazeb2.com', region = '{region}'
//   MinIO:        endpoint = 'http://localhost:9000', region = 'us-east-1'
//
// Non-S3 providers (GCS, Azure Blob): replace the SDK; keep exported function
// signatures (createPresignedUrl, deleteFromR2, keyFromUrl, filenameFromUrl) so
// callers need no changes — deleteFromR2 must keep returning whether the object
// was removed, since storage accounting depends on it.
const STORAGE = {
  region:          'auto',                                                             // AWS S3: e.g. 'eu-west-1'
  endpoint:        () => `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, // remove for AWS S3
  accessKeyId:     () => process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: () => process.env.R2_SECRET_ACCESS_KEY,
  bucket:          () => process.env.R2_BUCKET_NAME,
  publicUrl:       () => process.env.R2_PUBLIC_URL,
};
// ─────────────────────────────────────────────────────────────────────────────

// Uploads not yet confirmed (see createPresignedUrl).
const PENDING_PREFIX = 'pending/';

function getR2Client() {
  const { S3Client } = sdk();
  return new S3Client({
    region:      STORAGE.region,
    endpoint:    STORAGE.endpoint(),
    credentials: { accessKeyId: STORAGE.accessKeyId(), secretAccessKey: STORAGE.secretAccessKey() },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

function keyFromUrl(url) {
  const base = STORAGE.publicUrl();
  // `${base}/`, not `base`: https://<bucket host>.example.org/… is not ours.
  if (base && typeof url === 'string' && url.startsWith(`${base}/`)) return url.slice(base.length + 1);
  return null;
}

function filenameFromUrl(url) {
  try { return decodeURIComponent(url.split('/').pop().split('?')[0]); } catch { return url; }
}

// Reports whether the object is gone. Callers credit artists.storage_used_bytes
// back only on true, so a swallowed failure never frees bytes that are still
// stored. Never throws — a failed delete stays non-fatal (the audit log entry is
// still written).
async function deleteFromR2(url) {
  const key = keyFromUrl(url);
  if (!key) return false;
  try {
    await getR2Client().send(new (sdk().DeleteObjectCommand)({ Bucket: STORAGE.bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

// contentLength, when given, is signed into the URL: the upload must be exactly
// that many bytes, so a presigned URL cannot be used to park an arbitrarily
// large file in the bucket (the size is otherwise only checked at confirm).
//
// pending: the upload lands under PENDING_PREFIX and promoteUpload moves it to
// its key on confirm. A bucket lifecycle rule expires that prefix after a day
// (docs/deployment.md), so a file that is uploaded and never confirmed, which
// no storage counter knows about, does not stay in the bucket. publicUrl is
// always the final address.
async function createPresignedUrl(key, contentType, contentLength, { pending = false } = {}) {
  const params = { Bucket: STORAGE.bucket(), Key: pending ? PENDING_PREFIX + key : key, ContentType: contentType };
  if (Number.isInteger(contentLength) && contentLength > 0) params.ContentLength = contentLength;
  const { PutObjectCommand, getSignedUrl } = sdk();
  const command = new PutObjectCommand(params);
  // The type is signed too: unsigned, the uploader could send text/html or
  // SVG under a URL presigned for an image or audio file, and the bucket
  // serves back whatever type the upload carried.
  const uploadUrl = await getSignedUrl(getR2Client(), command,
    { expiresIn: 300, signableHeaders: new Set(['content-type']) });
  const publicUrl = `${STORAGE.publicUrl()}/${key}`;
  return { uploadUrl, publicUrl };
}

async function verifyUpload(key) {
  try {
    const r = await getR2Client().send(new (sdk().HeadObjectCommand)({ Bucket: STORAGE.bucket(), Key: key }));
    return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? '' };
  } catch {
    return null;
  }
}

// Confirm step for a pending upload: the object under its final key, moved
// there from PENDING_PREFIX if it is not there yet (a retried confirm finds it
// in place, as does an upload presigned before uploads went through pending/).
// Returns verifyUpload's { size, contentType }, or null when neither exists.
async function promoteUpload(key) {
  const done = await verifyUpload(key);
  if (done) return done;
  const head = await verifyUpload(PENDING_PREFIX + key);
  if (!head) return null;
  const { CopyObjectCommand, DeleteObjectCommand } = sdk();
  const client = getR2Client();
  await client.send(new CopyObjectCommand({
    Bucket: STORAGE.bucket(), Key: key,
    CopySource: `${STORAGE.bucket()}/${encodeURI(PENDING_PREFIX + key)}`,
  }));
  // The copy is what counts; a pending copy left behind expires with the rule.
  await client.send(new DeleteObjectCommand({ Bucket: STORAGE.bucket(), Key: PENDING_PREFIX + key })).catch(() => null);
  return head;
}

// The bucket's public base URL without a trailing slash, or null when unset:
// what the pages prefix media keys with (mediaBase in /api/config).
function publicBaseUrl() {
  return (STORAGE.publicUrl() || '').replace(/\/+$/, '') || null;
}

module.exports = { keyFromUrl, filenameFromUrl, deleteFromR2, createPresignedUrl, verifyUpload, promoteUpload, publicBaseUrl, PENDING_PREFIX };
