#!/usr/bin/env node
/**
 * Smartist — Dev database seeder
 *
 * Populates the database with realistic test data:
 *   - ~20 songs (various genres, keys, tempos, some with extra fields)
 *   - 5 venues
 *   - 3 organizers
 *   - 4 gigs (2 past, 1 upcoming, 1 TBD) linked to venues and organizers
 *   - 4 setlists (2 past gigs, 1 upcoming gig, 1 standalone template)
 *   - Song audit log entries (create / update / delete)
 *   - 2 GEMA works with rightholders
 *
 * Usage:
 *   node scripts/seed.js                  # seed (skips if data exists)
 *   node scripts/seed.js --force          # wipe and reseed
 *   DATABASE_URL=<url> node scripts/seed.js
 *
 * Reads DATABASE_URL and ARTIST_SLUG from .env / .env.local in the project root.
 * Targets the artist matching ARTIST_SLUG (falls back to the first artist in the DB).
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

// ── Env ────────────────────────────────────────────────────────────────────

function loadEnv(filePath) {
  try {
    fs.readFileSync(filePath, 'utf8').split('\n').forEach(line => {
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

loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '..', '.env.local'));

// ── Print helpers ──────────────────────────────────────────────────────────

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);
const err  = msg => console.log(`  ${R('✗')} ${msg}`);

// ── Args ───────────────────────────────────────────────────────────────────

const FORCE = process.argv.includes('--force');

// ── DB ─────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  err('DATABASE_URL is not set. Add it to .env or pass it as an environment variable.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ${D('database:')} ${B(host)}`);
  return new Promise(resolve =>
    rl.question(`  Continue? (y/n): `, answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) {
        console.log(D('  Aborted.'));
        process.exit(0);
      }
      resolve();
    })
  );
}

// ── Seed data ──────────────────────────────────────────────────────────────

const SONGS = [
  // Rock
  { title: 'Highway Star',               active: true,  key: 'G',   genre: 'Rock',        tempo: 'Fast',   length_min: 4.5,  interpret: 'Deep Purple',            extra: {} },
  { title: 'Whole Lotta Love',           active: true,  key: 'E',   genre: 'Rock',        tempo: 'Fast',   length_min: 5.5,  interpret: 'Led Zeppelin',            extra: {} },
  { title: 'Come Together',             active: true,  key: 'Dm',  genre: 'Rock',        tempo: 'Medium', length_min: 4.2,  interpret: 'The Beatles',             extra: {} },
  // Blues
  { title: 'Crossroads',                active: true,  key: 'A',   genre: 'Blues',       tempo: 'Fast',   length_min: 3.75, interpret: 'Robert Johnson',          reference_interpret: 'Cream',   extra: {} },
  { title: 'The Thrill Is Gone',        active: true,  key: 'Bm',  genre: 'Blues',       tempo: 'Slow',   length_min: 5.0,  interpret: 'B.B. King',               extra: {} },
  { title: 'Pride and Joy',             active: true,  key: 'E',   genre: 'Blues',       tempo: 'Medium', length_min: 3.5,  interpret: 'Stevie Ray Vaughan',      extra: {} },
  // Folk / Country
  { title: 'Wagon Wheel',               active: true,  key: 'A',   genre: 'Country',     tempo: 'Medium', length_min: 4.0,  interpret: 'Old Crow Medicine Show',  extra: { capo: 2 } },
  { title: 'Take Me Home, Country Roads', active: true, key: 'G',  genre: 'Country',     tempo: 'Medium', length_min: 3.25, interpret: 'John Denver',             extra: { capo: 0 } },
  { title: 'The House of the Rising Sun', active: true, key: 'Am', genre: 'Folk',        tempo: 'Slow',   length_min: 4.5,  interpret: 'The Animals',             extra: { capo: 0 } },
  // Funk / Soul
  { title: 'Superstition',              active: true,  key: 'Ebm', genre: 'Funk',        tempo: 'Medium', length_min: 4.0,  interpret: 'Stevie Wonder',           extra: {} },
  { title: 'Signed, Sealed, Delivered', active: true,  key: 'F',   genre: 'Soul',        tempo: 'Medium', length_min: 2.75, interpret: 'Stevie Wonder',           extra: {} },
  { title: 'Respect',                   active: true,  key: 'C',   genre: 'Soul',        tempo: 'Medium', length_min: 2.5,  interpret: 'Aretha Franklin',         extra: {} },
  // Reggae
  { title: "No Woman, No Cry",          active: true,  key: 'C',   genre: 'Reggae',      tempo: 'Slow',   length_min: 6.5,  interpret: 'Bob Marley',              extra: {} },
  { title: 'Redemption Song',           active: true,  key: 'G',   genre: 'Reggae',      tempo: 'Slow',   length_min: 3.5,  interpret: 'Bob Marley',              extra: { capo: 2 } },
  // Alternative / Indie
  { title: 'Creep',                     active: true,  key: 'G',   genre: 'Alternative', tempo: 'Slow',   length_min: 3.75, interpret: 'Radiohead',               extra: {} },
  { title: 'Mr. Jones',                 active: true,  key: 'Am',  genre: 'Alternative', tempo: 'Medium', length_min: 4.5,  interpret: 'Counting Crows',          extra: { capo: 5 } },
  // Originals (no interpret = own songs)
  { title: 'Midnight Drive',            active: true,  key: 'D',   genre: 'Rock',        tempo: 'Fast',   length_min: 3.75, interpret: null, comment: 'Our opener — high energy start',              extra: {} },
  { title: 'River Town Blues',          active: true,  key: 'E',   genre: 'Blues',       tempo: 'Medium', length_min: 4.25, interpret: null, comment: 'B.B. King-style, key may drop to Eb live',    extra: {} },
  // Inactive (retired from setlists)
  { title: 'Brown Eyed Girl',           active: false, key: 'G',   genre: 'Rock',        tempo: 'Medium', length_min: 3.5,  interpret: 'Van Morrison',            comment: 'Too overplayed — retired', extra: {} },
  { title: 'Sweet Home Chicago',        active: false, key: 'E',   genre: 'Blues',       tempo: 'Fast',   length_min: 3.0,  interpret: 'Robert Johnson',          extra: {} },
];

const VENUES = [
  {
    name: 'Le Chat Noir',
    city: 'Lyon', country: 'France', postcode: '69001', state: 'Auvergne-Rhône-Alpes',
    size: 200, status: 'Active', category: 'club',
    website: 'https://lecharnoir.example.fr',
    booking_channel: 'Email', generic_email: 'booking@lechatnoir.example.fr',
    comment: 'Great outdoor courtyard. PA included. Contact: Julien Morel.',
    main_genre: 'Blues', turnus: 'Monthly',
  },
  {
    name: 'Parc des Expositions',
    city: 'Nantes', country: 'France', postcode: '44300', state: 'Pays de la Loire',
    size: 5000, status: 'Confirmed', category: 'festival',
    website: 'https://parcexpo-nantes.example.fr',
    booking_channel: 'Agency',
    comment: 'Festival site — large outdoor stage. Load-in from 14:00.',
    main_genre: 'Mixed', season: 'Summer',
  },
  {
    name: 'La Maison Bleue',
    city: 'Bordeaux', country: 'France', postcode: '33000', state: 'Nouvelle-Aquitaine',
    size: 350, status: 'Prospect', category: 'club',
    generic_email: 'contact@maisonbleue.example.fr',
    booking_channel: 'Email',
    comment: 'On our shortlist for the warm-up show. No response yet.',
    main_genre: 'Rock',
  },
  {
    name: 'Le Cargo',
    city: 'Rouen', country: 'France', postcode: '76000', state: 'Normandie',
    size: 500, status: 'Prospect', category: 'club',
    website: 'https://lecargo.example.fr',
    generic_email: 'prog@lecargo.example.fr',
    booking_channel: 'Email',
    comment: 'Alternative option for warm-up show. Known for indie/rock nights.',
    main_genre: 'Rock',
  },
  {
    name: 'Kulturzentrum am Schloss',
    city: 'Heidelberg', country: 'Germany', postcode: '69117', state: 'Baden-Württemberg',
    size: 280, status: 'Active', category: 'club',
    generic_email: 'buero@kuzas.example.de',
    booking_channel: 'Email',
    comment: 'Reliable venue, good sound system. Audience is very attentive.',
    main_genre: 'Folk', turnus: 'Bi-monthly',
  },
];

const ORGANIZERS = [
  {
    name: 'Jazz & Blues Prod',
    type: 'Agency',
    email: 'booking@jazzblues.example.fr',
    phone: '+33 1 23 45 67 89',
    website: 'https://jazzblues-prod.example.fr',
    city: 'Paris', country: 'France',
    comment: 'Main booking agency. Contact: Marie Leclerc. Responsive, good network.',
  },
  {
    name: 'Festival du Bout du Monde',
    type: 'Festival',
    email: 'artists@fest-bdm.example.org',
    city: 'Quimper', country: 'France',
    comment: 'Annual festival in Brittany. Very professional organisation. 2-year advance planning.',
  },
  {
    name: 'Self-organized',
    type: 'Self',
    city: null, country: null,
    comment: 'Direct booking — no external organizer involved.',
  },
];

// venue_key and organizer_key reference VENUES[*].name and ORGANIZERS[*].name for lookup after insert.
const GIGS = [
  {
    title: 'Blues Night at Le Chat Noir',
    date: '2024-09-14', type: 'Club show',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Le Chat Noir',
    organizer_key: 'Jazz & Blues Prod',
    comment: 'Outdoor courtyard — bring the extra PA.',
  },
  {
    title: 'Festival du Bout du Monde',
    date: '2024-11-02', type: 'Festival',
    time_start: '18:00', time_end: '20:30',
    venue_key: 'Parc des Expositions',
    organizer_key: 'Festival du Bout du Monde',
    comment: 'Two 45-min sets back to back. Check PA at 17:00.',
  },
  {
    title: 'Summer Open Air 2026',
    date: '2026-06-20', type: 'Festival',
    time_start: '20:30', time_end: '21:30',
    venue_key: 'Parc des Expositions',
    organizer_key: 'Jazz & Blues Prod',
    comment: 'Confirmed 60-min slot.',
  },
  {
    title: 'Warm-up Show (TBD)',
    date: null, type: 'Club show',
    time_start: null, time_end: null,
    venue_key: null,
    organizer_key: 'Self-organized',
    comment: 'Venue shortlist: Le Cargo (Rouen), La Maison Bleue (Bordeaux).',
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  await confirmDb(DATABASE_URL);

  console.log(`\n${B('Smartist — Dev seeder')}`);
  console.log(D('─'.repeat(44)));

  // Find the artist by ARTIST_SLUG, or fall back to the first artist in the DB
  const slug = process.env.ARTIST_SLUG;
  let artist;
  if (slug) {
    [artist] = await sql`SELECT * FROM artists WHERE slug = ${slug}`;
    if (!artist) {
      err(`Artist with slug "${slug}" not found. Run setup.js first.`);
      process.exit(1);
    }
  } else {
    [artist] = await sql`SELECT * FROM artists ORDER BY id LIMIT 1`;
    if (!artist) {
      err('No artists in the database. Run setup.js first to create one.');
      process.exit(1);
    }
    warn(`ARTIST_SLUG not set — targeting first artist: "${artist.name}" (${artist.slug})`);
  }

  ok(`Artist: ${B(artist.name)} (slug: ${artist.slug}, id: ${artist.id})`);

  // Check for existing data
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM songs WHERE artist_id = ${artist.id}`;
  if (count > 0 && !FORCE) {
    warn(`Database already has ${count} song(s) for this artist.`);
    warn('Use --force to wipe and reseed.');
    process.exit(0);
  }

  if (FORCE && count > 0) {
    warn(`Wiping existing data for artist ${artist.slug}…`);
    // Order matters: respect FK constraints
    // gigs → venues/organizers (RESTRICT), so gigs first
    await sql`DELETE FROM gema_works  WHERE artist_id = ${artist.id}`;  // cascades rightholders
    await sql`DELETE FROM setlists    WHERE artist_id = ${artist.id}`;  // cascades setlist_songs
    await sql`DELETE FROM gigs        WHERE artist_id = ${artist.id}`;  // before venues/organizers
    await sql`DELETE FROM venues      WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM organizers  WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM song_logs   WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM songs       WHERE artist_id = ${artist.id}`;
    ok('Existing data cleared.');
  }

  // ── Songs ─────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting songs…')}`);
  const songRows = [];
  for (const s of SONGS) {
    const [row] = await sql`
      INSERT INTO songs (artist_id, title, active, key, genre, tempo, length_min,
                         interpret, reference_interpret, comment, extra)
      VALUES (${artist.id}, ${s.title}, ${s.active}, ${s.key ?? null},
              ${s.genre ?? null}, ${s.tempo ?? null}, ${s.length_min ?? null},
              ${s.interpret ?? null}, ${s.reference_interpret ?? null},
              ${s.comment ?? null}, ${s.extra})
      RETURNING *
    `;
    songRows.push(row);
    ok(`  ${row.active ? '' : D('[inactive] ')}${row.title}`);
  }

  // ── Song audit log ────────────────────────────────────────────────────────

  console.log(`\n  ${B('Writing song audit log…')}`);
  for (const row of songRows) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${row.id}, 'create', ${row}, NOW() - interval '30 days')
    `;
  }
  for (const row of songRows.slice(0, 5)) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${row.id}, 'update', ${row}, NOW() - interval '10 days')
    `;
  }
  const deletedSong = songRows.find(r => !r.active);
  if (deletedSong) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${deletedSong.id}, 'delete', ${deletedSong}, NOW() - interval '5 days')
    `;
  }
  ok(`${songRows.length + 6} log entries written.`);

  // ── Venues ────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting venues…')}`);
  const venueByName = {};
  for (const v of VENUES) {
    const [row] = await sql`
      INSERT INTO venues (artist_id, name, city, country, postcode, state, size,
                          status, category, website, generic_email, booking_channel,
                          comment, main_genre, turnus, season)
      VALUES (
        ${artist.id}, ${v.name}, ${v.city ?? null}, ${v.country ?? null},
        ${v.postcode ?? null}, ${v.state ?? null}, ${v.size ?? null},
        ${v.status ?? null}, ${v.category ?? null}, ${v.website ?? null},
        ${v.generic_email ?? null}, ${v.booking_channel ?? null},
        ${v.comment ?? null}, ${v.main_genre ?? null}, ${v.turnus ?? null},
        ${v.season ?? null}
      )
      RETURNING *
    `;
    venueByName[v.name] = row;
    ok(`  ${row.name}${row.city ? D(` — ${row.city}`) : ''}`);
  }

  // ── Organizers ────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting organizers…')}`);
  const organizerByName = {};
  for (const o of ORGANIZERS) {
    const [row] = await sql`
      INSERT INTO organizers (artist_id, name, type, email, phone, website,
                              city, country, comment)
      VALUES (
        ${artist.id}, ${o.name}, ${o.type ?? null}, ${o.email ?? null},
        ${o.phone ?? null}, ${o.website ?? null},
        ${o.city ?? null}, ${o.country ?? null}, ${o.comment ?? null}
      )
      RETURNING *
    `;
    organizerByName[o.name] = row;
    ok(`  ${row.name}${row.type ? D(` (${row.type})`) : ''}`);
  }

  // ── Gigs ──────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting gigs…')}`);
  const gigRows = [];
  for (const g of GIGS) {
    const venueId     = g.venue_key     ? (venueByName[g.venue_key]?.id     ?? null) : null;
    const organizerId = g.organizer_key ? (organizerByName[g.organizer_key]?.id ?? null) : null;
    const [row] = await sql`
      INSERT INTO gigs (artist_id, title, date, venue_id, organizer_id,
                        type, time_start, time_end, comment)
      VALUES (
        ${artist.id}, ${g.title}, ${g.date ?? null},
        ${venueId}, ${organizerId},
        ${g.type ?? null}, ${g.time_start ?? null}, ${g.time_end ?? null},
        ${g.comment ?? null}
      )
      RETURNING *
    `;
    gigRows.push(row);
    const venueLabel = g.venue_key ?? '(TBD)';
    ok(`  ${row.title}${row.date ? D(` — ${row.date}`) : D(' (TBD)')} @ ${D(venueLabel)}`);
  }

  // ── Setlists ──────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Building setlists…')}`);

  async function makeSetlist({ title, comment, gigId, songIds }) {
    const [sl] = await sql`
      INSERT INTO setlists (artist_id, title, gig_id, comment)
      VALUES (${artist.id}, ${title ?? null}, ${gigId ?? null}, ${comment ?? null})
      RETURNING *
    `;
    if (songIds.length > 0) {
      const slIds = songIds.map(() => sl.id);
      const posns = songIds.map((_, i) => i);
      await sql`
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT * FROM unnest(${slIds}::int[], ${songIds}::int[], ${posns}::int[])
      `;
    }
    return sl;
  }

  const byTitle = Object.fromEntries(songRows.map(r => [r.title, r.id]));

  const sl1 = await makeSetlist({
    title:   'Blues Night — full set',
    comment: '45 min outdoor set — keep it punchy',
    gigId:   gigRows[0].id,
    songIds: [
      byTitle['Crossroads'], byTitle['Pride and Joy'], byTitle['The Thrill Is Gone'],
      byTitle['Superstition'], byTitle['River Town Blues'], byTitle['Come Together'],
      byTitle['Whole Lotta Love'], byTitle['Midnight Drive'],
    ].filter(Boolean),
  });
  ok(`  ${sl1.title}`);

  const sl2 = await makeSetlist({
    title:   'Festival — set 1',
    comment: 'First slot — warm up the crowd, mix of styles',
    gigId:   gigRows[1].id,
    songIds: [
      byTitle['Highway Star'], byTitle['Wagon Wheel'], byTitle["No Woman, No Cry"],
      byTitle['Signed, Sealed, Delivered'], byTitle['Creep'], byTitle['Mr. Jones'],
      byTitle['Redemption Song'], byTitle['Midnight Drive'],
    ].filter(Boolean),
  });
  ok(`  ${sl2.title}`);

  const sl3 = await makeSetlist({
    title:   'Summer Open Air 2026 — 60 min',
    comment: 'Full hour set — end on high energy',
    gigId:   gigRows[2].id,
    songIds: [
      byTitle['Midnight Drive'], byTitle['Highway Star'], byTitle['Crossroads'],
      byTitle['River Town Blues'], byTitle['Pride and Joy'], byTitle['Superstition'],
      byTitle['Come Together'], byTitle["No Woman, No Cry"], byTitle['Whole Lotta Love'],
      byTitle['Wagon Wheel'],
    ].filter(Boolean),
  });
  ok(`  ${sl3.title}`);

  const sl4 = await makeSetlist({
    title:   'Short set template (30 min)',
    comment: 'Reusable template for small venues and private events',
    gigId:   null,
    songIds: [
      byTitle['Crossroads'], byTitle['Signed, Sealed, Delivered'],
      byTitle['Redemption Song'], byTitle['Midnight Drive'],
      byTitle['Come Together'], byTitle['The House of the Rising Sun'],
    ].filter(Boolean),
  });
  ok(`  ${sl4.title}`);

  // ── GEMA works ────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting GEMA works…')}`);

  const performers = artist.name.toUpperCase();

  const [gw1] = await sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, iswc, language, performers,
       gema_genre, duration_sec, first_registered_at, last_updated_at, song_id)
    VALUES
      (${artist.id}, '15299392-001', 'MIDNIGHT DRIVE', 'T8034602217',
       'EN', ${performers}, 'ROCK', 225,
       '2023-01-15', '2024-03-01', ${byTitle['Midnight Drive'] ?? null})
    RETURNING *
  `;
  ok('  MIDNIGHT DRIVE (15299392-001)');

  const [gw2] = await sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, iswc, language, performers,
       gema_genre, duration_sec, first_registered_at, last_updated_at, song_id)
    VALUES
      (${artist.id}, '15299393-001', 'RIVER TOWN BLUES', 'T8034602218',
       'EN', ${performers}, 'BLUES', 255,
       '2023-01-15', '2024-03-01', ${byTitle['River Town Blues'] ?? null})
    RETURNING *
  `;
  ok('  RIVER TOWN BLUES (15299393-001)');

  // ── GEMA rightholders ─────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting GEMA rightholders…')}`);

  for (const [workId, workLabel] of [[gw1.id, 'MIDNIGHT DRIVE'], [gw2.id, 'RIVER TOWN BLUES']]) {
    await sql`
      INSERT INTO gema_rightholders
        (gema_work_id, name, ip_name_number, role,
         ar_share, vr_share, ar_share_cumulated, vr_share_cumulated,
         society_ar, society_vr)
      VALUES
        (${workId}, 'SIEG KEVIN',             '755143051', 'composer',
         66.67, 66.67, 66.67, 66.67, 'GEMA', 'GEMA'),
        (${workId}, 'SMITH JANE',             '755143052', 'lyricist',
         33.33, 33.33, 33.33, 33.33, 'GEMA', 'GEMA'),
        (${workId}, 'MUSIC PUBLISHER GMBH',   '755143053', 'publisher',
         0.00,  0.00,  0.00,  0.00,  'GEMA', 'GEMA')
    `;
    ok(`  3 rightholders → ${workLabel}`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM songs      WHERE artist_id = ${artist.id}) AS songs,
      (SELECT COUNT(*)::int FROM venues     WHERE artist_id = ${artist.id}) AS venues,
      (SELECT COUNT(*)::int FROM organizers WHERE artist_id = ${artist.id}) AS organizers,
      (SELECT COUNT(*)::int FROM gigs       WHERE artist_id = ${artist.id}) AS gigs,
      (SELECT COUNT(*)::int FROM setlists   WHERE artist_id = ${artist.id}) AS setlists,
      (SELECT COUNT(*)::int FROM song_logs  WHERE artist_id = ${artist.id}) AS logs,
      (SELECT COUNT(*)::int FROM gema_works WHERE artist_id = ${artist.id}) AS gema_works
  `;

  console.log(`\n${B('Done.')} ${D(`— artist: ${artist.name}`)}`);
  console.log(D('─'.repeat(44)));
  console.log(`  Songs       ${B(stats.songs)}  (${songRows.filter(r => !r.active).length} inactive)`);
  console.log(`  Venues      ${B(stats.venues)}`);
  console.log(`  Organizers  ${B(stats.organizers)}`);
  console.log(`  Gigs        ${B(stats.gigs)}`);
  console.log(`  Setlists    ${B(stats.setlists)}`);
  console.log(`  Log rows    ${B(stats.logs)}`);
  console.log(`  GEMA        ${B(stats.gema_works)} works\n`);
}

run().catch(e => {
  err(e.message);
  process.exit(1);
});
