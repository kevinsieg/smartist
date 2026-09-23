// Deleting a person, not a workspace.
//
// getArtistsForUser joins on email, so one person is several users rows tied
// together by their address. Every decision here is made across those rows.
'use strict';

// What deleting this address would do to each of its workspaces.
//   destroy — nobody else is in it; it goes entirely, rows and files
//   leave   — others are in it and someone else can still administer it
//   blocked — others are in it and this is the only admin
//
// Matched case-insensitively: what's stored is whatever a provider or the
// signup form sent (oauth.js, registration.js insert the raw address), so a
// literal `=` here would silently find nothing for `Jane@EXAMPLE.com`.
async function planDeletion(email, sql) {
  const addr = String(email).toLowerCase();

  const mine = await sql`
    SELECT u.artist_id, a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE lower(u.email) = ${addr}
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

// Every R2 object belonging to these artists, gathered BEFORE any row is
// deleted — once the rows are gone there is nothing left to enumerate from.
//
// Never do this by key prefix. _media.js writes song media as
// `audio/<uuid>-<name>`, `sheets/…`, `playback/…` — one flat namespace shared
// by every tenant — so a prefix delete would take every band's recordings.
// Only gigs/<slug>/ and bands/<slug>/ carry a slug, and even those are not
// worth the inconsistency.
async function collectR2Urls(artistIds, sql) {
  if (!artistIds.length) return [];

  // deleted songs included on purpose: soft-deleted rows still own their files.
  const songs = await sql`
    SELECT extra FROM songs WHERE artist_id = ANY(${artistIds})
  `;
  const gigs = await sql`
    SELECT poster_url, thumb_url FROM gigs WHERE artist_id = ANY(${artistIds})
  `;
  const bands = await sql`
    SELECT config FROM artists WHERE id = ANY(${artistIds})
  `;

  const urls = new Set();
  const add  = (u) => { if (u && typeof u === 'string') urls.add(u); };

  for (const s of songs) {
    const e = s.extra || {};
    add(e.listenUrl); add(e.sheetUrl); add(e.playbackUrl);
  }
  for (const g of gigs) { add(g.poster_url); add(g.thumb_url); }
  // config.js uploads two band images (photo → logoUrl, favicon → faviconUrl);
  // faviconUrl's key is slug-derived, not a UUID, so it's the one guessable
  // R2 object this account owns — leaving it behind would still be reachable.
  for (const b of bands) { add((b.config || {}).logoUrl); add((b.config || {}).faviconUrl); }

  return [...urls];
}

// Delete the account. Refuses entirely if any workspace is blocked — a
// half-deleted account is a state nobody can reason about afterwards.
//
// deleteFromR2 and logger are injected so the tests can watch them; production
// passes the real ones from api/_r2 and api/_logger.
async function executeDeletion(email, sql, { deleteFromR2, logger }) {
  const addr = String(email).toLowerCase();
  const plan = await planDeletion(addr, sql);

  // No workspace at all — the address doesn't match anything. Callers (the
  // HTTP handler) need to tell this apart from an actual deletion, and
  // nothing should be written or logged as deleted for an address that
  // was never here.
  if (!plan.destroy.length && !plan.leave.length && !plan.blocked.length) {
    return { ok: true, found: false, destroyed: [], left: [] };
  }

  if (plan.blocked.length) {
    return { ok: false, found: true, blocked: plan.blocked.map(b => ({ slug: b.slug, name: b.name })) };
  }

  const destroyIds = plan.destroy.map(a => a.artistId);

  // Enumerated first: once the rows are gone there is nothing to enumerate.
  const urls = await collectR2Urls(destroyIds, sql);

  // Logged before the transaction, not after: scripts/plans.js --recount
  // cannot reconcile these afterwards — it HEADs URLs read from songs/artists
  // rows, and by the time it would run, DELETE FROM artists has removed them.
  // This log line is the only surviving record of what should exist, so a
  // crash between commit and the R2 loop below still leaves the keys findable.
  if (urls.length) {
    await logger.info('account_delete_files_pending', { email: addr, urls });
  }

  await sql.begin(async (tx) => {
    if (destroyIds.length) {
      // gigs.venue_id / organizer_id are ON DELETE RESTRICT — nullify first, and
      // only for these artists. Same ordering as scripts/delete_artist.js.
      await tx`UPDATE gigs SET venue_id = NULL, organizer_id = NULL WHERE artist_id = ANY(${destroyIds})`;
      // setlist_songs.song_id has no cascade, so setlists go before songs.
      await tx`DELETE FROM setlists WHERE artist_id = ANY(${destroyIds})`;
      // artists cascades songs, gigs, venues, organizers, users, logs.
      await tx`DELETE FROM artists WHERE id = ANY(${destroyIds})`;
    }
    // users.invited_by has no ON DELETE clause (schema.sql:322), and invites
    // are always issued within the inviter's own artist (auth.js ?action=invite
    // inserts invited_by = req.user.id under that same artist_id). So in a
    // "leave" workspace, whoever this person invited is still there after the
    // row below removes this person's own membership — clear the reference
    // first or that DELETE raises users_invited_by_fkey and the whole thing
    // throws, leaving deletion permanently broken for anyone who ever invited
    // someone. Scoped to this person's own user ids, not to an artist_id, since
    // the rows it must reach span every surviving workspace.
    await tx`UPDATE users SET invited_by = NULL WHERE invited_by IN (SELECT id FROM users WHERE lower(email) = ${addr})`;
    // Workspaces that survive: drop only this person's membership.
    await tx`DELETE FROM users WHERE lower(email) = ${addr}`;
    // The contact-form / mailing-list row is this person's own data too —
    // erasure means it goes as well, matched the same way, nothing wider.
    await tx`DELETE FROM subscribers WHERE lower(email) = ${addr}`;
  });

  // Outside the transaction on purpose: R2 has no rollback. An orphaned file is
  // a storage leak behind an unguessable UUID in a non-listable bucket; a row
  // deleted to match a failed file delete would be worse. Every failure is
  // logged — see account_delete_files_pending above for why that log line,
  // not a later reconciliation pass, is what finds an orphan after a crash.
  for (const url of urls) {
    try {
      await deleteFromR2(url);
    } catch (err) {
      await logger.error('account_delete_file_orphaned', { url, error: err.message });
    }
  }

  await logger.info('account_deleted', {
    email: addr,
    destroyed: plan.destroy.map(a => a.slug),
    left:      plan.leave.map(a => a.slug),
    files:     urls.length,
  });

  return { ok: true, found: true, destroyed: plan.destroy.map(a => a.slug), left: plan.leave.map(a => a.slug) };
}

module.exports = { planDeletion, collectR2Urls, executeDeletion };
