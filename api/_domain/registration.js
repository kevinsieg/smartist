const crypto = require('crypto');

// Common disposable/temp-mail providers — accounts behind these are throwaway
// by definition, and sends to them waste quota and hurt sender reputation.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com',
  'grr.la', '10minutemail.com', '10minutemail.net', 'yopmail.com', 'yopmail.fr',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempr.email', 'tempinbox.com',
  'trashmail.com', 'trashmail.de', 'getnada.com', 'dispostable.com', 'maildrop.cc',
  'mintemail.com', 'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com',
  'spamgourmet.com', 'mytemp.email', 'emailondeck.com', 'mohmal.com',
  'discard.email', 'mailcatch.com', 'spam4.me', 'mail.tm', 'dropmail.me',
]);

// Cheap deliverability gate before sending a signup email: rejects disposable
// domains and domains that cannot receive mail (no MX, or the RFC 7505 null MX
// "0 ."). The link click remains the real ownership proof — this only protects
// the sending step. DNS failures fail open: a transient resolver problem must
// never block signups.
async function checkEmailDeliverable(email, resolveMx) {
  const domain = String(email).split('@')[1] || '';
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: 'disposable' };

  const resolve = resolveMx || require('dns').promises.resolveMx;
  let timer;
  try {
    const records = await Promise.race([
      resolve(domain),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), 2500); }),
    ]);
    const usable = (records || []).filter(r => r.exchange && r.exchange !== '.');
    return usable.length ? { ok: true } : { ok: false, reason: 'no_mx' };
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { ok: false, reason: 'no_mx' };
    return { ok: true }; // fail open
  } finally {
    clearTimeout(timer);
  }
}

async function createSignupToken(email, sql) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const hash      = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires   = new Date(Date.now() + 30 * 60 * 1000);
  const tokenMeta = { signup_token_hash: hash, signup_token_expires: expires.toISOString() };
  await sql`
    INSERT INTO subscribers (email, source, meta)
    VALUES (${email}, 'signup', ${tokenMeta})
    ON CONFLICT (email) DO UPDATE
      SET meta = subscribers.meta || ${tokenMeta}
  `;
  return rawToken;
}

async function verifySignupToken(rawToken, sql) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const [row] = await sql`
    SELECT email,
           meta->>'signup_token_hash'    AS signup_token_hash,
           (meta->>'signup_token_expires')::timestamptz AS signup_token_expires
    FROM subscribers
    WHERE meta->>'signup_token_hash' = ${hash}
  `;
  if (!row) return null;
  if (new Date(row.signup_token_expires) < new Date()) return null;
  return { email: row.email };
}

async function createArtistAndAdmin(name, slug, email, sql) {
  return await sql.begin(async tx => {
    const [artist] = await tx`
      INSERT INTO artists (slug, name, config)
      VALUES (${slug}, ${name}, '{}')
      RETURNING id
    `;
    const [user] = await tx`
      INSERT INTO users (artist_id, email, role, password_hash)
      VALUES (${artist.id}, ${email}, 'admin', NULL)
      RETURNING id
    `;
    return { artistId: artist.id, userId: user.id };
  });
}

async function clearSignupToken(email, sql) {
  await sql`
    UPDATE subscribers
    SET meta = (meta - 'signup_token_hash') - 'signup_token_expires'
    WHERE email = ${email}
  `;
}

module.exports = { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken, checkEmailDeliverable };
