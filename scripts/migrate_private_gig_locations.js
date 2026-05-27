#!/usr/bin/env node
/**
 * One-time migration: detaches private gigs from placeholder venues.
 *
 * Finds gigs where:
 *   - gig.type = 'private'  AND venue_id IS NOT NULL, OR
 *   - linked venue.category = 'placeholder'
 *
 * For each: copies COALESCE(venue.city, venue.name) into gig.location,
 * then sets venue_id = NULL.
 *
 * Usage:
 *   node scripts/migrate_private_gig_locations.js [--artist <slug>]
 *
 * Without --artist, targets all artists in the database.
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

function loadEnv(f) {
  try {
    fs.readFileSync(f, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
  } catch {}
}
loadEnv(path.join(__dirname, '..', '.env.local'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const args      = process.argv.slice(2);
const artistIdx = args.indexOf('--artist');
const slugFilter = artistIdx !== -1 ? args[artistIdx + 1] : null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

function pad(s, w) { return String(s ?? '').padEnd(w).slice(0, w); }

(async () => {
  let host;
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { host = '(unknown)'; }
  console.log(`\n  database: ${host}`);
  const proceed = await ask('  Continue? (y/n): ');
  if (!/^y/i.test(proceed.trim())) { console.log('  Aborted.'); rl.close(); return; }

  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql`
    SELECT
      g.id          AS gig_id,
      g.title       AS gig_title,
      g.date        AS gig_date,
      g.type        AS gig_type,
      g.location    AS gig_location,
      ar.slug       AS artist_slug,
      v.id          AS venue_id,
      v.name        AS venue_name,
      v.city        AS venue_city,
      v.category    AS venue_category,
      COALESCE(v.city, v.name) AS proposed_location
    FROM gigs g
    JOIN artists ar ON ar.id = g.artist_id
    JOIN venues  v  ON v.id  = g.venue_id
    WHERE g.deleted = false
      AND (g.type = 'private' OR v.category = 'placeholder')
      AND (${slugFilter}::text IS NULL OR ar.slug = ${slugFilter})
    ORDER BY ar.slug, g.date DESC NULLS LAST
  `;

  if (!rows.length) {
    console.log('\n  No matching gigs found. Nothing to migrate.');
    rl.close();
    return;
  }

  console.log(`\n  Found ${rows.length} gig(s) to migrate:\n`);
  console.log(
    '  ' + pad('Artist', 14) + pad('Date', 12) + pad('Gig', 28) +
    pad('Type', 10) + pad('Venue (will be detached)', 28) + 'Location (will be set)'
  );
  console.log('  ' + '-'.repeat(110));

  for (const r of rows) {
    const alreadySet = r.gig_location ? ` [has: "${r.gig_location}"]` : '';
    console.log(
      '  ' + pad(r.artist_slug, 14) +
      pad(r.gig_date ? String(r.gig_date).slice(0, 10) : '(no date)', 12) +
      pad(r.gig_title, 28) +
      pad(r.gig_type || '—', 10) +
      pad(`${r.venue_name} [${r.venue_category || '—'}]`, 28) +
      r.proposed_location + alreadySet
    );
  }

  const alreadyFilled = rows.filter(r => r.gig_location);
  if (alreadyFilled.length) {
    console.log(`\n  WARNING: ${alreadyFilled.length} gig(s) already have a location set.`);
    console.log('  Their existing location will be OVERWRITTEN with the venue city/name.');
    const keep = await ask('  Keep existing locations where set? (y/n): ');
    if (/^y/i.test(keep.trim())) {
      // Only update location when it is currently null
      const confirm = await ask(`\n  Detach venue_id and fill empty locations for ${rows.length} gig(s)? (y/n): `);
      if (!/^y/i.test(confirm.trim())) { console.log('  Aborted.'); rl.close(); return; }

      let count = 0;
      for (const r of rows) {
        await sql`
          UPDATE gigs SET
            location   = COALESCE(location, ${r.proposed_location}),
            venue_id   = NULL,
            last_updated = NOW()
          WHERE id = ${r.gig_id}
        `;
        count++;
      }
      console.log(`\n  Done — ${count} gigs detached. Existing locations preserved.`);
      rl.close();
      return;
    }
  }

  const confirm = await ask(`\n  Detach venue_id and set location for all ${rows.length} gig(s)? (y/n): `);
  if (!/^y/i.test(confirm.trim())) { console.log('  Aborted.'); rl.close(); return; }

  const ids              = rows.map(r => r.gig_id);
  const proposedByGigId  = Object.fromEntries(rows.map(r => [r.gig_id, r.proposed_location]));

  let count = 0;
  for (const r of rows) {
    await sql`
      UPDATE gigs SET
        location     = ${proposedByGigId[r.gig_id]},
        venue_id     = NULL,
        last_updated = NOW()
      WHERE id = ${r.gig_id}
    `;
    count++;
  }

  console.log(`\n  Done — ${count} gigs detached from placeholder/private venues.`);
  console.log('  You can now hard-delete the orphaned placeholder venues from /venues.');
  rl.close();
})().catch(e => { console.error(e.message); rl.close(); process.exit(1); });
