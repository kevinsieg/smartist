const { getArtist, getDb } = require('../_db');
const { validateEmail, validateStr } = require('../_validate');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { sendEmail } = require('../_email');
const { generateMagicToken } = require('../_token');
const logger = require('../_logger');

// POST { source: 'contact' } — landing-page contact form.
async function contact(req, res) {
  const name = validateStr(req.body?.name, 200);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const email = validateEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Valid email required' });
  const message = validateStr(req.body?.message, 5000);
  if (message === false) return res.status(400).json({ error: 'Message too long' });
  if (!message) return res.status(400).json({ error: 'Message is required' });

  if (await checkRateLimit(`contact:${clientIp(req)}`, 3, 3600))
    return res.status(429).json({ error: 'Too many requests — try again later' });

  const to = process.env.CONTACT_EMAIL || 'hi@smartist.studio';
  try {
    await sendEmail({
      to,
      reply_to: email,
      subject: `Contact — ${name}`,
      text: `${message}\n\nFrom: ${name} <${email}>`,
    });
    await logger.info('contact_send', { name, email });
  } catch (err) {
    await logger.error('contact_send_failed', { name, email, error: err.message });
    return res.status(500).json({ error: 'Failed to send — try again later' });
  }
  return res.json({ ok: true });
}

// POST (default) — email capture: demo signup issues a demo-workspace token;
// landing just records the subscriber.
async function subscribe(req, res) {
  const email = validateEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Valid email required' });

  if (await checkRateLimit(`subscribe:${clientIp(req)}`, 5, 3600))
    return res.status(429).json({ error: 'Too many requests — try again later' });

  const sql = getDb();
  const source = req.body?.source === 'demo' ? 'demo' : 'landing';

  if (source === 'demo') {
    const meta = {
      name:            req.body?.name            || null,
      genres:          req.body?.genres           || null,
      perform_country: req.body?.perform_country  || null,
      geo_country: req.headers['x-vercel-ip-country'] || null,
      geo_region:  req.headers['x-vercel-ip-country-region'] || null,
      geo_city:    req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null,
      ua:      req.headers['user-agent'] || null,
      ref:     req.headers['referer'] || null,
    };
    await sql`
      INSERT INTO subscribers (email, source, meta)
      VALUES (${email}, 'demo', ${meta})
      ON CONFLICT (email) DO UPDATE SET source = 'demo', meta = ${meta}
    `;
    const demoSlug   = process.env.DEMO_ARTIST_SLUG || 'demo';
    const demoArtist = await getArtist(demoSlug);
    const demoToken  = demoArtist?.password_hash ? generateMagicToken(demoArtist.password_hash) : null;
    return res.status(200).json({ ok: true, token: demoToken, slug: demoArtist?.slug || demoSlug });
  }

  try {
    await sql`INSERT INTO subscribers (email, source) VALUES (${email}, 'landing')`;
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already subscribed' });
    throw err;
  }
  return res.status(200).json({ ok: true });
}

module.exports = { contact, subscribe };
