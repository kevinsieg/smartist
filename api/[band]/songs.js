const { getDb, getBand, insertAuditLog } = require('../_db');
const { requireAuth } = require('../_auth');
const { validateStr, validateNum } = require('../_validate');
const { wrap } = require('../_handler');

module.exports = wrap(async function handler(req, res) {
  const { band: slug } = req.query;
  const sql = getDb();

  if (req.method === 'GET') {
    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const songs = await sql`
      SELECT s.*,
        COUNT(DISTINCT ss.setlist_id)::int AS play_count,
        MAX(sl.created_at)                 AS last_played_at,
        g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN setlist_songs ss ON ss.song_id = s.id
      LEFT JOIN setlists sl      ON sl.id = ss.setlist_id
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works
        WHERE song_id = s.id
        ORDER BY gema_work_number
        LIMIT 1
      ) g ON true
      WHERE s.band_id = ${band.id} AND s.deleted = false
      GROUP BY s.id, g.iswc, g.gema_work_number, g.language
      ORDER BY s.title
    `;
    return res.json(songs);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { title: rawTitle, active, key: rawKey, genre: rawCat, tempo: rawTempo,
            length_min: rawLen, interpret: rawInterp, reference_interpret: rawRef,
            comment: rawComment, extra } = req.body ?? {};

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const key = validateStr(rawKey, 20);
    if (key === false) return res.status(400).json({ error: 'key too long' });
    const genre = validateStr(rawCat, 100);
    if (genre === false) return res.status(400).json({ error: 'genre too long' });
    const tempo = validateNum(rawTempo);
    if (tempo === false) return res.status(400).json({ error: 'tempo must be a number' });
    const length_min = validateNum(rawLen);
    if (length_min === false) return res.status(400).json({ error: 'length_min must be a number' });
    const interpret = validateStr(rawInterp, 200);
    if (interpret === false) return res.status(400).json({ error: 'interpret too long' });
    const reference_interpret = validateStr(rawRef, 500);
    if (reference_interpret === false) return res.status(400).json({ error: 'reference_interpret too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });

    const [song] = await sql`
      INSERT INTO songs (band_id, title, active, key, genre, tempo, length_min,
                         interpret, reference_interpret, comment, extra)
      VALUES (${band.id}, ${title}, ${active ?? true}, ${key},
              ${genre}, ${tempo}, ${length_min},
              ${interpret}, ${reference_interpret},
              ${comment}, ${extra ?? {}})
      RETURNING *
    `;
    await insertAuditLog(sql, band.id, song.id, 'create', song);
    return res.status(201).json(song);
  }

  // Batch update: [{ id, title, active, key, genre, tempo, length_min,
  //                   interpret, reference_interpret, comment, extra }, ...]
  if (req.method === 'PATCH') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ error: 'Array of updates required' });
    if (updates.length > 100)
      return res.status(400).json({ error: 'Too many updates (max 100)' });

    let applied = 0;
    for (const update of updates) {
      const songId = Number(update.id);
      if (!Number.isInteger(songId) || songId <= 0) continue;

      const title = validateStr(update.title, 200);
      if (!title) continue;
      const key = validateStr(update.key, 20);
      if (key === false) continue;
      const genre = validateStr(update.genre, 100);
      if (genre === false) continue;
      const tempo = validateNum(update.tempo);
      if (tempo === false) continue;
      const length_min = validateNum(update.length_min);
      if (length_min === false) continue;
      const interpret = validateStr(update.interpret, 200);
      if (interpret === false) continue;
      const reference_interpret = validateStr(update.reference_interpret, 500);
      if (reference_interpret === false) continue;
      const comment = validateStr(update.comment, 2000);
      if (comment === false) continue;

      const [updated] = await sql`
        UPDATE songs SET
          title               = ${title},
          active              = ${update.active ?? true},
          key                 = ${key},
          genre            = ${genre},
          tempo               = ${tempo},
          length_min          = ${length_min},
          interpret           = ${interpret},
          reference_interpret = ${reference_interpret},
          comment             = ${comment},
          extra               = songs.extra || ${update.extra ?? {}}
        WHERE id = ${songId} AND band_id = ${band.id}
        RETURNING *
      `;
      if (updated) { await insertAuditLog(sql, band.id, updated.id, 'update', updated); applied++; }
    }
    return res.json({ ok: true, count: applied });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
