const crypto = require('crypto');

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

module.exports = { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken };
