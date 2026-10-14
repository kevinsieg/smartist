const crypto = require('crypto');
const { getDb, insertAuditLog, getSlug } = require('./_db');
const { requireAuth, refuseDemo } = require('./_auth');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload, promoteUpload } = require('./_r2');
const { unsafeKey } = require('./_validate');
const { isOwnMediaUrl } = require('./_ownership');
const { storageLimitBytes } = require('./_plans');
const { presignLimited } = require('./_ratelimit');

// Song media (audio, sheet, playback) stored in R2. The three steps — presign,
// confirm, delete — are POST, PUT and DELETE on /api/:artist/songs/:id/:type
// (makeMediaFn). Each step returns { status, body } and never touches the
// response.
//
// Config shape:
//   keyPrefix     — R2 key prefix, e.g. 'audio/'
//   kind          — the song_media kind it is stored as: listen, playback or pdf
//   extraKey      — the song's extra key the client knows it by, e.g. 'listenUrl'
//   waveformKey   — the extra key of the file's loudness profile (audio kinds), which travels with it
//   maxBytes      — max upload size in bytes
//   actionPrefix  — audit log prefix, e.g. 'audio' → events 'audio_replace', 'audio_delete'
//   allowedExts   — Set of lowercase extensions; if absent only .pdf is accepted
//   types         — the exact content types accepted at presign and at confirm

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'ogg', 'wav', 'flac']);
// Exact types, no parameters: the bucket serves back whatever type the upload
// carried, and "audio/mpeg,text/html" passed a prefix check while browsers
// read it as HTML.
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac']);

const MEDIA_CONFIGS = {
  audio:    { keyPrefix: 'audio/',    kind: 'listen',   extraKey: 'listenUrl',   maxBytes: 50 * 1024 * 1024, actionPrefix: 'audio',    allowedExts: AUDIO_EXTS, types: AUDIO_TYPES, waveformKey: 'waveform' },
  sheet:    { keyPrefix: 'sheets/',   kind: 'pdf',      extraKey: 'sheetUrl',    maxBytes: 20 * 1024 * 1024, actionPrefix: 'sheet',    types: new Set(['application/pdf']) },
  playback: { keyPrefix: 'playback/', kind: 'playback', extraKey: 'playbackUrl', maxBytes: 50 * 1024 * 1024, actionPrefix: 'playback', allowedExts: AUDIO_EXTS, types: AUDIO_TYPES, waveformKey: 'playbackWaveform' },
};

const out = (status, body) => ({ status, body });

/**
 * @param {*} sql
 * @param {*} band
 * @param {number} songId
 * @param {*} config
 * @param {{ filename?: string, contentType?: string, size?: number }} [file]
 * @param {string|null} [who] the session's address, for the cap per person
 */
