const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, canBrowseCatalogue, refuseDemo } = require('../_auth');
const { validateStr, validateNum } = require('../_validate');
const { wrap } = require('../_handler');
const { clientIp } = require('../_ratelimit');
const { suggestLyrics } = require('../_lyrics');
const { MEDIA_LOG_ACTIONS } = require('../_constants');
const { keyFromUrl } = require('../_r2');
const { MEDIA_CONFIGS, presignMedia, confirmMedia, deleteMedia } = require('../_media');
const { songLimit } = require('../_plans');
const { energyToScale, matchGenre } = require('../_song_values');
const {
  listSongs, cleanLyrics, cleanLanguage, splitMovedKeys, writeLyrics,
} = require('../_domain/songs');

const ENERGY_ERROR = 'energy must be a number from 0 to 10';

async function genresOf(sql, artistId) {
  const rows = await sql`
    SELECT DISTINCT genre FROM songs
    WHERE artist_id = ${artistId} AND NOT deleted AND genre IS NOT NULL AND genre <> ''`;
  return rows.map(r => r.genre);
}

// `extra` is free-form, but its *Url keys end up in href/src attributes on the
// songs and stage pages, so they must be plain http(s) links. A link into our
// own bucket may only be the one the upload flow already stored on this song:
// otherwise a band could point its song at another band's file and have it
// deleted by the next media replace, media delete or account deletion.
function extraError(extra, current = {}) {
  if (extra == null) return null;
  if (typeof extra !== 'object' || Array.isArray(extra)) return 'extra must be an object';
  for (const [k, v] of Object.entries(extra)) {
    if (!/Url$/.test(k) || v == null || v === '') continue;
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return `${k} must be an http(s) URL`;
    if (keyFromUrl(v) !== null && v !== (current || {})[k]) return `${k} must be uploaded, not linked`;
  }
  return null;
}

// A flag from the request, or the stored value when it is absent or not a flag
// (null must not clear a NOT NULL column).
function toBool(v, fallback) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return fallback;
}

