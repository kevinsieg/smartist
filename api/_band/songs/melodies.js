'use strict';

const crypto = require('crypto');
const { getDb, getSlug, insertAuditLog } = require('../../_db');
const { requireAuth, refuseDemo } = require('../../_auth');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload, promoteUpload } = require('../../_r2');
const { unsafeKey } = require('../../_validate');
const { isOwnMediaUrl } = require('../../_ownership');
const { presignLimited } = require('../../_ratelimit');
const { out, reserveStorage, releaseStorage, storageFull, AUDIO_EXTS, AUDIO_TYPES, WAVEFORM_RE } = require('../../_media');
const { SONG_KEY, MELODY_LIMITS, IMAGE_EXTS, IMAGE_TYPES, instrumentKnown, getMelody } = require('../../_domain/melodies');

// /songs/:id/melodies/:instrument[/sheet|audio]: a melody's sheet images and
// audio recording. Files go to R2 under the band's own sheets/ and audio/
// prefixes (presign, upload, confirm), like the other song media.

const KINDS = {
  sheet: { prefix: 'sheets/', exts: IMAGE_EXTS, types: IMAGE_TYPES, maxBytes: MELODY_LIMITS.imageBytes },
  audio: { prefix: 'audio/',  exts: AUDIO_EXTS, types: AUDIO_TYPES, maxBytes: MELODY_LIMITS.audioBytes },
};

/**
 * @param {*} sql
 * @param {*} band
 * @param {number} songId
 * @param {string} instrument
 * @param {'sheet'|'audio'} kind
 * @param {{ filename?: string, contentType?: string, size?: number }} [file]
 * @param {string|null} [who] the session's address, for the cap per person
 */
