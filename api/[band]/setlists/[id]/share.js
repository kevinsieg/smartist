const { getDb } = require('../../../_db');
const { requireAuth } = require('../../../_auth');
const { buildSetlistPdf, setlistTitle } = require('../../../_pdf');
const { sendEmail } = require('../../../_email');
const { wrap } = require('../../../_handler');
const { validateEmail } = require('../../../_validate');
const logger = require('../../../_logger');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const setlistId = Number(id);
  if (!Number.isInteger(setlistId) || setlistId <= 0)
    return res.status(400).json({ error: 'Invalid setlist id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();

  const [setlist] = await sql`
    SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
    FROM setlists s
    LEFT JOIN gigs g ON s.gig_id = g.id
    WHERE s.id = ${setlistId} AND s.band_id = ${band.id}
  `;
  if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

  const songs = await sql`
    SELECT songs.*, ss.position
    FROM setlist_songs ss
    JOIN songs ON ss.song_id = songs.id
    WHERE ss.setlist_id = ${setlistId}
    ORDER BY ss.position
  `;

  const email = validateEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Valid email required' });

  await logger.info('setlist_share', { setlistId, band: slug, to: email, songCount: songs.length });

  const pdf     = await buildSetlistPdf(setlist, songs, band.name);
  const title   = setlistTitle(setlist);
  const subject = title ? `Setlist — ${title}` : `Setlist #${setlistId}`;

  try {
    await sendEmail({
      to: email,
      subject,
      text: `${subject}\n\n${songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
      attachments: [{ filename: 'setlist.pdf', content: pdf.toString('base64') }],
    });
    await logger.info('setlist_share_sent', { setlistId, to: email });
  } catch (err) {
    await logger.error('setlist_share_failed', { setlistId, to: email, error: err.message });
    return res.status(500).json({ error: 'Failed to send email' });
  }

  res.json({ ok: true });
});
