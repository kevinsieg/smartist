const crypto = require('crypto');
const { getDb, insertAuditLog } = require('./_db');
const { requireAuth } = require('./_auth');
const { wrap } = require('./_handler');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload } = require('./_r2');

// Shared handler factory for the three R2-backed media endpoints (audio, sheet, playback).
//
// Config shape:
//   keyPrefix     — R2 key prefix, e.g. 'audio/'
//   extraKey      — songs.extra key, e.g. 'listenUrl'
//   maxBytes      — max upload size in bytes
//   actionPrefix  — audit log prefix, e.g. 'audio' → events 'audio_replace', 'audio_delete'
//   allowedExts   — Set of lowercase extensions; if absent the handler accepts only .pdf
//   mimePrefix    — expected MIME prefix for server-side verification, e.g. 'audio/'
function makeMediaHandler({ keyPrefix, extraKey, maxBytes, actionPrefix, allowedExts, mimePrefix }) {
  const maxMB = maxBytes / 1024 / 1024;

  return wrap(async function handler(req, res) {
    const { band: slug, id } = req.query;
    const songId = Number(id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const band = await requireAuth(req, res, slug);
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

      if (!size || Number(size) > maxBytes)
        return res.status(400).json({ error: `size required, max ${maxMB} MB` });

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const key = `${keyPrefix}${crypto.randomUUID()}-${safeName}`;
      return res.json(await createPresignedUrl(key, allowedExts ? contentType : 'application/pdf'));
    }

    // ── PUT: confirm upload — save URL to DB, delete previous file ─────────
    if (req.method === 'PUT') {
      const { publicUrl } = req.body ?? {};
      if (!publicUrl || typeof publicUrl !== 'string')
        return res.status(400).json({ error: 'publicUrl required' });

      const base = process.env.R2_PUBLIC_URL;
      if (!base || !publicUrl.startsWith(`${base}/${keyPrefix}`))
        return res.status(400).json({ error: 'Invalid publicUrl' });

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

      const [song] = await sql`
        SELECT * FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      const previousUrl = song.extra?.[extraKey] ?? null;
      const newExtra = { ...(song.extra ?? {}), [extraKey]: publicUrl };
      const [updated] = await sql`
        UPDATE songs SET extra = ${newExtra}
        WHERE id = ${songId} AND band_id = ${band.id}
        RETURNING *
      `;

      if (previousUrl && previousUrl !== publicUrl) {
        await deleteFromR2(previousUrl);
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
        SELECT extra FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      const url = song.extra?.[extraKey];
      if (url) {
        await deleteFromR2(url);
        await insertAuditLog(sql, band.id, songId, `${actionPrefix}_delete`, {
          filename:  filenameFromUrl(url),
          deletedAt: new Date().toISOString(),
        });
      }

      await sql`
        UPDATE songs SET extra = extra - ${extraKey}
        WHERE id = ${songId} AND band_id = ${band.id}
      `;

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  });
}

module.exports = { makeMediaHandler };