async function presign(sql, band, songId, instrument, kind, { filename, contentType, size } = {}, who) {
  const { prefix, exts, types, maxBytes } = KINDS[kind];
  if (!filename || typeof filename !== 'string') return out(400, { error: 'filename required' });
  if (!exts.has(filename.split('.').pop().toLowerCase()))
    return out(400, { error: `Unsupported file type. Allowed: ${[...exts].join(', ')}` });
  if (!types.has(String(contentType || '').toLowerCase()))
    return out(400, { error: `Unsupported type: ${String(contentType || '').slice(0, 50) || 'none'}` });
  if (!Number.isInteger(Number(size)) || Number(size) <= 0 || Number(size) > maxBytes)
    return out(400, { error: `size required, max ${maxBytes / 1024 / 1024} MB` });

  const [song] = await sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`;
  if (!song) return out(404, { error: 'Song not found' });
  if (await presignLimited(band.id, who)) return out(429, { error: 'Too many uploads — try again later' });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const key = `${prefix}${band.id}/${crypto.randomUUID()}-${safeName}`;
  return out(200, await createPresignedUrl(key, String(contentType).toLowerCase(), Number(size), { pending: true }));
}

// A file the band owns, removed from R2; its bytes leave the counter only when
// the object really went away.
async function dropFile(sql, band, url) {
  if (!url || !isOwnMediaUrl(url, band.id, keyFromUrl)) return;
  const head = await verifyUpload(keyFromUrl(url));
  const removed = await deleteFromR2(url);
  if (removed && head) await releaseStorage(sql, band, head.size);
}

// Why the upsert wrote nothing: the song is gone or a limit was hit.
async function refusal(sql, band, songId, instrument) {
  const [d] = await sql`
    SELECT (SELECT true FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND NOT deleted) AS song,
           (SELECT count(*)::int FROM song_melodies WHERE song_id = ${songId} AND artist_id = ${band.id}) AS n,
           (SELECT cardinality(sheet_urls) FROM song_melodies
            WHERE song_id = ${songId} AND artist_id = ${band.id} AND instrument = ${instrument}) AS imgs`;
  if (!d?.song) return out(404, { error: 'Song not found' });
  if (d.imgs != null && d.imgs >= MELODY_LIMITS.images)
    return out(409, { error: `At most ${MELODY_LIMITS.images} images per melody`, code: 'image_limit' });
  return out(409, { error: `At most ${MELODY_LIMITS.perSong} melodies per song`, code: 'melody_limit' });
}

async function confirm(sql, band, songId, instrument, kind, publicUrl, waveform) {
  const { prefix, types, maxBytes } = KINDS[kind];
  if (!publicUrl || typeof publicUrl !== 'string') return out(400, { error: 'publicUrl required' });
  if (kind === 'audio' && waveform != null && !(typeof waveform === 'string' && WAVEFORM_RE.test(waveform)))
    return out(400, { error: 'Invalid waveform' });
  const base = process.env.R2_PUBLIC_URL;
  // The band id in the key is what proves the band uploaded it (see presign).
  if (!base || !publicUrl.startsWith(`${base}/${prefix}${band.id}/`) || unsafeKey(keyFromUrl(publicUrl)))
    return out(400, { error: 'Invalid publicUrl' });

  const [head, existing] = await Promise.all([
    promoteUpload(keyFromUrl(publicUrl)),
    getMelody(sql, band.id, songId, instrument),
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
  // A retried confirm: counted and stored already.
  const stored = kind === 'sheet' ? existing?.sheet_urls?.includes(publicUrl) : existing?.audio_url === publicUrl;
  if (stored) return out(200, { ok: true, publicUrl });

  const previousUrl = kind === 'audio' ? existing?.audio_url ?? null : null;
  const prevHead = previousUrl ? await verifyUpload(keyFromUrl(previousUrl)) : null;
  const prevSize = prevHead ? prevHead.size : 0;
  const delta = head.size - prevSize;
  if (delta !== 0 && !(await reserveStorage(sql, band, delta))) {
    await deleteFromR2(publicUrl);
    return out(402, storageFull(band));
  }

  const roomForNew = sql`(cnt.n < ${MELODY_LIMITS.perSong}
    OR EXISTS (SELECT 1 FROM song_melodies WHERE song_id = ${songId} AND artist_id = ${band.id} AND instrument = ${instrument}))`;
  const rows = kind === 'sheet'
    ? await sql`
        WITH cnt AS (SELECT count(*)::int AS n FROM song_melodies WHERE song_id = ${songId} AND artist_id = ${band.id})
        INSERT INTO song_melodies (song_id, artist_id, instrument, sheet_urls)
        SELECT ${songId}, ${band.id}, ${instrument}, ARRAY[${publicUrl}]::text[]
        FROM songs s, cnt
        WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND NOT s.deleted AND ${roomForNew}
        ON CONFLICT (song_id, instrument) DO UPDATE
          SET sheet_urls = song_melodies.sheet_urls || EXCLUDED.sheet_urls, updated_at = NOW()
          WHERE cardinality(song_melodies.sheet_urls) < ${MELODY_LIMITS.images}
        RETURNING id`
    : await sql`
        WITH cnt AS (SELECT count(*)::int AS n FROM song_melodies WHERE song_id = ${songId} AND artist_id = ${band.id})
        INSERT INTO song_melodies (song_id, artist_id, instrument, audio_url, waveform)
        SELECT ${songId}, ${band.id}, ${instrument}, ${publicUrl}, ${waveform ?? null}::text
        FROM songs s, cnt
        WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND NOT s.deleted AND ${roomForNew}
        ON CONFLICT (song_id, instrument) DO UPDATE SET audio_url = EXCLUDED.audio_url, waveform = EXCLUDED.waveform, updated_at = NOW()
        RETURNING id`;
  if (!rows.length) {
    await deleteFromR2(publicUrl);
    if (delta > 0) await releaseStorage(sql, band, delta);
    return refusal(sql, band, songId, instrument);
  }

  // The reservation assumed the replaced audio goes away; if it stays, count it again.
  if (previousUrl) {
    const removed = isOwnMediaUrl(previousUrl, band.id, keyFromUrl) ? await deleteFromR2(previousUrl) : false;
    if (!removed && prevSize) await reserveStorage(sql, band, prevSize);
  }
  await insertAuditLog(sql, band.id, songId, 'melody_replace', {
    instrument, kind, newFilename: filenameFromUrl(publicUrl), replacedAt: new Date().toISOString(),
  });
  return out(200, { ok: true, publicUrl });
}

async function removeSheet(sql, band, songId, instrument, url) {
  if (!url || typeof url !== 'string') return out(400, { error: 'url required' });
  const rows = await sql`
    UPDATE song_melodies SET sheet_urls = array_remove(sheet_urls, ${url}), updated_at = NOW()
    WHERE song_id = ${songId} AND artist_id = ${band.id} AND instrument = ${instrument} AND ${url} = ANY(sheet_urls)
    RETURNING id`;
  if (!rows.length) return out(404, { error: 'Image not found' });
  await dropFile(sql, band, url);
  await insertAuditLog(sql, band.id, songId, 'melody_delete', { instrument, kind: 'sheet', filename: filenameFromUrl(url), deletedAt: new Date().toISOString() });
  return out(200, { ok: true });
}

async function removeAudio(sql, band, songId, instrument) {
  const rows = await sql`
    WITH old AS (
      SELECT id, audio_url FROM song_melodies
      WHERE song_id = ${songId} AND artist_id = ${band.id} AND instrument = ${instrument} FOR UPDATE
    ), cleared AS (
      UPDATE song_melodies SET audio_url = NULL, waveform = NULL, updated_at = NOW() WHERE id IN (SELECT id FROM old)
    )
    SELECT audio_url FROM old`;
  if (!rows.length) return out(404, { error: 'Melody not found' });
  const url = rows[0].audio_url;
  if (url) {
    await dropFile(sql, band, url);
    await insertAuditLog(sql, band.id, songId, 'melody_delete', { instrument, kind: 'audio', filename: filenameFromUrl(url), deletedAt: new Date().toISOString() });
  }
  return out(200, { ok: true });
}

async function removeMelody(sql, band, songId, instrument) {
  const rows = await sql`
    DELETE FROM song_melodies
    WHERE song_id = ${songId} AND artist_id = ${band.id} AND instrument = ${instrument}
    RETURNING sheet_urls, audio_url`;
  if (!rows.length) return out(404, { error: 'Melody not found' });
  const urls = [...(rows[0].sheet_urls || []), ...(rows[0].audio_url ? [rows[0].audio_url] : [])];
  for (const url of urls) await dropFile(sql, band, url);
  await insertAuditLog(sql, band.id, songId, 'melody_delete', { instrument, kind: 'melody', files: urls.length, deletedAt: new Date().toISOString() });
  return out(200, { ok: true });
}

// /songs/:id/melodies/:instrument[/:kind] — `instrument` and `kind` are the
// path segments after "melodies".
module.exports = async function melodies(req, res, songId, instrument, kind) {
  if (!instrument || (kind !== undefined && !Object.hasOwn(KINDS, kind))) return res.status(404).json({ error: 'Not found' });
  const band = await requireAuth(req, res, getSlug(req), 'member');
  if (!band) return;
  if (refuseDemo(req, res)) return;
  const sql = getDb();

  let result;
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!kind) result = out(405, { error: 'Method not allowed' });
    else if (instrument === SONG_KEY && kind === 'audio') result = out(400, { error: 'The whole song takes images only' });
    else if (instrument !== SONG_KEY && !instrumentKnown(band, instrument)) result = out(400, { error: 'Unknown instrument' });
    else if (req.method === 'POST') result = await presign(sql, band, songId, instrument, kind, req.body ?? {}, req.user?.email ?? null);
    else result = await confirm(sql, band, songId, instrument, kind, req.body?.publicUrl, req.body?.waveform);
  } else if (req.method === 'DELETE') {
    if (kind === 'sheet')      result = await removeSheet(sql, band, songId, instrument, req.query?.url);
    else if (kind === 'audio') result = await removeAudio(sql, band, songId, instrument);
    else                       result = await removeMelody(sql, band, songId, instrument);
  } else {
    result = out(405, { error: 'Method not allowed' });
  }
  return res.status(result.status).json(result.body);
};
