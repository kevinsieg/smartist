'use strict';

const { deleteFromR2, keyFromUrl } = require('../_r2');

// Gig helpers shared by the gig handler and the venue and organizer deletes,
// which can take a record's gigs with them.

// Poster files of this band's gigs, removed from the bucket. Only keys under
// the band's own gigs/<slug>/ prefix: a stored URL is just a string. Account
// deletion finds files through the rows (api/_domain/deletion.js), so a gig row
// deleted without its files would leave them in the bucket for good. Failures
// are not fatal; the row is already gone or cleared. The public demo session
// (user id null) keeps the files: demo_reset restores the rows, not the bucket.
async function removeGigFiles(user, artist, urls) {
  if (!user || user.id === null) return;
  const prefix = `gigs/${artist.slug}/`;
  const own = urls.filter(u => typeof u === 'string' && keyFromUrl(u)?.startsWith(prefix));
  await Promise.all(own.map(u => deleteFromR2(u).catch(() => false)));
}

module.exports = { removeGigFiles };
