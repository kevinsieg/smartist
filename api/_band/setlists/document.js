'use strict';

const crypto = require('crypto');
const { getDb, getSlug } = require('../../_db');
const { requireAuth, refuseDemo } = require('../../_auth');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload, promoteUpload } = require('../../_r2');
const { unsafeKey } = require('../../_validate');
const { isOwnMediaUrl } = require('../../_ownership');
const { presignLimited } = require('../../_ratelimit');
const { out, reserveStorage, releaseStorage, storageFull } = require('../../_media');

// /setlists/:id/document: one PDF attached to a setlist (the evening's
// schedule), kept in setlists.document_url / document_name. The file goes to R2
// under the band's own documents/ prefix (presign, upload, confirm), like the
// song PDFs, and counts against the band's storage.

const PREFIX = 'documents/';
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * @param {*} sql
 * @param {*} band
 * @param {number} setlistId
 * @param {{ filename?: string, contentType?: string, size?: number }} [file]
 * @param {string|null} [who] the session's address, for the cap per person
 */
async function presign(sql, band, setlistId, { filename, contentType, size } = {}, who) {
  if (!filename || typeof filename !== 'string') return out(400, { error: 'filename required' });
  if (!filename.toLowerCase().endsWith('.pdf')) return out(400, { error: 'Only PDF files are allowed' });
  if (String(contentType || '').toLowerCase() !== 'application/pdf')
    return out(400, { error: `Unsupported type: ${String(contentType || '').slice(0, 50) || 'none'}` });
  if (!Number.isInteger(Number(size)) || Number(size) <= 0 || Number(size) > MAX_BYTES)
    return out(400, { error: `size required, max ${MAX_BYTES / 1024 / 1024} MB` });

  const [setlist] = await sql`SELECT id FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id}`;
  if (!setlist) return out(404, { error: 'Setlist not found' });
  if (await presignLimited(band.id, who)) return out(429, { error: 'Too many uploads — try again later' });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const key = `${PREFIX}${band.id}/${crypto.randomUUID()}-${safeName}`;
  return out(200, await createPresignedUrl(key, 'application/pdf', Number(size), { pending: true }));
}

// The file name people see: the upload's name without the unique id in front.
function displayName(url) {
  return filenameFromUrl(url).replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, '');
}

async function confirm(sql, band, setlistId, publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string') return out(400, { error: 'publicUrl required' });
  const base = process.env.R2_PUBLIC_URL;
  // Keys carry the band id (see presign), so a band can only confirm — and
  // later delete — files it uploaded itself.
  if (!base || !publicUrl.startsWith(`${base}/${PREFIX}${band.id}/`) || unsafeKey(keyFromUrl(publicUrl)))
    return out(400, { error: 'Invalid publicUrl' });

  const [head, [setlist]] = await Promise.all([
    promoteUpload(keyFromUrl(publicUrl)),
    sql`SELECT document_url FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id}`,
  ]);
  if (!head) return out(400, { error: 'Uploaded file not found in storage' });
  if (String(head.contentType).toLowerCase() !== 'application/pdf') {
    await deleteFromR2(publicUrl);
    return out(400, { error: 'Uploaded file has an unsupported content type' });
  }
  if (head.size > MAX_BYTES) {
    await deleteFromR2(publicUrl);
    return out(400, { error: `Uploaded file exceeds ${MAX_BYTES / 1024 / 1024} MB` });
  }
  if (!setlist) {
    await deleteFromR2(publicUrl);
    return out(404, { error: 'Setlist not found' });
  }

  // A replacement frees the previous file's bytes: the cap check is on the net
  // change. Re-confirming the address already stored adds nothing.
  const previousUrl = setlist.document_url;
  const isReplacement = !!previousUrl && previousUrl !== publicUrl;
  const prevHead = isReplacement ? await verifyUpload(keyFromUrl(previousUrl)) : null;
  const reserved = previousUrl === publicUrl ? 0 : head.size - (prevHead ? prevHead.size : 0);
  if (reserved !== 0 && !(await reserveStorage(sql, band, reserved))) {
    await deleteFromR2(publicUrl);
    return out(402, storageFull(band));
  }

  const name = displayName(publicUrl);
  await sql`
    UPDATE setlists SET document_url = ${publicUrl}, document_name = ${name}
    WHERE id = ${setlistId} AND artist_id = ${band.id}`;

  // The reservation assumed the old file goes away; if it stays, count it again.
  const removed = (isReplacement && isOwnMediaUrl(previousUrl, band.id, keyFromUrl)) ? await deleteFromR2(previousUrl) : false;
  if (!removed && prevHead) await sql`UPDATE artists SET storage_used_bytes = storage_used_bytes + ${prevHead.size} WHERE id = ${band.id}`;
  return out(200, { ok: true, document_url: publicUrl, document_name: name });
}

// A file the band owns, removed from R2; its bytes leave the counter only when
// the object really went away. Shared with deleting the whole setlist.
async function dropDocument(sql, band, url) {
  if (!url || !isOwnMediaUrl(url, band.id, keyFromUrl)) return;
  const head = await verifyUpload(keyFromUrl(url));
  const removed = await deleteFromR2(url);
  if (removed && head) await releaseStorage(sql, band, head.size);
}

async function remove(sql, band, setlistId) {
  const [row] = await sql`
    WITH old AS (SELECT document_url FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id})
    UPDATE setlists s SET document_url = NULL, document_name = NULL
    FROM old WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
    RETURNING old.document_url`;
  if (!row) return out(404, { error: 'Setlist not found' });
  await dropDocument(sql, band, row.document_url);
  return out(200, { ok: true });
}

async function handler(req, res, setlistId) {
  const band = await requireAuth(req, res, getSlug(req), 'member');
  if (!band) return;
  if (refuseDemo(req, res)) return;
  const sql = getDb();

  let result;
  if (req.method === 'POST')        result = await presign(sql, band, setlistId, req.body ?? {}, req.user?.email ?? null);
  else if (req.method === 'PUT')    result = await confirm(sql, band, setlistId, req.body?.publicUrl);
  else if (req.method === 'DELETE') result = await remove(sql, band, setlistId);
  else                              result = out(405, { error: 'Method not allowed' });
  return res.status(result.status).json(result.body);
}

module.exports = { handler, dropDocument };
