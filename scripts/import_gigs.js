#!/usr/bin/env node
/**
 * Smartist — Past gig importer
 *
 * Inserts historical gig data sourced from salmons.fr/#live.
 * For each gig a venue row is upserted (matched by name + city within the artist)
 * and the gig is linked to it. Private events create a placeholder "Private" venue.
 *
 * Safe to re-run — skips gigs that already exist (same date + title).
 *
 * Usage:
 *   node scripts/import_gigs.js
 *   DATABASE_URL=<url> node scripts/import_gigs.js
 */

'use strict';

const { neon }  = require('@neondatabase/serverless');
const readline  = require('readline');
const fs        = require('fs');
const path      = require('path');

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

// ── Helpers ─────────────────────────────────────────────────────────────────

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);
const fail = msg => { console.log(`  ${R('✗')} ${msg}`); process.exit(1); };

// ── DB ──────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is not set. Add it to .env or pass it as an env var.');

const ARTIST_SLUG = process.env.ARTIST_SLUG;
if (!ARTIST_SLUG) fail('ARTIST_SLUG is not set. Add it to .env or pass it as an env var.');

const sql = neon(DATABASE_URL);

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ${D('database:')} ${B(host)}`);
  return new Promise(resolve =>
    rl.question('  Continue? (y/n): ', answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) { console.log(D('  Aborted.')); process.exit(0); }
      resolve();
    })
  );
}

// ── Gig data ────────────────────────────────────────────────────────────────
// date:    ISO YYYY-MM-DD
// title:   gig/event name shown in the app
// venue:   venue name (null = private event → placeholder "Private" venue)
// city:    city name
// country: ISO 2-letter code

const GIGS = [
  // 2026
  { date: '2026-03-31', title: "Escale à Sète",             venue: "Scene du Port",             city: 'Sète',                    country: 'FR' },
  { date: '2026-04-01', title: "Escale à Sète",             venue: "Bateau Belem",             city: 'Sète',                    country: 'FR' },
  { date: '2026-04-02', title: "Escale à Sète",             venue: "Bateau Antares",             city: 'Sète',                    country: 'FR' },
  { date: '2026-04-03', title: "Escale à Sète",             venue: "Espace Partenaires",             city: 'Sète',                    country: 'FR' },
  { date: '2026-04-05', title: "Escale à Sète",             venue: "Grande Scene",             city: 'Sète',                    country: 'FR' },
  { date: '2026-04-06', title: "Escale à Sète",             venue: "Port",             city: 'Sète',                    country: 'FR' },
  { date: '2026-05-23', title: 'Private',                   venue: null,                        city: 'Paris',                   country: 'FR' },
  { date: '2026-06-13', title: 'Concert',                   venue: 'Le Local',                  city: 'Sassetot-le-Mauconduit',  country: 'FR' },
  { date: '2026-11-05', title: 'The Sawmill Sessions',      venue: 'Peniche Anako',             city: 'Paris',                   country: 'FR' },

  // 2025
  { date: '2025-12-06', title: 'Concert',                   venue: 'Salle Adolphe Boissaye',    city: 'Étretat',                 country: 'FR' },

  // 2024
  { date: '2024-06-19', title: 'Concert',                   venue: 'Péniche Anako',             city: 'Paris',                   country: 'FR' },
  { date: '2024-05-12', title: "Festival Grand'Escale",     venue: "Port",     city: 'Fécamp',                  country: 'FR' },
  { date: '2024-05-11', title: "Festival Grand'Escale",     venue: "Port",     city: 'Fécamp',                  country: 'FR' },
  { date: '2024-05-10', title: "Festival Grand'Escale",     venue: "Port",     city: 'Fécamp',                  country: 'FR' },
  { date: '2024-05-09', title: "Festival Grand'Escale",     venue: "Port",     city: 'Fécamp',                  country: 'FR' },
  { date: '2024-04-18', title: 'Concert',                   venue: 'La Lanterne',               city: 'Montreuil',               country: 'FR' },
  { date: '2024-04-01', title: 'Concert',                   venue: 'Terre-Tous',                city: 'Ons-en-Bray',             country: 'FR' },
  { date: '2024-03-30', title: 'Concert',                   venue: 'Boom Café',                 city: 'Bruxelles',               country: 'BE' },
  { date: '2024-03-28', title: 'Concert',                   venue: 'Lokarria',                  city: 'Lille',                   country: 'FR' },

  // 2023
  { date: '2023-11-19', title: 'Concert',                   venue: 'Le Bar commun',             city: 'Paris',                   country: 'FR' },
  { date: '2023-09-30', title: 'Concert',                   venue: "Café O'Berry",              city: 'Vierzon',                 country: 'FR' },
  { date: '2023-09-29', title: 'Fête des associations',     venue: 'Fête des associations',     city: 'St-Georges-sur-la-Prée',  country: 'FR' },
  { date: '2023-09-19', title: 'Private',                   venue: null,                        city: 'Paris',                   country: 'FR' },
  { date: '2023-09-03', title: 'Concert',                   venue: 'Avenue de la Libération',   city: 'Plélan-le-Grand',         country: 'FR' },
  { date: '2023-09-02', title: 'Concert',                   venue: 'La Taverne du Fromager',    city: 'Plélan-le-Grand',         country: 'FR' },
  { date: '2023-09-02', title: 'Concert',                   venue: 'Le Plan B',                 city: 'La Turballe',             country: 'FR' },
  { date: '2023-08-31', title: 'Concert',                   venue: 'Café de la Loire',          city: 'Paimbœuf',                country: 'FR' },
  { date: '2023-08-30', title: 'Concert',                   venue: "Place de l'église",         city: 'Pénestin',                country: 'FR' },
  { date: '2023-08-12', title: "Festival L'Herbe bleue",    venue: "Festival L'Herbe bleue",    city: 'Baugé-en-Anjou',          country: 'FR' },
  { date: '2023-06-25', title: 'Concert',                   venue: 'Café Odessa',               city: 'Lormes',                  country: 'FR' },
  { date: '2023-06-24', title: 'Fête de la Musique',        venue: 'Fête de la Musique',        city: 'Lormes',                  country: 'FR' },
  { date: '2023-06-23', title: 'Bal Folk',                  venue: 'Bal Folk',                  city: 'Saint-Brisson',           country: 'FR' },
  { date: '2023-02-25', title: 'Festival Petit Wood Hiver', venue: 'Salle de la Mairie', city: 'Avesnelles',              country: 'FR' },

  // 2022
  { date: '2022-09-17', title: 'Acid Grass Festival',       venue: 'Acid Grass Festival',       city: 'Rives-du-Loir-en-Anjou',  country: 'FR' },
  { date: '2022-09-10', title: 'Private',                   venue: null,                        city: 'Besançon',                country: 'FR' },
  { date: '2022-09-09', title: 'Concert',                   venue: 'Burghof Wallhausen',        city: 'Wallhausen',              country: 'DE' },
  { date: '2022-09-08', title: 'Concert',                   venue: 'Klimperkasten',             city: 'Konstanz',                country: 'DE' },
  { date: '2022-09-03', title: 'Concert',                   venue: 'Camping am See',            city: 'Allensbach',              country: 'DE' },
  { date: '2022-09-02', title: 'Unicorn Music Jam Sessions',venue: 'Unicorn Music Jam Sessions',city: 'Freiburg',                country: 'DE' },
  { date: '2022-07-28', title: 'Festival La Grange bleue',  venue: 'Festival La Grange bleue',  city: 'Mortagne-sur-Sèvre',      country: 'FR' },
  { date: '2022-07-17', title: 'Miniwood Festival',         venue: 'Miniwood Festival',         city: 'Avesnelles',              country: 'FR' },
  { date: '2022-07-15', title: 'Private',                   venue: null,                        city: 'Seine-et-Marne',          country: 'FR' },
  { date: '2022-05-22', title: 'FBMA Spring Stage',         venue: 'FBMA Spring Stage',         city: 'Morvan',                  country: 'FR' },
  { date: '2022-05-20', title: 'Concert',                   venue: 'Le Caps Bar',               city: 'Saulieu',                 country: 'FR' },
  { date: '2022-03-25', title: 'Concert',                   venue: 'La Grosse mignonne',        city: 'Paris',                   country: 'FR' },
  { date: '2022-03-13', title: 'Concert',                   venue: 'Ma Pomme en colimaçon',     city: 'Montreuil',               country: 'FR' },
  { date: '2022-02-28', title: 'Concert',                   venue: 'Auberkitchen',              city: 'Aubervilliers',           country: 'FR' },

  // 2021
  { date: '2021-12-03', title: 'The Sawmill Sessions',                   venue: 'Péniche Anako',             city: 'Paris',                   country: 'FR' },
  { date: '2021-11-25', title: 'Concert',                   venue: 'Le Ton Air de Brest',       city: 'Paris',                   country: 'FR' },
  { date: '2021-09-25', title: 'Open Air',       venue: 'Acid Grass Festival',       city: 'Rives-du-Loir-en-Anjou',  country: 'FR' },
  { date: '2021-07-09', title: 'Concert',                   venue: 'Restaurant Grind',          city: 'La-Roche-sur-Yon',        country: 'FR' },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await confirmDb(DATABASE_URL);

  // Find artist
  const [artist] = await sql`SELECT id, name FROM artists WHERE slug = ${ARTIST_SLUG}`;
  if (!artist) fail(`Artist not found (slug: ${ARTIST_SLUG}).`);
  console.log(`\n  Artist: ${B(artist.name)} (id ${artist.id})\n`);

  let inserted = 0, skipped = 0;
  const venueCache = new Map(); // "name|city" → venue id

  for (const gig of GIGS) {
    const gigTitle  = gig.title;
    const venueName = gig.venue ?? 'Private';

    // Upsert venue first so we can dedup by date + venue_id
    const category = /festival/i.test(venueName) ? 'festival' : null;
    const cacheKey = `${venueName}|${gig.city}`;
    let venueId    = null;

    if (venueCache.has(cacheKey)) {
      venueId = venueCache.get(cacheKey);
    } else {
      const [existingVenue] = await sql`
        SELECT id FROM venues
        WHERE artist_id = ${artist.id} AND name = ${venueName} AND city = ${gig.city}
      `;
      if (existingVenue) {
        venueId = existingVenue.id;
      } else {
        const [newVenue] = await sql`
          INSERT INTO venues (artist_id, name, city, country, category, deleted)
          VALUES (${artist.id}, ${venueName}, ${gig.city}, ${gig.country}, ${category}, false)
          RETURNING id
        `;
        venueId = newVenue.id;
      }
      venueCache.set(cacheKey, venueId);
    }

    // Skip if gig already exists (same date + venue)
    const [existing] = await sql`
      SELECT id FROM gigs
      WHERE artist_id = ${artist.id} AND date = ${gig.date} AND venue_id = ${venueId}
    `;
    if (existing) {
      warn(`skip  ${gig.date}  ${gigTitle} @ ${venueName} (${gig.city})`);
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO gigs (artist_id, title, date, venue_id, deleted)
      VALUES (${artist.id}, ${gigTitle}, ${gig.date}, ${venueId}, false)
    `;

    ok(`insert ${gig.date}  ${gigTitle} @ ${venueName} — ${gig.city}, ${gig.country}`);
    inserted++;
  }

  console.log(`\n  ${B('Done.')} ${G(inserted + ' inserted')}, ${D(skipped + ' skipped')}\n`);
}

main().catch(e => { fail(e.message); });
