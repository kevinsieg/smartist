const { getBand } = require('../_db');
const { checkCredentials } = require('../_auth');
const { wrap } = require('../_handler');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const logger = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { band: slug } = req.query;
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (String(password).length > 1000) return res.status(400).json({ error: 'Invalid password' });

  const ip = clientIp(req);
  if (await checkRateLimit(`auth:${ip}`, 10, 60)) {
    await logger.warn('rate_limit_auth', { band: slug, ip });
    return res.status(429).json({ error: 'Too many attempts — try again later' });
  }

  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found' });
  if (!await checkCredentials(password, band)) return res.status(401).json({ error: 'Invalid password' });
  res.json({ ok: true });
});