async function presignMedia(sql, band, songId, config, { filename, contentType, size } = {}, who = null) {
  const { keyPrefix, maxBytes, allowedExts, types } = config;
  if (!filename || typeof filename !== 'string') return out(400, { error: 'filename required' });

  if (allowedExts) {
    const ext = filename.split('.').pop().toLowerCase();
    if (!allowedExts.has(ext))
      return out(400, { error: `Unsupported file type. Allowed: ${[...allowedExts].join(', ')}` });
    if (!types.has(String(contentType || '').toLowerCase()))
      return out(400, { error: `Unsupported audio type: ${String(contentType || '').slice(0, 50) || 'none'}` });
  } else if (!filename.toLowerCase().endsWith('.pdf')) {
    return out(400, { error: 'Only PDF files are allowed' });
  }

  if (!Number.isInteger(Number(size)) || Number(size) <= 0 || Number(size) > maxBytes)
    return out(400, { error: `size required, max ${maxBytes / 1024 / 1024} MB` });

  const [song] = await sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`;
  if (!song) return out(404, { error: 'Song not found' });
  // Counted only for a request that would get a URL, so a rejected one costs
  // the band nothing.
  if (await presignLimited(band.id, who)) return out(429, { error: 'Too many uploads — try again later' });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  // The band id in the key is what confirmMedia checks.
  const key = `${keyPrefix}${band.id}/${crypto.randomUUID()}-${safeName}`;
  return out(200, await createPresignedUrl(key, allowedExts ? String(contentType).toLowerCase() : 'application/pdf', Number(size), { pending: true }));
}

// Move the band's storage counter by `delta` bytes, refused when that passes
// the plan's cap. The cap check and the update are one statement: band was read
// before this request's R2 round-trips, so two uploads confirmed at once would
// both pass a check against that stale value.
async function reserveStorage(sql, band, delta) {
  const limit = storageLimitBytes(band);
  const [row] = await sql`
    UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes + ${delta})
    WHERE id = ${band.id}
      AND (${limit}::bigint IS NULL OR storage_used_bytes + ${delta} <= ${limit}::bigint)
    RETURNING storage_used_bytes`;
  return !!row;
}

async function releaseStorage(sql, band, bytes) {
  await sql`UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes - ${bytes}) WHERE id = ${band.id}`;
}

function storageFull(band) {
  return { error: 'Storage limit reached', code: 'storage_limit', limit: storageLimitBytes(band), used: Number(band.storage_used_bytes || 0) };
}

// Confirm an upload: store its URL on the song, drop the file it replaces, and
// move the band's storage counter by the net change.
// 100 peaks, 2 hex digits each, computed in the browser (app/js/waveform.js).
const WAVEFORM_RE = /^[0-9a-f]{200}$/;

async function confirmMedia(sql, band, songId, config, publicUrl, waveform) {
  const { keyPrefix, extraKey, maxBytes, actionPrefix, types } = config;
  if (!publicUrl || typeof publicUrl !== 'string') return out(400, { error: 'publicUrl required' });
  if (config.waveformKey && waveform != null && !(typeof waveform === 'string' && WAVEFORM_RE.test(waveform)))
    return out(400, { error: 'Invalid waveform' });

  const base = process.env.R2_PUBLIC_URL;
  // Keys carry the band id (see presignMedia), so a band can only confirm —
  // and later delete — files it uploaded itself.
  if (!base || !publicUrl.startsWith(`${base}/${keyPrefix}${band.id}/`) || unsafeKey(keyFromUrl(publicUrl)))
    return out(400, { error: 'Invalid publicUrl' });

  // Independent: moving the upload out of pending/ and the song lookup overlap.
  const [head, [song]] = await Promise.all([
    promoteUpload(keyFromUrl(publicUrl)),
    // The song (for the audit entry) and the file this kind holds now.
    sql`
      SELECT to_jsonb(s) AS song, m.url FROM songs s
      LEFT JOIN song_media m ON m.song_id = s.id AND m.kind = ${config.kind}
      WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND s.deleted = false`,
  ]);
  if (!head) return out(400, { error: 'Uploaded file not found in storage' });
  if (!types.has(String(head.contentType).toLowerCase())) {
    await deleteFromR2(publicUrl);
    return out(400, { error: 'Uploaded file has an unsupported content type' });
  }
  if (head.size > maxBytes) {
    await deleteFromR2(publicUrl);
    return out(400, { error: `Uploaded file exceeds ${maxBytes / 1024 / 1024} MB` });
  }
  if (!song) return out(404, { error: 'Song not found' });

  // A replacement frees the previous file's bytes, so the cap check is on the
  // NET change (new − old), not the gross add — otherwise replacing a file with
  // a same-size one would falsely trip the limit near the cap.
  const previousUrl = song.url ?? null;
  // Re-confirming the URL already stored (a retried request) is not a
  // replacement and adds nothing — those bytes are counted already.
  const isReplacement = previousUrl != null && previousUrl !== publicUrl;
  const prevHead = isReplacement ? await verifyUpload(keyFromUrl(previousUrl)) : null;
  const prevSize = prevHead ? prevHead.size : 0;

  const reserved = previousUrl === publicUrl ? 0 : head.size - prevSize;
  if (reserved !== 0 && !(await reserveStorage(sql, band, reserved))) {
    await deleteFromR2(publicUrl);
    return out(402, storageFull(band));
  }

  // A recording replaces the previous one's waveform, or clears it when the
  // browser could not compute one. One row per song and kind.
  const onKind = config.kind === 'listen' ? sql`WHERE kind = 'listen'` : config.kind === 'playback' ? sql`WHERE kind = 'playback'` : sql`WHERE kind = 'pdf'`;
  await sql`
    INSERT INTO song_media (song_id, artist_id, kind, url, waveform)
    VALUES (${songId}, ${band.id}, ${config.kind}, ${publicUrl}, ${config.waveformKey ? waveform ?? null : null})
    ON CONFLICT (song_id) ${onKind} DO UPDATE
      SET url = EXCLUDED.url, waveform = EXCLUDED.waveform, updated_at = NOW()`;
  // The song as the history keeps it: with the new file in its extra.
  const updated = { ...song.song, extra: { ...(song.song.extra || {}), [extraKey]: publicUrl } };

  // The reservation assumed the old file goes away; if it stays, count it again.
  const removed = (isReplacement && isOwnMediaUrl(previousUrl, band.id, keyFromUrl)) ? await deleteFromR2(previousUrl) : false;
  const kept    = (!removed && prevHead) ? prevHead.size : 0;

  const log = isReplacement
    ? insertAuditLog(sql, band.id, songId, `${actionPrefix}_replace`, {
        previousFilename: filenameFromUrl(previousUrl),
        newFilename:      filenameFromUrl(publicUrl),
        replacedAt:       new Date().toISOString(),
      })
    : insertAuditLog(sql, band.id, songId, 'update', updated);
  await Promise.all([
    kept !== 0
      ? sql`UPDATE artists SET storage_used_bytes = storage_used_bytes + ${kept} WHERE id = ${band.id}`
      : null,
    log,
  ]);
  return out(200, { ok: true, publicUrl });
}

// Remove a song's file from R2 and its song_media row.
async function deleteMedia(sql, band, songId, config) {
  const { actionPrefix } = config;
  const [song] = await sql`
    SELECT m.url FROM songs s
    LEFT JOIN song_media m ON m.song_id = s.id AND m.kind = ${config.kind}
    WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND s.deleted = false
  `;
  if (!song) return out(404, { error: 'Song not found' });

  const url = song.url;
  const writes = [sql`DELETE FROM song_media WHERE song_id = ${songId} AND artist_id = ${band.id} AND kind = ${config.kind}`];
  if (url) {
    const delHead = await verifyUpload(keyFromUrl(url));
    const removed = isOwnMediaUrl(url, band.id, keyFromUrl) ? await deleteFromR2(url) : false;
    if (removed && delHead) writes.push(sql`UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes - ${delHead.size}) WHERE id = ${band.id}`);
    writes.push(insertAuditLog(sql, band.id, songId, `${actionPrefix}_delete`, {
      filename:  filenameFromUrl(url),
      deletedAt: new Date().toISOString(),
    }));
  }
  await Promise.all(writes);
  return out(200, { ok: true });
}

// REST-style routes for one media type: POST presign, PUT confirm, DELETE.
function makeMediaFn(config) {
  return async function handler(req, res) {
    const slug = getSlug(req);
    const songId = Number(req.query.id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    // Member: anyone who may edit a song may attach its files.
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (refuseDemo(req, res)) return;
    const sql = getDb();

    let result;
    if (req.method === 'POST')        result = await presignMedia(sql, band, songId, config, req.body ?? {}, req.user?.email ?? null);
    else if (req.method === 'PUT')    result = await confirmMedia(sql, band, songId, config, req.body?.publicUrl, req.body?.waveform);
    else if (req.method === 'DELETE') result = await deleteMedia(sql, band, songId, config);
    else                              result = out(405, { error: 'Method not allowed' });
    return res.status(result.status).json(result.body);
  };
}

module.exports = { MEDIA_CONFIGS, makeMediaFn, out, reserveStorage, releaseStorage, storageFull, AUDIO_EXTS, AUDIO_TYPES, WAVEFORM_RE };
