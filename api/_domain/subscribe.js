const { getArtist, getDb } = require('../_db');
const { validateEmail, validateStr } = require('../_validate');
const { checkRateLimit } = require('../_ratelimit');
const { ok, fail } = require('./http');
const { sendEmail } = require('../_email');
const { generateMagicToken, demoSeed } = require('../_token');
const logger = require('../_logger');

// POST { source: 'contact' } — landing-page contact form.
async function contact({ body, ip }) {
  const name = validateStr(body.name, 200);
  if (!name) return fail(400, 'Name is required');
  const email = validateEmail(body.email);
  if (!email) return fail(400, 'Valid email required');
  const message = validateStr(body.message, 5000);
  if (message === false) return fail(400, 'Message too long');
  if (!message) return fail(400, 'Message is required');

  if (await checkRateLimit(`contact:${ip}`, 3, 3600))
    return fail(429, 'Too many requests — try again later');

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
    return fail(500, 'Failed to send — try again later');
  }
  return ok({ ok: true });
}

// POST (default) — email capture: demo signup issues a demo-workspace token;
// landing just records the subscriber.
async function subscribe({ body, headers, ip }) {
  const email = validateEmail(body.email);
  if (!email) return fail(400, 'Valid email required');

  if (await checkRateLimit(`subscribe:${ip}`, 5, 3600))
    return fail(429, 'Too many requests — try again later');

  const sql = getDb();
  const source = body.source === 'demo' ? 'demo' : 'landing';

  if (source === 'demo') {
    const meta = {
      name:            body.name            || null,
      genres:          body.genres           || null,
      perform_country: body.perform_country  || null,
      geo_country: headers['x-vercel-ip-country'] || null,
      geo_region:  headers['x-vercel-ip-country-region'] || null,
      geo_city:    headers['x-vercel-ip-city'] ? decodeURIComponent(headers['x-vercel-ip-city']) : null,
      ua:      headers['user-agent'] || null,
      ref:     headers['referer'] || null,
    };
    await sql`
      INSERT INTO subscribers (email, source, meta)
      VALUES (${email}, 'demo', ${meta})
      ON CONFLICT (email) DO UPDATE SET source = 'demo', meta = subscribers.meta || ${meta}
    `;
    const demoSlug   = process.env.DEMO_ARTIST_SLUG || 'demo';
    const demoArtist = await getArtist(demoSlug);
    const demoToken  = demoArtist ? generateMagicToken(demoSeed(demoArtist.id), 'demo') : null;
    return ok({ ok: true, token: demoToken, slug: demoArtist?.slug || demoSlug });
  }

  try {
    await sql`INSERT INTO subscribers (email, source) VALUES (${email}, 'landing')`;
  } catch (err) {
    if (err.code === '23505') return fail(409, 'Already subscribed');
    throw err;
  }
  return ok({ ok: true });
}

module.exports = { contact, subscribe };