// Song id from a body field (lyrics_update_id, media_confirm_id, …), or null.
function bodyId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  // ── song-logs (merged from song-logs.js via vercel.json rewrite) ──────────
  if (req.url.includes('song-logs')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { songId } = req.query;
    let logs;
    if (songId) {
      const sid = Number(songId);
      if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'Invalid songId' });
      logs = await sql`
        SELECT * FROM song_logs
        WHERE artist_id = ${band.id} AND song_id = ${sid}
          AND action = ANY(${MEDIA_LOG_ACTIONS})
        ORDER BY changed_at DESC LIMIT 20
      `;
    } else {
      // The recent-changes list shows titles only; the full row snapshots
      // stay in the database.
      logs = await sql`
        SELECT id, song_id, action, changed_at,
               jsonb_build_object('title', song_data->'title') AS song_data
        FROM song_logs WHERE artist_id = ${band.id}
        ORDER BY changed_at DESC LIMIT 10
      `;
    }
    return res.json(logs);
  }

  // ── GET the song list ───────────────────────────────────────────────────────
  // Without lyrics: each row says has_lyrics, and the text comes with one
  // song's details (GET /songs/:id). ?lyrics=1 adds the text for the CSV export.
  if (req.method === 'GET') {
    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const viewMode = !user;
    if (viewMode && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });
    if (viewMode) {
      const { limit: rawLimit, offset } = parsePage(req);
      const limit = Math.min(rawLimit, 30);
      const rows = await listSongs(sql, band.id, {
        page: { limit, offset },
        activeOnly: req.query.active !== '0',
      });
      const total = Number(rows[0]?.total ?? 0);
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      return res.json({
        rows: rows.map(({ total: _, ...row }) => row),
        total,
        limit,
        offset,
      });
    }
    return res.json(await listSongs(sql, band.id, {
      withArrangement: true,
      withLyrics: req.query.lyrics === '1',
    }));
  }

  // ── POST lyrics-suggest ───────────────────────────────────────────────────
  // Dispatched via body field to avoid multi-segment POST routing issues.
  // Client sends POST /api/:band/songs with { lyrics_suggest_id: songId }.
  if (req.method === 'POST' && req.body?.lyrics_suggest_id != null) {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const songId = bodyId(req.body.lyrics_suggest_id);
    if (!songId) return res.status(400).json({ error: 'Invalid song id' });
    const result = await suggestLyrics(sql, band, songId, clientIp(req));
    return res.status(result.status).json(result.body);
  }

  // ── POST lyrics update (replaces PUT /songs/:id/lyrics) ───────────────────
  if (req.method === 'POST' && req.body?.lyrics_update_id != null) {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const songId = bodyId(req.body.lyrics_update_id);
    if (!songId) return res.status(400).json({ error: 'Invalid song id' });
    if (typeof req.body.lyrics !== 'string')
      return res.status(400).json({ error: 'lyrics must be a string' });
    const lyrics = cleanLyrics(req.body.lyrics);
    if (lyrics.error) return res.status(400).json({ error: lyrics.error });
    const song = await writeLyrics(sql, band.id, songId, lyrics.value);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.json({ ok: true });
  }

  // ── POST lyrics delete (replaces DELETE /songs/:id/lyrics) ────────────────
  if (req.method === 'POST' && req.body?.lyrics_delete_id != null) {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const songId = bodyId(req.body.lyrics_delete_id);
    if (!songId) return res.status(400).json({ error: 'Invalid song id' });
    const song = await writeLyrics(sql, band.id, songId, null, 'lyrics_delete');
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.json({ ok: true });
  }

  // ── POST upload presign / confirm / delete (workaround: multi-segment PUT/DELETE to
  //    /songs/:id/:type fails on Vercel catch-alls in dynamic dirs) ────────────────────────
  if (req.method === 'POST' && (req.body?.media_confirm_id != null
      || req.body?.media_delete_id != null || req.body?.upload_presign_id != null)) {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (refuseDemo(req, res)) return;
    const b = req.body;
    const songId = bodyId(b.media_confirm_id ?? b.media_delete_id ?? b.upload_presign_id);
    if (!songId) return res.status(400).json({ error: 'Invalid song id' });

    let result;
    if (b.upload_presign_id != null) {
      const config = MEDIA_CONFIGS[b.upload_type];
      if (!config) return res.status(400).json({ error: 'upload_type must be audio, sheet, or playback' });
      result = await presignMedia(sql, band, songId, config, b);
    } else {
      const config = MEDIA_CONFIGS[b.media_type];
      if (!config) return res.status(400).json({ error: 'media_type must be audio, sheet, or playback' });
      result = b.media_confirm_id != null
        ? await confirmMedia(sql, band, songId, config, b.publicUrl)
        : await deleteMedia(sql, band, songId, config);
    }
    return res.status(result.status).json(result.body);
  }

  // ── POST create one song ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const _max = songLimit(band);
    const [countRows, knownGenres] = await Promise.all([
      _max != null
        ? sql`SELECT count(*)::int AS count FROM songs WHERE artist_id = ${band.id} AND NOT deleted`
        : null,
      genresOf(sql, band.id),
    ]);
    if (countRows && countRows[0].count >= _max)
      return res.status(402).json({ error: 'song_limit', limit: _max });
    const { title: rawTitle, active, heart, key: rawKey, genre: rawCat, energy: rawEnergy,
            time_signature: rawTimeSig, bpm: rawBpm, length_min: rawLen,
            interpret: rawInterp, reference_interpret: rawRef,
            comment: rawComment } = req.body ?? {};
    // Lyrics and language are columns now; an older client still sends them in extra.
    const moved = splitMovedKeys(req.body?.extra);
    const extra = moved.extra;

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const key = validateStr(rawKey, 20);
    if (key === false) return res.status(400).json({ error: 'key too long' });
    const typedGenre = validateStr(rawCat, 100);
    if (typedGenre === false) return res.status(400).json({ error: 'genre too long' });
    const genre = matchGenre(typedGenre, knownGenres);
    const energy = energyToScale(rawEnergy);
    if (energy === undefined) return res.status(400).json({ error: ENERGY_ERROR });
    const time_signature = validateStr(rawTimeSig, 20);
    if (time_signature === false) return res.status(400).json({ error: 'time_signature too long' });
    const bpm = validateNum(rawBpm);
    if (bpm === false) return res.status(400).json({ error: 'bpm must be a number' });
    const length_min = validateNum(rawLen);
    if (length_min === false) return res.status(400).json({ error: 'length_min must be a number' });
    const interpret = validateStr(rawInterp, 200);
    if (interpret === false) return res.status(400).json({ error: 'interpret too long' });
    const reference_interpret = validateStr(rawRef, 500);
    if (reference_interpret === false) return res.status(400).json({ error: 'reference_interpret too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const language = cleanLanguage(req.body?.language !== undefined ? req.body.language : moved.language);
    if (language === false) return res.status(400).json({ error: 'language too long' });
    const lyrics = cleanLyrics(req.body?.lyrics !== undefined ? req.body.lyrics : moved.lyrics);
    if (lyrics.error) return res.status(400).json({ error: lyrics.error });
    const extraErr = extraError(extra);
    if (extraErr) return res.status(400).json({ error: extraErr });

    // Song, lyrics and audit entry in one statement.
    const [song] = await sql`
      WITH s AS (
        INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                           bpm, length_min, interpret, reference_interpret, comment, language, extra)
        VALUES (${band.id}, ${title}, ${active ?? true}, ${heart ?? false}, ${key},
                ${genre}, ${energy}, ${time_signature}, ${bpm}, ${length_min},
                ${interpret}, ${reference_interpret},
                ${comment}, ${language}, ${extra ?? {}})
        RETURNING *
      ), saved_lyrics AS (
        INSERT INTO song_lyrics (song_id, artist_id, lyrics)
        SELECT id, artist_id, ${lyrics.value}::text FROM s WHERE ${lyrics.value}::text IS NOT NULL
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'create', to_jsonb(s) FROM s
      )
      SELECT s.*, (${lyrics.value}::text IS NOT NULL) AS has_lyrics FROM s
    `;
    return res.status(201).json(song);
  }

  // Batch update: [{ id, title, active, key, genre, energy, length_min,
  //                   interpret, reference_interpret, comment, language, extra }, ...]
  // Lyrics are not written here — they have their own endpoint.
  if (req.method === 'PATCH') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ error: 'Array of updates required' });
    if (updates.length > 100)
      return res.status(400).json({ error: 'Too many updates (max 100)' });

    // Rows that fail validation are reported back: a silently skipped row looks to the
    // user as if saving did nothing at all. Only fields present in the request are
    // written — a partial update (e.g. the favourite toggle) must not clear the rest.
    const TEXT_LIMITS = { title: 200, key: 20, genre: 100, time_signature: 20,
                          interpret: 200, reference_interpret: 500, comment: 2000 };
    const NUM_FIELDS = ['bpm', 'length_min'];

    const ids = updates.map(u => Number(u?.id)).filter(n => Number.isInteger(n) && n > 0);
    const [storedRows, knownGenres] = await Promise.all([
      ids.length
        ? sql`SELECT * FROM songs WHERE artist_id = ${band.id} AND id = ANY(${ids}::int[]) AND deleted = false`
        : [],
      updates.some(u => u && 'genre' in u) ? genresOf(sql, band.id) : [],
    ]);
    const stored = new Map(storedRows.map(row => [row.id, row]));

    const rejected = [];
    const accepted = new Map(); // id → row; a repeated id keeps the last update
    for (const raw of updates) {
      const update = raw && typeof raw === 'object' ? raw : {};
      const songId = Number(update.id);
      if (!Number.isInteger(songId) || songId <= 0) {
        rejected.push({ id: update.id ?? null, error: 'invalid song id' });
        continue;
      }
      const current = stored.get(songId);
      if (!current) { rejected.push({ id: songId, error: 'song not found' }); continue; }

      const moved = splitMovedKeys(update.extra);
      const value = { id: songId };
      let error = null;
      for (const [field, maxLen] of Object.entries(TEXT_LIMITS)) {
        if (!(field in update)) { value[field] = current[field]; continue; }
        const v = validateStr(update[field], maxLen);
        if (v === false) { error = `${field} too long (max ${maxLen})`; break; }
        value[field] = v;
      }
      if (!error && !value.title) error = 'title is required';
      if (!error && 'genre' in update) value.genre = matchGenre(value.genre, knownGenres);
      if (!error && 'energy' in update) {
        value.energy = energyToScale(update.energy);
        if (value.energy === undefined) error = ENERGY_ERROR;
      } else value.energy = current.energy;
      if (!error) {
        for (const field of NUM_FIELDS) {
          if (!(field in update)) { value[field] = current[field]; continue; }
          const v = validateNum(update[field]);
          if (v === false) { error = `${field} must be a number`; break; }
          value[field] = v;
        }
      }
      if (!error) {
        const rawLang = 'language' in update ? update.language : moved.language;
        if (rawLang === undefined) value.language = current.language ?? null;
        else {
          value.language = cleanLanguage(rawLang);
          if (value.language === false) error = 'language too long (max 10)';
        }
      }
      if (!error) error = extraError(moved.extra, current.extra);
      if (error) { rejected.push({ id: songId, error }); continue; }

      value.active = toBool(update.active, current.active);
      value.heart  = toBool(update.heart,  current.heart);
      value.extra  = moved.extra ?? {};
      accepted.set(songId, value);
    }

    // One statement for the whole batch — the rows, merged extra and one
    // audit entry each — instead of two round-trips per song.
    let applied = 0;
    if (accepted.size) {
      const rows = [...accepted.values()];
      const updated = await sql`
        WITH u AS (
          UPDATE songs SET
            title               = v.title,
            active              = v.active,
            heart               = v.heart,
            key                 = v.key,
            genre               = v.genre,
            energy              = v.energy,
            time_signature      = v.time_signature,
            bpm                 = v.bpm,
            length_min          = v.length_min,
            interpret           = v.interpret,
            reference_interpret = v.reference_interpret,
            comment             = v.comment,
            language            = v.language,
            extra               = songs.extra || COALESCE(v.extra, '{}'::jsonb)
          FROM jsonb_to_recordset(${sql.json(rows)}) AS v(
            id int, title text, active boolean, heart boolean, key text, genre text,
            energy numeric, time_signature text, bpm numeric, length_min numeric,
            interpret text, reference_interpret text, comment text, language text, extra jsonb)
          WHERE songs.id = v.id AND songs.artist_id = ${band.id} AND songs.deleted = false
          RETURNING songs.*
        ), logged AS (
          INSERT INTO song_logs (artist_id, song_id, action, song_data)
          SELECT artist_id, id, 'update', to_jsonb(u) FROM u
        )
        SELECT id FROM u
      `;
      const done = new Set(updated.map(r => r.id));
      applied = done.size;
      for (const id of accepted.keys()) if (!done.has(id)) rejected.push({ id, error: 'song not found' });
    }
    return res.json({ ok: true, count: applied, rejected });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
