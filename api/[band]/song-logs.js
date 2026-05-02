const { getDb, getBand } = require('../_db');
const { wrap } = require('../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug } = req.query;
  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found' });

  const sql = getDb();
  const { songId } = req.query;

  let logs;
  if (songId) {
    const sid = Number(songId);
    if (!Number.isInteger(sid) || sid <= 0)
      return res.status(400).json({ error: 'Invalid songId' });
    logs = await sql`
      SELECT * FROM song_logs
      WHERE band_id = ${band.id} AND song_id = ${sid}
        AND action IN ('audio_replace', 'audio_delete', 'sheet_replace', 'sheet_delete', 'playback_replace', 'playback_delete')
      ORDER BY changed_at DESC
      LIMIT 20
    `;
  } else {
    logs = await sql`
      SELECT * FROM song_logs
      WHERE band_id = ${band.id}
      ORDER BY changed_at DESC
      LIMIT 10
    `;
  }
  res.json(logs);
});
