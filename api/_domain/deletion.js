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
// literal `=` here would silently find nothing for `Kevin@GMX.de`.
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
// Never do this by key prefix. Song media written before keys were scoped is
// `audio/<uuid>-<name>`, `sheets/…`, `playback/…` — one flat namespace shared
// by every tenant — so a prefix delete would take every band's recordings.
// Newer keys are `audio/<artist id>/<uuid>-<name>`; gigs/<slug>/ and
// bands/<slug>/ carry a slug. The rows stay the source of truth.
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
    SELECT id, slug, config FROM artists WHERE id = ANY(${artistIds})
  `;

  // Only keys this account can prove it owns. A stored URL is just a string a
  // band could once set to anything, so a URL naming another band's object —
  // `bands/<other slug>/…`, `audio/<other id>/…` — is left alone rather than
  // deleted on that band's behalf. Pre-scoping song media (`audio/<uuid>-name`)
  // carries no owner at all and is still removed, as before.
  const ids   = new Set(bands.map(b => String(b.id)));
  const slugs = new Set(bands.map(b => b.slug));
  const base  = process.env.R2_PUBLIC_URL;
  const owned = (u) => {
    if (!base || !u.startsWith(`${base}/`)) return true;   // not ours to judge; deleteFromR2 ignores it
    const key = u.slice(base.length + 1).split('?')[0];
    const m = /^(audio|sheets|playback)\/([^/]+)\/[^/]+$/.exec(key);
    if (m) return ids.has(m[2]);
    if (/^(audio|sheets|playback)\/[^/]+$/.test(key)) return true;   // legacy flat key
    const b = /^(bands|gigs)\/([^/]+)\//.exec(key);
    if (b) return slugs.has(b[2]);
    return false;
  };

  const urls = new Set();
  const add  = (u) => { if (u && typeof u === 'string' && owned(u)) urls.add(u); };

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

// Bounded-concurrency R2 deletes. One await per file is the wrong shape here:
// this loop runs AFTER the transaction has committed, so a Pro band with a few
// hundred media files walks the function past its time limit with the rows
// already gone — the client sees a connection error, keeps its token, and the
// retry answers 400 "invalid link", telling someone their deletion failed when
// it actually succeeded. A small fixed pool keeps that walk short without
// opening hundreds of sockets at once; no dependency, the pool is four lines.
const R2_CONCURRENCY = 8;

async function removeFiles(urls, deleteFromR2, logger) {
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        // api/_r2.js's deleteFromR2 swallows its own errors and reports failure
        // by returning false, so checking the return value is the only way this
        // log line ever fires in production. The catch stays for a caller that
        // injects a throwing double, and for a future implementation that throws.
        if (!(await deleteFromR2(url)))
          await logger.error('account_delete_file_orphaned', { url, error: 'delete reported failure' });
      } catch (err) {
        await logger.error('account_delete_file_orphaned', { url, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(R2_CONCURRENCY, urls.length) }, worker));
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
      // References from OTHER artists into these rows would block the delete
      // (setlist_songs.song_id has no cascade; venue/organizer are RESTRICT).
      // The API refuses such cross-tenant ids now, but rows written before that
      // check must not be able to hold someone's deletion hostage.
      await tx`DELETE FROM setlist_songs WHERE song_id IN (SELECT id FROM songs WHERE artist_id = ANY(${destroyIds}))`;
      await tx`UPDATE gigs SET venue_id = NULL WHERE venue_id IN (SELECT id FROM venues WHERE artist_id = ANY(${destroyIds}))`;
      await tx`UPDATE gigs SET organizer_id = NULL WHERE organizer_id IN (SELECT id FROM organizers WHERE artist_id = ANY(${destroyIds}))`;
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
    // rate_limits keys are `<prefix>:<address>` and nothing ever reaps them, so
    // without this a bare email address sits in the database for an hour after
    // the account it belonged to was erased. Only the two prefixes that are
    // keyed on an address (delete-req here, signup-link in signup.js/oauth.js);
    // every other key is keyed on an IP or an artist id. lower(key) because the
    // key was built from whatever casing the row stored.
    await tx`DELETE FROM rate_limits WHERE lower(key) IN ('delete-req:' || ${addr}, 'signup-link:' || ${addr})`;
  });

  // Outside the transaction on purpose: R2 has no rollback. An orphaned file is
  // a storage leak behind an unguessable UUID in a non-listable bucket; a row
  // deleted to match a failed file delete would be worse. Every failure is
  // logged — see account_delete_files_pending above for why that log line,
  // not a later reconciliation pass, is what finds an orphan after a crash.
  await removeFiles(urls, deleteFromR2, logger);

  await logger.info('account_deleted', {
    email: addr,
    destroyed: plan.destroy.map(a => a.slug),
    left:      plan.leave.map(a => a.slug),
    files:     urls.length,
  });

  return { ok: true, found: true, destroyed: plan.destroy.map(a => a.slug), left: plan.leave.map(a => a.slug) };
}

module.exports = { planDeletion, collectR2Urls, executeDeletion, removeFiles };
