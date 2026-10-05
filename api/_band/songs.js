const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, canBrowseCatalogue } = require('../_auth');
const { validateStr, validateNum, jsonBytes } = require('../_validate');
const { wrap } = require('../_handler');
const { checkRateLimit } = require('../_ratelimit');
const { MEDIA_LOG_ACTIONS } = require('../_constants');
const { keyFromUrl } = require('../_r2');
const { songLimit } = require('../_plans');
const { energyToScale, matchGenre, cleanTags } = require('../_song_values');
const {
  listSongs, cleanLyrics, cleanLanguage, COLUMN_KEYS, publicSong, trimHistory,
} = require('../_domain/songs');
const { songImport, SONG_LIMIT_LOCK } = require('../_domain/song_import');
const { MSG } = require('../_domain/http');

const ENERGY_ERROR = 'energy must be a number from 0 to 10';

// What a new song is checked against: the band's genres (spelling) and tags
// (casing), read in the statement that takes the band's song-limit lock
// (SONG_LIMIT_LOCK, api/_domain/song_import.js). The limit itself is counted
// by the insert, a statement later, so it sees every song a previous holder
// of the lock committed.
async function lockAndSongValues(tx, artistId) {
  const [row] = await tx`
    SELECT
      pg_advisory_xact_lock(${SONG_LIMIT_LOCK}::int, ${artistId}::int) AS locked,
      ARRAY(SELECT DISTINCT genre FROM songs
            WHERE artist_id = ${artistId} AND NOT deleted AND genre IS NOT NULL AND genre <> '') AS genres,
      ARRAY(SELECT DISTINCT unnest(tags) FROM songs
            WHERE artist_id = ${artistId} AND NOT deleted) AS tags`;
  return { genres: row?.genres ?? [], tags: row?.tags ?? [] };
}

