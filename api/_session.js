'use strict';

const { verifyUserToken, sessionValid } = require('./_token');
const { sessionRowId } = require('./_auth');

// "Who is this session?" for the routes that are about a person, not a band
// (workspace list, super-admin, account deletion, logout everywhere, a second
// workspace). Band routes use requireAuth / getAccess in api/_auth.js instead,
// which resolve the session and the membership in one statement.

// The bearer token of a request's headers (lower-cased, as Node gives them),
// or '' when there is none.
function bearerToken(headers) {
  const header = headers?.authorization ?? '';
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}

// The users row a signed-in session stands for, in one statement, or null when
// the request carries no valid session: no token, a bad signature, an expired
// one, a user since deleted, or a session revoked (password changed, "log out
// everywhere"). `columns` is a fragment of what to read from that row, aliased
// `me` (default: its email); the password fingerprint and revocation time the
// check needs are read along and not returned.
async function sessionAccount(sql, headers, columns = null) {
  const claim = verifyUserToken(bearerToken(headers));
  if (!claim) return null;
  const [row] = await sql`
    SELECT me.password_hash, me.sessions_valid_after, ${columns || sql`me.email`}
    FROM users me WHERE me.id = ${sessionRowId(sql, claim)} LIMIT 1`;
  if (!row || !sessionValid(claim, row)) return null;
  const { password_hash: _h, sessions_valid_after: _v, ...account } = row;
  return account;
}

module.exports = { bearerToken, sessionAccount };
