const { getArtist, getSlug } = require('../_db');
const { checkCredentials, requireAuth } = require('../_auth');
const { generateMagicToken } = require('../_token');
const { sendEmail } = require('../_email');
const { wrap } = require('../_handler');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const logger = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const slug = getSlug(req);

  // ── request-reset (merged from request-reset.js via vercel.json rewrite) ──
  if (req.url.includes('request-reset')) {
    const { email } = req.body ?? {};
    const adminEmail = process.env.ARTIST_ADMIN_EMAIL;

    if (await checkRateLimit(`reset:${clientIp(req)}`, 3, 600))
      return res.json({ ok: true }); // silent — don't leak rate limiting

    if (!adminEmail || !email || String(email).trim().toLowerCase() !== adminEmail.toLowerCase())
      return res.json({ ok: true }); // silent — don't leak valid emails

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const token = generateMagicToken(band.password_hash);
    const h = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const origin = process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
    const loginUrl = `${origin}/songs?magic=${encodeURIComponent(token)}`;

    try {
      await sendEmail({
        to: adminEmail,
        subject: 'Login link — Song Manager',
        html: `<p>Here is your login link for the Song Manager:</p>
               <p><a href="${loginUrl}">${loginUrl}</a></p>
               <p>Valid for 30 minutes. Do not share this link.</p>`,
      });
    } catch (err) {
      await logger.error('request_reset_failed', { band: slug, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ ok: true });
  }

  // ── Regular auth (password or magic-token) ────────────────────────────────
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (String(password).length > 1000) return res.status(400).json({ error: 'Invalid password' });

  if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
    return res.status(429).json({ error: 'Too many attempts — try again later' });

  const band = await getArtist(slug);
  if (!band) return res.status(404).json({ error: 'Band not found' });
  if (!await checkCredentials(password, band)) return res.status(401).json({ error: 'Invalid password' });
  res.json({ ok: true });
});