// `extra` is free-form, but its *Url keys end up in href/src attributes on the
// songs and stage pages, so they must be plain http(s) links. A link into our
// own bucket may only be the one the upload flow already stored on this song:
// otherwise a band could point its song at another band's file and have it
// deleted by the next media replace, media delete or account deletion.
const EXTRA_MAX_BYTES = 32 * 1024;
// The cap is on what is stored after the merge (`extra || patch`): each request
// alone fitting let repeated requests with new keys grow the row without end,
// and extra ships with every song list.
function extraError(extra, current = {}) {
  if (extra == null) return null;
  if (typeof extra !== 'object' || Array.isArray(extra)) return 'extra must be an object';
  const column = COLUMN_KEYS.find(k => k in extra);
  if (column) return `${column} is a field of its own, not part of extra`;
  if (jsonBytes({ ...(current || {}), ...extra }) > EXTRA_MAX_BYTES) return 'extra is too large';
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

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  // ── GET /api/:artist/song-logs ─────────────────────────────────────────────
  if (req.query.action === 'logs') {
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
    if (!band) return res.status(404).json({ error: MSG.artistNotFound });
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
        rows: rows.map(({ total: _, ...row }) => publicSong(row)),
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

  // ── POST /songs/import: check a CSV file or edited rows, or import them ──
  if (req.query.action === 'import') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    // The preview re-checks after each edit; a burst of edits stays well under this.
    if (await checkRateLimit(`song-import:${band.id}`, 200, 600))
      return res.status(429).json({ error: 'Too many requests — try again in a few minutes' });
    const result = await songImport(sql, band.id, req.body ?? {}, { maxSongs: songLimit(band) });
    return res.status(result.status).json(result.body);
  }

  // ── POST create one song ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const _max = songLimit(band);
    const { title: rawTitle, active, heart, key: rawKey, genre: rawCat, energy: rawEnergy,
            time_signature: rawTimeSig, bpm: rawBpm, length_min: rawLen,
            interpret: rawInterp, reference_interpret: rawRef,
            comment: rawComment } = req.body ?? {};
    const extra = req.body?.extra;

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const key = validateStr(rawKey, 20);
    if (key === false) return res.status(400).json({ error: 'key too long' });
    const typedGenre = validateStr(rawCat, 100);
    if (typedGenre === false) return res.status(400).json({ error: 'genre too long' });
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
    const language = cleanLanguage(req.body?.language);
    if (language === false) return res.status(400).json({ error: 'language too long' });
    // The spelling of known tags comes later, under the lock; checked here.
    const typedTags = cleanTags(req.body?.tags, []);
    if (typedTags && 'error' in typedTags) return res.status(400).json({ error: typedTags.error });
    const lyrics = cleanLyrics(req.body?.lyrics);
    if (lyrics.error) return res.status(400).json({ error: lyrics.error });
    const extraErr = extraError(extra);
    if (extraErr) return res.status(400).json({ error: extraErr });

    // BEGIN, the lock with the band's genres and tags, the insert, COMMIT:
    // with auth, five statements. Song, lyrics and audit entry are one
    // statement, which adds nothing once the band is at its limit.
    const insertSong = (q, genre, tags) => q`
      WITH s AS (
        INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                           bpm, length_min, interpret, reference_interpret, comment, language, extra, tags)
        SELECT ${band.id}, ${title}, ${toBool(active, true)}, ${toBool(heart, false)}, ${key},
               ${genre}, ${energy}, ${time_signature}, ${bpm}, ${length_min},
               ${interpret}, ${reference_interpret},
               ${comment}, ${language}, ${extra ?? {}},
               ARRAY(SELECT jsonb_array_elements_text(${sql.json(tags ?? [])}))
        WHERE ${_max}::int IS NULL
           OR (SELECT count(*) FROM songs WHERE artist_id = ${band.id} AND NOT deleted) < ${_max}::int
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
    const song = await sql.begin(async tx => {
      const known = await lockAndSongValues(tx, band.id);
      const tags = typedTags && cleanTags(typedTags, known.tags);
      return (await insertSong(tx, matchGenre(typedGenre, known.genres), tags))[0] ?? null;
    });
    if (!song) return res.status(402).json({ error: 'Song limit reached', code: 'song_limit', limit: _max });
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
    // The stored rows, with the band's genres and tags on each (one statement;
    // the two lists are uncorrelated subqueries, computed once).
    const storedRows = ids.length ? await sql`
      SELECT s.*,
        ARRAY(SELECT DISTINCT genre FROM songs
              WHERE artist_id = ${band.id} AND NOT deleted AND genre IS NOT NULL AND genre <> '') AS known_genres,
        ARRAY(SELECT DISTINCT unnest(tags) FROM songs
              WHERE artist_id = ${band.id} AND NOT deleted) AS known_tags
      FROM songs s
      WHERE s.artist_id = ${band.id} AND s.id = ANY(${ids}::int[]) AND s.deleted = false
    ` : [];
    const knownGenres = storedRows[0]?.known_genres ?? [];
    const knownTags = storedRows[0]?.known_tags ?? [];
    const stored = new Map(storedRows.map(({ known_genres: _g, known_tags: _t, ...row }) => [row.id, row]));

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
        const rawLang = 'language' in update ? update.language : undefined;
        if (rawLang === undefined) value.language = current.language ?? null;
        else {
          value.language = cleanLanguage(rawLang);
          if (value.language === false) error = 'language too long (max 10)';
        }
      }
      if (!error) {
        const tags = cleanTags(update.tags, knownTags);
        if (tags && 'error' in tags) error = tags.error;
        else value.tags = tags ?? current.tags ?? [];
      }
      if (!error) error = extraError(update.extra, current.extra);
      if (error) { rejected.push({ id: songId, error }); continue; }

      value.active = toBool(update.active, current.active);
      value.heart  = toBool(update.heart,  current.heart);
      value.extra  = update.extra ?? {};
      accepted.set(songId, value);
    }

    // One statement for the whole batch — the rows, merged extra, one audit
    // entry each and the history trim — instead of two round-trips per song.
    let applied = 0;
    /** @type {any[]} */
    let saved = [];
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
            tags                = v.tags,
            extra               = songs.extra || COALESCE(v.extra, '{}'::jsonb)
          FROM jsonb_to_recordset(${sql.json(rows)}) AS v(
            id int, title text, active boolean, heart boolean, key text, genre text,
            energy numeric, time_signature text, bpm numeric, length_min numeric,
            interpret text, reference_interpret text, comment text, language text, extra jsonb, tags text[])
          WHERE songs.id = v.id AND songs.artist_id = ${band.id} AND songs.deleted = false
          RETURNING songs.*
        ), logged AS (
          INSERT INTO song_logs (artist_id, song_id, action, song_data)
          SELECT artist_id, id, 'update', to_jsonb(u) FROM u
        ), trimmed AS (
          -- This band's history of the songs written here, newest SONG_LOG_KEEP
          -- kept. The entry added above is not visible yet: it rides along.
          ${trimHistory(sql, band.id, sql`SELECT id FROM u`)}
        )
        SELECT u.* FROM u
      `;
      saved = [...updated];
      const done = new Set(saved.map(r => r.id));
      applied = done.size;
      for (const id of accepted.keys()) if (!done.has(id)) rejected.push({ id, error: 'song not found' });
    }
    // The rows as stored, so the page updates them in place instead of
    // downloading the whole list again.
    return res.json({ ok: true, count: applied, rejected, rows: saved });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
