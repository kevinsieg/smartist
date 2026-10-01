const { getDb, getSlug, trimSongLogs } = require('../../_db');
const { requireAuth, getAccess, canOpenStage, canBrowseCatalogue } = require('../../_auth');
const { wrap } = require('../../_handler');
const { MEDIA_CONFIGS, makeMediaFn } = require('../../_media');
const { validateStr } = require('../../_validate');
const { energyToScale } = require('../../_song_values');
const { clientIp } = require('../../_ratelimit');
const { suggestLyrics } = require('../../_lyrics');
const { songDetail, cleanLyrics, writeLyrics, publicSong } = require('../../_domain/songs');

// Song sub-resources: media, lyrics, arrangements, GEMA, history.

const MEDIA = {
  audio:    makeMediaFn(MEDIA_CONFIGS.audio),
  sheet:    makeMediaFn(MEDIA_CONFIGS.sheet),
  playback: makeMediaFn(MEDIA_CONFIGS.playback),
};

module.exports = wrap(async function handler(req, res) {
  // /songs/:id/:action/:sub/:arrSub — e.g. [12, 'arrangements', 3, 'activate'], [12, 'lyrics', 'suggest']
  const [rawId, action, sub, arrSub] = req.query.path || [];
  const arrId = Number(sub);
  const slug = getSlug(req);

  const songId = Number(rawId);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  // ── Media (audio, sheet, playback) ────────────────────────────────────────
  if (action in MEDIA) {
    req.query.id = rawId;
    return MEDIA[action](req, res);
  }

  // ── PUT/DELETE /api/:artist/songs/:id/lyrics, POST …/lyrics/suggest ──────
  if (action === 'lyrics') {
    if (sub && sub !== 'suggest') return res.status(404).json({ error: 'Not found' });
    const allowed = sub ? ['POST'] : ['PUT', 'DELETE'];
    if (!allowed.includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const sql = getDb();
    if (sub) {
      // The demo session (no user row) gets the free sources only.
      const result = await suggestLyrics(sql, band, songId, clientIp(req), { allowAI: req.user.id !== null });
      return res.status(result.status).json(result.body);
    }
    let text = null;
    if (req.method === 'PUT') {
      if (typeof req.body?.lyrics !== 'string')
        return res.status(400).json({ error: 'lyrics must be a string' });
      const lyrics = cleanLyrics(req.body.lyrics);
      if (lyrics.error) return res.status(400).json({ error: lyrics.error });
      text = lyrics.value;
    }
    const song = await writeLyrics(sql, band.id, songId, text,
      req.method === 'PUT' ? 'lyrics_update' : 'lyrics_delete');
    if (!song) return res.status(404).json({ error: 'Song not found' });
    await trimSongLogs(sql, band.id);
    return res.json({ ok: true });
  }

  // ── GET /api/:artist/songs/:id/arrangements ───────────────────────────────
  // Public — no auth required; arrangements are read-only display data (used by stage view)
  if (action === 'arrangements' && !arrId && req.method === 'GET') {
    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // Stage reads this for the active chart, and a public catalogue shows it.
    if (!user && !canOpenStage(band) && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });
    const sql = getDb();
    const [[song], arrangements] = await Promise.all([
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`,
      sql`
        SELECT id, name, is_active, hidden_instruments, rows, created_at, updated_at
        FROM song_arrangements
        WHERE song_id = ${songId} AND artist_id = ${band.id}
        ORDER BY created_at ASC
      `,
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.json(arrangements);
  }

  // ── POST /api/:artist/songs/:id/arrangements — create version ─────────────
  if (action === 'arrangements' && !arrId && req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const sql = getDb();
    const { rows = [], hidden_instruments = [], copy_from } = req.body ?? {};
    const [[song], [src]] = await Promise.all([
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`,
      copy_from
        ? sql`SELECT rows, hidden_instruments FROM song_arrangements WHERE id = ${Number(copy_from)} AND song_id = ${songId} AND artist_id = ${band.id}`
        : [],
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    const rawName = req.body?.name;
    const name = rawName === undefined ? 'Default' : (validateStr(rawName, 200) || 'Default');
    let sourceRows = rows;
    let sourceHidden = hidden_instruments;
    if (copy_from) {
      if (!src) return res.status(400).json({ error: 'copy_from arrangement not found' });
      sourceRows = src.rows;
      sourceHidden = src.hidden_instruments;
    }
    const [created] = await sql`
      INSERT INTO song_arrangements (song_id, artist_id, name, rows, hidden_instruments)
      VALUES (${songId}, ${band.id}, ${name}, ${sql.json(sourceRows)}::jsonb, ${sql.json(sourceHidden)}::jsonb)
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  // ── PUT /api/:artist/songs/:id/arrangements/:arrId — update ───────────────
  if (action === 'arrangements' && arrId && !arrSub && req.method === 'PUT') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const { name, rows, hidden_instruments } = req.body ?? {};
    const updates = {};
    if (name !== undefined) {
      const validatedName = validateStr(name, 200);
      if (validatedName === false) return res.status(400).json({ error: 'name too long' });
      if (validatedName) updates.name = validatedName;
    }
    if (rows !== undefined)               updates.rows               = sql.json(rows);
    if (hidden_instruments !== undefined) updates.hidden_instruments = sql.json(hidden_instruments);
    if (!Object.keys(updates).length)     return res.status(400).json({ error: 'Nothing to update' });
    const [updated] = await sql`
      UPDATE song_arrangements
      SET
        name               = COALESCE(${updates.name               ?? null}, name),
        rows               = COALESCE(${updates.rows               ?? null}::jsonb, rows),
        hidden_instruments = COALESCE(${updates.hidden_instruments ?? null}::jsonb, hidden_instruments),
        updated_at         = NOW()
      WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
      RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Arrangement not found' });
    return res.json(updated);
  }

  // ── POST /api/:artist/songs/:id/arrangements/:arrId/activate ─────────────
  // Deactivate the others, then activate this one — two statements in that
  // order, because at most one version per song may be active (unique index).
  // One transaction; the first touches nothing unless the target
  // exists, so an unknown id changes nothing.
  if (action === 'arrangements' && arrId && arrSub === 'activate' && req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const [, [updated]] = await sql.begin(tx => [
      tx`
        UPDATE song_arrangements SET is_active = false
        WHERE song_id = ${songId} AND artist_id = ${band.id} AND is_active AND id <> ${arrId}
          AND EXISTS (SELECT 1 FROM song_arrangements
                      WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id})
      `,
      tx`
        UPDATE song_arrangements SET is_active = true, updated_at = NOW()
        WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
        RETURNING *
      `,
    ]);
    if (!updated) return res.status(404).json({ error: 'Arrangement not found' });
    return res.json(updated);
  }

  // ── DELETE /api/:artist/songs/:id/arrangements/:arrId ─────────────────────
  if (action === 'arrangements' && arrId && !arrSub && req.method === 'DELETE') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const [arr] = await sql`
      DELETE FROM song_arrangements WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
      RETURNING id
    `;
    if (!arr) return res.status(404).json({ error: 'Arrangement not found' });
    return res.status(204).end();
  }

  // ── GET single song (song details, stage view); includes lyrics and arrangements
  if (!action && req.method === 'GET') {
    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // One song by id: what a stage link opens, and what a public catalogue
    // lists. The song list itself is gated separately in songs.js.
    if (!user && !canOpenStage(band) && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });
    const sql = getDb();
    const [song, arrangements] = await Promise.all([
      songDetail(sql, band.id, songId),
      sql`
        SELECT id, name, is_active, updated_at
        FROM song_arrangements
        WHERE song_id = ${songId} AND artist_id = ${band.id}
        ORDER BY created_at ASC
      `,
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    // A visitor without a session never sees the band's private notes.
    return res.json({ ...(user ? song : publicSong(song)), arrangements });
  }

  // ── DELETE song ───────────────────────────────────────────────────────────
  // Soft delete: the row, its lyrics and its arrangements stay, so a restore
  // brings all of it back. Flag and audit entry in one statement.
  if (!action) {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    const sql = getDb();
    const [song] = await sql`
      WITH s AS (
        UPDATE songs SET deleted = true
        WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'delete', to_jsonb(s) FROM s
      )
      SELECT id FROM s
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.status(204).end();
  }

  // ── POST restore ──────────────────────────────────────────────────────────
  if (action === 'restore') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    const sql = getDb();
    // The common case — the row is still there, flagged — is one statement:
    // clear the flag and log it, if a delete record exists.
    const [restored] = await sql`
      WITH s AS (
        UPDATE songs SET deleted = false
        WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = true
          AND EXISTS (SELECT 1 FROM song_logs
                      WHERE song_id = ${songId} AND artist_id = ${band.id} AND action = 'delete')
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'create', to_jsonb(s) FROM s
      )
      SELECT * FROM s
    `;
    if (restored) return res.status(201).json(restored);

    // The row is gone (hard-deleted before soft delete existed): rebuild it
    // from the last delete snapshot — unless the song is live, when there is
    // nothing to restore.
    const [[log], [live]] = await Promise.all([
      sql`
        SELECT song_data FROM song_logs
        WHERE song_id = ${songId} AND artist_id = ${band.id} AND action = 'delete'
        ORDER BY changed_at DESC
        LIMIT 1
      `,
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id}`,
    ]);
    if (!log) return res.status(404).json({ error: 'No delete record found for this song' });
    if (live) return res.status(409).json({ error: 'Song is not deleted' });
    const d = log.song_data;
    const [song] = await sql`
      WITH s AS (
        INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                           bpm, length_min, interpret, reference_interpret, comment, language, extra)
        VALUES (${band.id}, ${d.title}, ${d.active ?? true}, ${d.heart ?? false}, ${d.key ?? null},
                ${d.genre ?? null}, ${energyToScale(d.energy ?? d.tempo) ?? null}, ${d.time_signature ?? null},
                ${d.bpm ?? null}, ${d.length_min ?? null},
                ${d.interpret ?? null}, ${d.reference_interpret ?? null},
                ${d.comment ?? null}, ${d.language ?? d.extra?.language ?? null},
                ${(({ lyrics: _l, language: _g, ...rest }) => rest)(d.extra ?? {})})
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'create', to_jsonb(s) FROM s
      )
      SELECT * FROM s
    `;
    return res.status(201).json(song);
  }

  // ── GET setlist appearances ───────────────────────────────────────────────
  if (action === 'setlists') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // Which setlists a song appears in — gig history for that song.
    if (!user && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });

    const sql = getDb();
    const setlists = await sql`
      SELECT sl.id, sl.title, sl.comment, sl.created_at,
             g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      LEFT JOIN gigs g ON sl.gig_id = g.id AND g.artist_id = sl.artist_id
      LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
      WHERE ss.song_id = ${songId} AND sl.artist_id = ${band.id}
      ORDER BY sl.created_at DESC
    `;
    return res.json(setlists);
  }

  // ── GET GEMA data ─────────────────────────────────────────────────────────
  if (action === 'gema') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // GEMA registration data is rights administration, never public.
    if (!user)
      return res.status(401).json({ error: 'Sign in to view this' });

    const sql = getDb();
    const [works, rightholders] = await Promise.all([
      sql`
        SELECT * FROM gema_works
        WHERE artist_id = ${band.id} AND song_id = ${songId}
        ORDER BY gema_work_number
      `,
      sql`
        SELECT r.*, g.gema_work_number
        FROM gema_rightholders r
        JOIN gema_works g ON g.id = r.gema_work_id
        WHERE g.artist_id = ${band.id} AND g.song_id = ${songId}
        ORDER BY g.gema_work_number, r.role, r.role_order NULLS LAST, r.name
      `,
    ]);
    return res.json({ works, rightholders });
  }

  return res.status(404).json({ error: 'Not found' });
});
