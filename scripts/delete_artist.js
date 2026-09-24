#!/usr/bin/env node
/**
 * Smartist — Delete one artist and all its data
 *
 * Usage:
 *   node scripts/delete_artist.js --artist <slug>
 *   DATABASE_URL=<url> node scripts/delete_artist.js --artist <slug>
 *
 * Shows the DB hostname and a row count per table, then asks for the slug to be
 * typed back before deleting. Everything happens in one transaction.
 *
 * Deletion order matters (see DATABASE.md → Tenant lifecycle):
 *   1. gigs.venue_id / gigs.organizer_id are ON DELETE RESTRICT → nullify first
 *   2. setlist_songs.song_id has no cascade → drop setlists first (cascades setlist_songs)
 *   3. DELETE FROM artists cascades the rest
 *
 * R2 files (audio, sheets, playback) are NOT removed — delete them in the
 * Cloudflare dashboard or with `wrangler r2 object delete`.
 */

'use strict';

const postgres = require('postgres');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

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

const args = process.argv.slice(2);
const slug = (() => { const i = args.indexOf('--artist'); return i >= 0 ? args[i + 1] : null; })();

if (!slug) {
  err('Usage: node scripts/delete_artist.js --artist <slug>');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  err('DATABASE_URL is not set. Add it to .env or pass it as an environment variable.');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let host;
  try { host = new URL(DATABASE_URL).hostname; } catch { host = '(unknown)'; }
  const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1 });

  try {
    const [artist] = await sql`SELECT id, slug, name FROM artists WHERE slug = ${slug}`;
    console.log(`\n  ${D('database:')} ${B(host)}`);
    if (!artist) { err(`Artist "${slug}" not found.`); process.exit(1); }
    console.log(`  ${D('artist:')} ${B(artist.name)} ${D(`(${artist.slug}, id ${artist.id})`)}\n`);

    const [counts] = await sql`
      SELECT (SELECT count(*) FROM songs             WHERE artist_id = ${artist.id}) AS songs,
             (SELECT count(*) FROM setlists          WHERE artist_id = ${artist.id}) AS setlists,
             (SELECT count(*) FROM gigs              WHERE artist_id = ${artist.id}) AS gigs,
             (SELECT count(*) FROM venues            WHERE artist_id = ${artist.id}) AS venues,
             (SELECT count(*) FROM organizers        WHERE artist_id = ${artist.id}) AS organizers,
             (SELECT count(*) FROM gema_works        WHERE artist_id = ${artist.id}) AS gema_works,
             (SELECT count(*) FROM song_arrangements WHERE artist_id = ${artist.id}) AS arrangements,
             (SELECT count(*) FROM song_logs         WHERE artist_id = ${artist.id}) AS song_logs,
             (SELECT count(*) FROM users             WHERE artist_id = ${artist.id}) AS users`;
    Object.entries(counts).forEach(([table, n]) => console.log(`    ${table.padEnd(14)} ${n}`));

    const [media] = await sql`
      SELECT count(*) AS n FROM songs
      WHERE artist_id = ${artist.id}
        AND (extra ? 'listenUrl' OR extra ? 'sheetUrl' OR extra ? 'playbackUrl')`;
    if (Number(media.n) > 0) warn(`${media.n} songs reference R2 files — those are not deleted by this script.`);

    console.log(R('\n  This cannot be undone.'));
    const answer = await ask(`  Type the slug "${slug}" to delete everything: `);
    if (answer !== slug) { console.log(D('  Aborted.')); process.exit(0); }

    await sql.begin(async tx => {
      // RESTRICT FKs on gigs block the venue/organizer cascade.
      await tx`UPDATE gigs SET venue_id = NULL, organizer_id = NULL WHERE artist_id = ${artist.id}`;
      // Other artists' references into this one (see api/_domain/deletion.js).
      await tx`DELETE FROM setlist_songs WHERE song_id IN (SELECT id FROM songs WHERE artist_id = ${artist.id})`;
      await tx`UPDATE gigs SET venue_id = NULL WHERE venue_id IN (SELECT id FROM venues WHERE artist_id = ${artist.id})`;
      await tx`UPDATE gigs SET organizer_id = NULL WHERE organizer_id IN (SELECT id FROM organizers WHERE artist_id = ${artist.id})`;
      // setlist_songs.song_id has no cascade — remove setlists (and their songs) first.
      await tx`DELETE FROM setlists WHERE artist_id = ${artist.id}`;
      await tx`DELETE FROM artists WHERE id = ${artist.id}`;
    });

    ok(`Artist "${slug}" and all linked rows deleted.`);
  } finally {
    await sql.end();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
