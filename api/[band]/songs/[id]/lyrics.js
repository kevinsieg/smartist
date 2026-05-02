const { getDb, insertAuditLog } = require('../../../_db');
const { requireAuth } = require('../../../_auth');
const { wrap } = require('../../../_handler');

module.exports = wrap(async function handler(req, res) {
  const { band: slug, id } = req.query;
  const songId = Number(id);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();

  // ── PUT: save or update lyrics ───────────────────────────────────────────
  if (req.method === 'PUT') {
    const { lyrics } = req.body ?? {};
    if (typeof lyrics !== 'string')
      return res.status(400).json({ error: 'lyrics must be a string' });
    if (lyrics.length > 20000)
      return res.status(400).json({ error: 'Lyrics too long (max 20 000 characters)' });

    const lyricsVal = lyrics.trim() || null;
    const [song] = await sql`
      UPDATE songs SET extra = extra || ${{ lyrics: lyricsVal }}
      WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
      RETURNING id, title
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await insertAuditLog(sql, band.id, song.id, 'lyrics_update', { title: song.title });
    return res.json({ ok: true });
  }

  // ── DELETE: clear lyrics ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const [song] = await sql`
      SELECT id FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await sql`
      UPDATE songs SET extra = extra - 'lyrics'
      WHERE id = ${songId} AND band_id = ${band.id}
    `;
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
});
