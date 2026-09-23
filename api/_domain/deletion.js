// Deleting a person, not a workspace.
//
// getArtistsForUser joins on email, so one person is several users rows tied
// together by their address. Every decision here is made across those rows.
'use strict';

// What deleting this address would do to each of its workspaces.
//   destroy — nobody else is in it; it goes entirely, rows and files
//   leave   — others are in it and someone else can still administer it
//   blocked — others are in it and this is the only admin
async function planDeletion(email, sql) {
  const addr = String(email).toLowerCase();

  const mine = await sql`
    SELECT u.artist_id, a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE u.email = ${addr}
    ORDER BY a.name
  `;
  if (!mine.length) return { destroy: [], leave: [], blocked: [] };

  const artistIds = mine.map(r => r.artist_id);
  const members = await sql`
    SELECT artist_id, email, role FROM users WHERE artist_id = ANY(${artistIds})
  `;

  const out = { destroy: [], leave: [], blocked: [] };
  for (const row of mine) {
    const here   = members.filter(m => m.artist_id === row.artist_id);
    const others = here.filter(m => String(m.email).toLowerCase() !== addr);
    const entry  = { artistId: row.artist_id, slug: row.slug, name: row.name };

    if (others.length === 0)                           out.destroy.push(entry);
    else if (others.some(m => m.role === 'admin'))     out.leave.push(entry);
    else                                               out.blocked.push(entry);
  }
  return out;
}

module.exports = { planDeletion };
