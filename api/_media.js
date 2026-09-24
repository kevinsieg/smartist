const crypto = require('crypto');
const { getDb, insertAuditLog, getSlug } = require('./_db');
const { requireAuth } = require('./_auth');
const { wrap } = require('./_handler');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload } = require('./_r2');
const { isOwnMediaUrl } = require('./_ownership');
const { wouldExceedStorage, storageLimitBytes } = require('./_plans');

// Shared handler factory for the three R2-backed media endpoints (audio, sheet, playback).
//
// Config shape:
//   keyPrefix     — R2 key prefix, e.g. 'audio/'
//   extraKey      — songs.extra key, e.g. 'listenUrl'
//   maxBytes      — max upload size in bytes
//   actionPrefix  — audit log prefix, e.g. 'audio' → events 'audio_replace', 'audio_delete'
//   allowedExts   — Set of lowercase extensions; if absent the handler accepts only .pdf
//   mimePrefix    — expected MIME prefix for server-side verification, e.g. 'audio/'
function makeMediaFn({ keyPrefix, extraKey, maxBytes, actionPrefix, allowedExts, mimePrefix }) {
  const maxMB = maxBytes / 1024 / 1024;

  return async function handler(req, res) {
    const slug = getSlug(req);
    const { id } = req.query;
    const songId = Number(id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const band = await requireAuth(req, res, slug, 'admin');
    if (!band) return;

    const sql = getDb();

    // ── POST: generate a presigned upload URL ──────────────────────────────
    if (req.method === 'POST') {
      const { filename, contentType, size } = req.body ?? {};
      if (!filename || typeof filename !== 'string')
        return res.status(400).json({ error: 'filename required' });

      if (allowedExts) {
        const ext = filename.split('.').pop().toLowerCase();
        if (!allowedExts.has(ext))
          return res.status(400).json({ error: `Unsupported file type. Allowed: ${[...allowedExts].join(', ')}` });
        if (!contentType || !String(contentType).startsWith(mimePrefix))
          return res.status(400).json({ error: `contentType must be ${mimePrefix}*` });
      } else {
        if (!filename.toLowerCase().endsWith('.pdf'))
          return res.status(400).json({ error: 'Only PDF files are allowed' });
      }

      if (!Number.isInteger(Number(size)) || Number(size) <= 0 || Number(size) > maxBytes)
        return res.status(400).json({ error: `size required, max ${maxMB} MB` });

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      // The band id in the key is what the confirm step below checks.
      const key = `${keyPrefix}${band.id}/${crypto.randomUUID()}-${safeName}`;
      return res.json(await createPresignedUrl(key, allowedExts ? contentType : 'application/pdf', Number(size)));
    }

    // ── PUT: confirm upload — save URL to DB, delete previous file ─────────
    if (req.method === 'PUT') {
      const { publicUrl } = req.body ?? {};
      if (!publicUrl || typeof publicUrl !== 'string')
        return res.status(400).json({ error: 'publicUrl required' });

      const base = process.env.R2_PUBLIC_URL;
      if (!base || !publicUrl.startsWith(`${base}/${keyPrefix}${band.id}/`))
        return res.status(400).json({ error: 'Invalid publicUrl' });

      const [song] = await sql`
        SELECT * FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      const head = await verifyUpload(keyFromUrl(publicUrl));
      if (!head) return res.status(400).json({ error: 'Uploaded file not found in storage' });
      if (!head.contentType.startsWith(mimePrefix)) {
        await deleteFromR2(publicUrl);
        return res.status(400).json({ error: `Uploaded file content type does not match ${mimePrefix}` });
      }
      if (head.size > maxBytes) {
        await deleteFromR2(publicUrl);
        return res.status(400).json({ error: `Uploaded file exceeds ${maxMB} MB` });
      }

      // A replacement frees the previous file's bytes, so the cap check is on the
      // NET change (new − old), not the gross add — otherwise replacing a file
      // with a same-size one would falsely trip the limit near the cap.
      const previousUrl = song.extra?.[extraKey] ?? null;
      // Re-confirming the URL already stored (a retried request) is not a
      // replacement and adds nothing — those bytes are counted already.
      const isReplacement = previousUrl != null && previousUrl !== publicUrl;
      const prevHead = isReplacement
        ? await verifyUpload(keyFromUrl(previousUrl)) : null;
      const prevSize = prevHead ? prevHead.size : 0;

      if (wouldExceedStorage(band, (band.storage_used_bytes || 0) - prevSize, head.size)) {
        await deleteFromR2(publicUrl);
        return res.status(402).json({
          error: 'storage_limit',
          limit: storageLimitBytes(band),
          used:  Number(band.storage_used_bytes || 0),
        });
      }

      const newExtra = { ...(song.extra ?? {}), [extraKey]: publicUrl };
      const [updated] = await sql`
        UPDATE songs SET extra = ${newExtra}
        WHERE id = ${songId} AND artist_id = ${band.id}
        RETURNING *
      `;

      // Delete first: whether the old object really went away decides the net
      // change, so the counter settles in one round-trip instead of a +n then −m
      // pair (which also left it briefly overstated).
      const removed  = (isReplacement && isOwnMediaUrl(previousUrl, band.id, keyFromUrl)) ? await deleteFromR2(previousUrl) : false;
      const freed    = (removed && prevHead) ? prevHead.size : 0;
      const netBytes = (previousUrl === publicUrl ? 0 : head.size) - freed;

      if (netBytes !== 0)
        await sql`UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes + ${netBytes}) WHERE id = ${band.id}`;

      if (isReplacement) {
        await insertAuditLog(sql, band.id, songId, `${actionPrefix}_replace`, {
          previousFilename: filenameFromUrl(previousUrl),
          newFilename:      filenameFromUrl(publicUrl),
          replacedAt:       new Date().toISOString(),
        });
      } else {
        await insertAuditLog(sql, band.id, songId, 'update', updated);
      }

      return res.json({ ok: true, publicUrl });
    }

    // ── DELETE: remove file from R2 and clear DB field ─────────────────────
    if (req.method === 'DELETE') {
      const [song] = await sql`
        SELECT extra FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      const url = song.extra?.[extraKey];
      const writes = [sql`
        UPDATE songs SET extra = extra - ${extraKey}
        WHERE id = ${songId} AND artist_id = ${band.id}
      `];
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

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  };
}

function makeMediaHandler(config) { return wrap(makeMediaFn(config)); }

module.exports = { makeMediaHandler, makeMediaFn };
