'use strict';
const crypto = require('crypto');
const { getDb } = require('../_db');
const { verifyUserToken } = require('../_token');
const { checkRateLimit } = require('../_ratelimit');
const { deleteFromR2 } = require('../_r2');
const { sendEmail } = require('../_email');
const logger = require('../_logger');
const { origin } = require('./http');
const { planDeletion, executeDeletion } = require('./deletion');

const TOKEN_TTL_MS = 30 * 60 * 1000;

// Slug-independent: deletion spans every workspace, so there is no slug to
// authenticate against. Same shape as myArtists in api/config.js.
async function _sessionEmail(req, sql) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claim  = verifyUserToken(bearer);
  if (!claim) return null;
  const [row] = await sql`SELECT email FROM users WHERE id = ${claim.userId} LIMIT 1`;
  return row ? String(row.email).toLowerCase() : null;
}

// GET ?action=deletion-preflight — what would happen, in the person's own words.
async function preflight(req, res) {
  const sql   = getDb();
  const email = await _sessionEmail(req, sql);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const plan = await planDeletion(email, sql);
  return res.json({
    email,
    destroy: plan.destroy.map(a => ({ slug: a.slug, name: a.name })),
    leave:   plan.leave.map(a => ({ slug: a.slug, name: a.name })),
    blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })),
  });
}

// POST ?action=request-deletion — store a hash, email the link.
async function requestDeletion(req, res) {
  const sql   = getDb();
  const email = await _sessionEmail(req, sql);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  // Keyed on the address, not the IP (same convention as oauth.js's
  // signup-link:${email}) — a shared IP (CGNAT, an office NAT) must not cap
  // everyone behind it together, and there is no enumeration risk here since
  // this handler requires a session and only ever mails its own address.
  if (await checkRateLimit(`delete-req:${email}`, 3, 3600))
    return res.status(429).json({ error: 'Too many requests — try again later' });

  const plan = await planDeletion(email, sql);
  if (plan.blocked.length)
    return res.status(409).json({ blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })) });
  if (!plan.destroy.length && !plan.leave.length)
    return res.status(404).json({ error: 'No account found' });

  const raw     = crypto.randomBytes(32).toString('hex');
  const hash    = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  // lower(email): stored addresses are not normalised (OAuth signup inserts
  // the provider's raw casing — see api/_domain/deletion.js's own comment on
  // this), and email here is already lowercased by _sessionEmail. A bare
  // `email = ${email}` would silently match zero rows for a mixed-case
  // stored address, and this UPDATE is the one place that failing silently
  // is worst: nothing would be stored, yet the code below would still mail a
  // link that can never work. RETURNING + the length check below is the
  // belt to lower()'s braces, so that can never happen again either way.
  const updated = await sql`
    UPDATE users SET delete_token_hash = ${hash}, delete_token_expires = ${expires}
    WHERE lower(email) = ${email}
    RETURNING id
  `;
  if (!updated.length) {
    await logger.error('account_delete_token_store_failed', { email });
    return res.status(500).json({ error: 'Failed to start deletion — try again later' });
  }

  const link = `${origin(req)}/profile#delete-token=${raw}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Confirm deleting your smartist account',
      html:
        `<p>Click to delete your smartist account. This cannot be undone.</p>` +
        `<p><a href="${link}">Delete my account</a> — valid for 30 minutes.</p>` +
        `<p>If you did not ask for this, ignore this email and nothing happens.</p>`,
    });
  } catch (err) {
    await logger.error('account_delete_email_failed', { email, error: err.message });
    return res.status(500).json({ error: 'Failed to send email — try again later' });
  }
  await logger.info('account_delete_requested', { email });
  return res.json({ ok: true });
}

// POST ?action=confirm-deletion — the link. Authenticated by the token alone,
// because it may well be opened in a different browser from the one that asked.
async function confirmDeletion(req, res) {
  const raw = req.body?.token || req.query?.token;
  if (!raw) return res.status(400).json({ error: 'Invalid or expired link' });

  const sql  = getDb();
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const [row] = await sql`
    SELECT email FROM users
    WHERE delete_token_hash = ${hash} AND delete_token_expires > now()
    LIMIT 1
  `;
  if (!row) return res.status(400).json({ error: 'Invalid or expired link' });

  const out = await executeDeletion(String(row.email).toLowerCase(), sql, { deleteFromR2, logger });
  if (!out.ok) return res.status(409).json({ blocked: out.blocked });
  // The row existed a moment ago (the SELECT above found it), so found:false
  // here means something else removed it between that SELECT and this call —
  // a second confirm on the same link, an admin removing this member via
  // DELETE /api/:artist/auth, scripts/delete_artist.js, anything. Whatever it
  // was, treat it the same as a used/expired link rather than reporting a
  // fresh success for a deletion this request did not perform.
  if (!out.found) return res.status(400).json({ error: 'Invalid or expired link' });
  return res.json({ ok: true, destroyed: out.destroyed, left: out.left });
}

module.exports = { preflight, requestDeletion, confirmDeletion };
