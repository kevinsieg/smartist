const { getDb, getSlug } = require('../_db');
const { requireAuth, getAccess } = require('../_auth');
const { validateSongIds, validateStr, positiveId, likePattern } = require('../_validate');
const { ownsRefs } = require('../_ownership');
const { wrap } = require('../_handler');
const { gigColumns, gigJoins } = require('../_domain/setlists');
const { MSG } = require('../_domain/http');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    const { artist, user } = await getAccess(req, slug);
    if (!artist) return res.status(404).json({ error: MSG.artistNotFound });
    // The list of setlists is never public — only an individual one, reached
    // from a stage link (see setlists/item.js).
    if (!user) return res.status(401).json({ error: MSG.signIn });

    // ?song_q=<text>: the setlists (and their gigs) that contain a song whose
    // title contains <text>. The gig and history filters asked
    // /songs/:id/setlists once per matching song — one request per song.
    if (req.query.song_q != null) {
      const pattern = likePattern(String(req.query.song_q).trim().slice(0, 100));
      if (!pattern) return res.json([]);
      const rows = await sql`
        SELECT DISTINCT sl.id, sl.gig_id
        FROM setlists sl
        JOIN setlist_songs ss ON ss.setlist_id = sl.id
        JOIN songs s ON s.id = ss.song_id AND s.artist_id = sl.artist_id
        WHERE sl.artist_id = ${artist.id} AND s.deleted = false AND s.title ILIKE ${pattern}
      `;
      return res.json(rows);
    }

    const setlists = await sql`
      SELECT s.*, ${gigColumns(sql)},
        (SELECT count(*)::int FROM setlist_songs ss WHERE ss.setlist_id = s.id) AS song_count
      FROM setlists s
      ${gigJoins(sql)}
      WHERE s.artist_id = ${artist.id}
      ORDER BY s.created_at DESC
    `;
    return res.json(setlists);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const { title: rawTitle, gig_id: rawGigId, comment: rawComment, song_ids } = req.body ?? {};

    if (!Array.isArray(song_ids) || song_ids.length === 0)
      return res.status(400).json({ error: 'song_ids array is required' });
    const validIds = validateSongIds(song_ids);
    if (!validIds) return res.status(400).json({ error: 'Invalid song_ids' });

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long (max 200)' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long (max 2000)' });
    const gigId = positiveId(rawGigId);
    if (gigId === false) return res.status(400).json({ error: 'Invalid gig_id' });
    const owned = await ownsRefs(sql, band.id, { songIds: validIds, gigId });
    if (!owned.songs) return res.status(400).json({ error: 'Invalid song_ids' });
    if (!owned.gig)   return res.status(400).json({ error: 'Invalid gig_id' });

    // Setlist, its songs and the list row the client shows — one statement,
    // so a failure never leaves a setlist without its songs.
    const [created] = await sql`
      WITH s AS (
        INSERT INTO setlists (artist_id, title, gig_id, comment)
        VALUES (${band.id}, ${title}, ${gigId}, ${comment})
        RETURNING *
      ), ins AS (
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT s.id, u.song_id, u.ord - 1
        FROM s, unnest(${validIds}::int[]) WITH ORDINALITY AS u(song_id, ord)
      )
      SELECT s.*, ${gigColumns(sql)}, ${validIds.length}::int AS song_count
      FROM s
      ${gigJoins(sql)}
    `;
    return res.status(201).json(created);
  }

  res.status(405).json({ error: MSG.methodNotAllowed });
});
