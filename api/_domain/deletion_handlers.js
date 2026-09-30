'use strict';
const crypto = require('crypto');
const { getDb } = require('../_db');
const { verifyUserToken, passwordMatches } = require('../_token');
const { checkRateLimit } = require('../_ratelimit');
const { deleteFromR2 } = require('../_r2');
const { sendEmail } = require('../_email');
const logger = require('../_logger');
const { reply, ok, fail } = require('./http');
const { planDeletion, executeDeletion } = require('./deletion');

const TOKEN_TTL_MS = 30 * 60 * 1000;

// Slug-independent: deletion spans every workspace, so there is no slug to
// authenticate against. Same shape as myArtists in api/_config.js.
async function _sessionEmail(headers, sql) {
  const bearer = (headers.authorization || '').replace(/^Bearer /, '');
  const claim  = verifyUserToken(bearer);
  if (!claim) return null;
  const [row] = await sql`SELECT email, password_hash FROM users WHERE id = ${claim.userId} LIMIT 1`;
  return row && passwordMatches(claim, row) ? String(row.email).toLowerCase() : null;
}

// GET ?action=deletion-preflight — what would happen, in the person's own words.
async function preflight({ headers }) {
  const sql   = getDb();
  const email = await _sessionEmail(headers, sql);
  if (!email) return fail(401, 'Unauthorized');
  const plan = await planDeletion(email, sql);
  return ok({
    email,
    destroy: plan.destroy.map(a => ({ slug: a.slug, name: a.name })),
    leave:   plan.leave.map(a => ({ slug: a.slug, name: a.name })),
    blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })),
  });
}

// POST ?action=request-deletion — store a hash, email the link.
async function requestDeletion({ headers, origin }) {
  const sql   = getDb();
  const email = await _sessionEmail(headers, sql);
  if (!email) return fail(401, 'Unauthorized');

  // Checked before the rate limit: a blocked account cannot send anything, so
  // counting its attempts would burn all 3/hour without a single email leaving
  // — someone who promotes a co-admin and tries again is then locked out of
  // their own deletion for an hour by requests that never sent a link.
  const plan = await planDeletion(email, sql);
  if (plan.blocked.length)
    return reply(409, {
      // The client shows data.error; without it a 409 renders the generic
      // "failed" line before the reloaded danger zone explains the blocker.
      error: 'You are the only admin of a workspace that still has members',
      blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })),
    });
  if (!plan.destroy.length && !plan.leave.length)
    return fail(404, 'No account found');

  // Keyed on the address, not the IP (same convention as oauth.js's
  // signup-link:${email}) — a shared IP (CGNAT, an office NAT) must not cap
  // everyone behind it together, and there is no enumeration risk here since
  // this handler requires a session and only ever mails its own address.
  if (await checkRateLimit(`delete-req:${email}`, 3, 3600))
    return fail(429, 'Too many requests — try again later');

  const raw     = crypto.randomBytes(32).toString('hex');
  const hash    = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  // Addresses are stored lowercase (the users_email_lowercase CHECK) and
  // _sessionEmail lowercases, so this is an exact match. If it ever matched
  // nothing, the check below refuses to mail a link that could never work.
  const updated = await sql`
    UPDATE users SET delete_token_hash = ${hash}, delete_token_expires = ${expires}
    WHERE email = ${email}
    RETURNING id
  `;
  if (!updated.length) {
    await logger.error('account_delete_token_store_failed', { email });
    return fail(500, 'Failed to start deletion — try again later');
  }

  const link = `${origin}/profile#delete-token=${raw}`;
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
    return fail(500, 'Failed to send email — try again later');
  }
  await logger.info('account_delete_requested', { email });
  return ok({ ok: true });
}

// POST ?action=confirm-deletion — the link. Authenticated by the token alone,
// because it may well be opened in a different browser from the one that asked.
//
// Two-phase, exactly like auth.js's confirm-email-change: without `confirm:true`
// this only previews what the link would destroy. Opening a URL is not a
// gesture — a history revisit, a restored tab, the Back button after a 409, or
// a mail scanner that runs JS all re-issue whatever the page fires on load, and
// for this endpoint that would be an irreversible deletion nobody clicked.
async function confirmDeletion({ body, ip }) {
  // Body only: a token in the query string ends up in request logs.
  const raw = body.token;
  if (!raw) return fail(400, 'Invalid or expired link');

  // Same shape as emailchg-confirm (auth.js): the link carries no session, so
  // the IP is all there is to key on, and both phases go through here.
  if (await checkRateLimit(`delete-confirm:${ip}`, 10, 600))
    return fail(429, 'Too many attempts — try again later');

  const sql  = getDb();
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const [row] = await sql`
    SELECT email FROM users
    WHERE delete_token_hash = ${hash} AND delete_token_expires > now()
    LIMIT 1
  `;
  if (!row) return fail(400, 'Invalid or expired link');

  const addr = String(row.email).toLowerCase();

  // Preview. Nothing is written and the token is not consumed, so the page can
  // be reloaded as often as it likes before anyone commits to anything.
  if (body.confirm !== true) {
    const plan = await planDeletion(addr, sql);
    if (plan.blocked.length)
      return reply(409, {
        error: 'You are the only admin of a workspace that still has members',
        blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })),
      });
    return ok({
      preview: true,
      email:   addr,
      destroy: plan.destroy.map(a => ({ slug: a.slug, name: a.name })),
      leave:   plan.leave.map(a => ({ slug: a.slug, name: a.name })),
    });
  }

  const out = await executeDeletion(addr, sql, { deleteFromR2, logger });
  if (!out.ok) return reply(409, {
    error: 'You are the only admin of a workspace that still has members',
    blocked: out.blocked,
  });
  // The row existed a moment ago (the SELECT above found it), so found:false
  // here means something else removed it between that SELECT and this call —
  // a second confirm on the same link, an admin removing this member via
  // DELETE /api/:artist/auth, scripts/delete_artist.js, anything. Whatever it
  // was, treat it the same as a used/expired link rather than reporting a
  // fresh success for a deletion this request did not perform.
  if (!out.found) return fail(400, 'Invalid or expired link');
  return ok({ ok: true, destroyed: out.destroyed, left: out.left });
}

module.exports = { preflight, requestDeletion, confirmDeletion };
