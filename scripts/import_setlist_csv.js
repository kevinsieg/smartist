#!/usr/bin/env node
/**
 * smartist — setlist importer (CSV → songs + one saved setlist)
 *
 * Reads a CSV of songs, matches every row against the band's existing songs,
 * completes the ones that exist (only fields they have not got yet — nothing is
 * overwritten), creates the ones that do not, and saves all of them as one
 * setlist in CSV order. One transaction; --dry-run prints the report and rolls
 * it back.
 *
 * CSV columns (header names are matched ignoring case and accents):
 *   title        required (also: titre, titel)
 *   length       3:20 or 3.33 minutes (also: duration, durée, dauer)
 *   author       → extra.author   (also: auteur, autor)
 *   composer     → extra.composer (also: compositeur, komponist)
 *   arranger     → extra.arranger (also: harmonisation, arrangement)
 *   traditional  yes/no; yes → interpret "Traditional" (see --traditional-label)
 *
 * Matching: titles are compared ignoring case, accents, punctuation and a
 * leading article. A live song with the same normalized title is the same song.
 * A close title ("Sa compagne" / "Sa compagne c'est la mer") is only reported as
 * MAYBE and blocks a real run until each one is settled:
 *   --same "CSV title=Song title in the database"   same song, complete it
 *   --new  "CSV title"                              not that song, create it
 *
 * Usage:
 *   node scripts/import_setlist_csv.js --artist <slug> --setlist "<title>" <file.csv>
 *        [--dry-run] [--yes] [--same "a=b"]… [--new "title"]… [--traditional-label "Traditionnel"]
 *
 * Reads DATABASE_URL from .env.local or .env in the project root; asks before
 * connecting and shows the database host. Does not check the plan's song limit.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const lib  = require('./_lib');
const L    = require('./_setlist_csv');

function flags(args, name) {
  const out = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] !== undefined) out.push(args[i + 1]); });
  return out;
}

function usage() {
  console.error('Usage: node scripts/import_setlist_csv.js --artist <slug> --setlist "<title>" <file.csv> [--dry-run] [--yes] [--same "a=b"] [--new "title"] [--traditional-label "Traditional"]');
  process.exit(1);
}

async function main() {
  lib.loadEnv();
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const slug   = flags(args, '--artist')[0];
  const title  = flags(args, '--setlist')[0];
  const label  = flags(args, '--traditional-label')[0] || 'Traditional';
  const same   = L.parseSame(flags(args, '--same'));
  const forceNew = new Set(flags(args, '--new').map(L.normTitle));
  const valued = new Set(['--artist', '--setlist', '--same', '--new', '--traditional-label']);
  const file   = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  if (!slug || !title || !file) usage();
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  const { rows, errors } = L.parseRows(fs.readFileSync(path.resolve(file), 'utf8'));
  if (errors.length) { errors.forEach(e => console.error(`  ${e}`)); process.exit(1); }
  if (!rows.length) { console.error('  no songs in the file'); process.exit(1); }

  await lib.confirmDb(process.env.DATABASE_URL, { yes: args.includes('--yes'), question: `${dryRun ? 'Dry run' : 'Import'} here? (y/n): ` });
  const sql = lib.connect(process.env.DATABASE_URL);
  try {
    const [band] = await sql`SELECT id, config FROM artists WHERE slug = ${slug} LIMIT 1`;
    if (!band) { console.error(`  band "${slug}" not found`); process.exit(1); }
    const [taken] = await sql`SELECT id FROM setlists WHERE artist_id = ${band.id} AND title = ${title} LIMIT 1`;
    if (taken) { console.error(`  a setlist called "${title}" already exists (id ${taken.id}); nothing changed`); process.exit(1); }
    const songs = await sql`SELECT id, title, length_min, interpret, extra, deleted FROM songs WHERE artist_id = ${band.id}`;

    const plan = rows.map(row => {
      const c = L.classify(row, songs, same, forceNew);
      return { row, ...c, patch: c.kind === 'match' ? L.completion(c.song, row, label) : null };
    });

    for (const p of plan) {
      if (p.kind === 'match') {
        const what = p.patch ? 'UPDATE   ' + [p.patch.length_min != null && 'length', p.patch.interpret && 'interpret', ...Object.keys(p.patch.extra || {})].filter(Boolean).join(', ') : 'UNCHANGED';
        console.log(`  ${what.padEnd(9)} ${p.row.title}  →  #${p.song.id} ${p.song.title}`);
      } else if (p.kind === 'new') {
        console.log(`  NEW       ${p.row.title}`);
      } else {
        console.log(`  MAYBE     ${p.row.title}  ?  ${p.candidates.map(s => `#${s.id} ${s.title}${s.deleted ? ' (deleted)' : ''}`).join(' | ')}`);
      }
    }
    const count = k => plan.filter(p => p.kind === k).length;
    const fields = (band.config && band.config.songFields || []).map(f => f.field).filter(Boolean);
    console.log(`\n  ${count('match')} matched (${plan.filter(p => p.patch).length} to complete), ${count('new')} new, ${count('maybe')} to settle; setlist "${title}" with ${rows.length} songs`);
    console.log(`  custom song columns configured for this band: ${fields.join(', ') || '(none)'} — extra.author/composer/arranger show only where listed`);

    const open = plan.filter(p => p.kind === 'maybe');
    if (open.length) {
      console.log(`\n  ${open.length} title(s) need a decision: --same "CSV title=Song title" or --new "CSV title".`);
      if (!dryRun) { console.error('  nothing written'); process.exit(1); }
    }

    await sql.begin(async tx => {
      const updates = plan.filter(p => p.patch).map(p => ({
        id: p.song.id, length_min: p.patch.length_min ?? null, interpret: p.patch.interpret ?? null, extra: p.patch.extra ?? {},
      }));
      if (updates.length) {
        await tx`
          UPDATE songs s SET
            length_min = COALESCE(NULLIF(s.length_min, 0), v.length_min, s.length_min),
            interpret  = COALESCE(NULLIF(s.interpret, ''), v.interpret),
            extra      = s.extra || v.extra
          FROM jsonb_to_recordset(${tx.json(updates)}) AS v(id int, length_min real, interpret text, extra jsonb)
          WHERE s.id = v.id AND s.artist_id = ${band.id}`;
      }

      const news = plan.filter(p => p.kind === 'new').map((p, pos) => ({ pos, ...L.newSong(p.row, label) }));
      const created = news.length ? await tx`
        INSERT INTO songs (artist_id, title, length_min, interpret, extra)
        SELECT ${band.id}, v.title, v.length_min, v.interpret, v.extra
        FROM jsonb_to_recordset(${tx.json(news)}) AS v(pos int, title text, length_min real, interpret text, extra jsonb)
        ORDER BY v.pos
        RETURNING id, title` : [];
      const createdId = new Map(created.map(c => [c.title, c.id]));

      const ids = plan.filter(p => p.kind !== 'maybe').map(p => p.kind === 'match' ? p.song.id : createdId.get(p.row.title));
      // Only a dry run gets here with titles still to settle (a real run exits above).
      if (ids.length !== rows.length) throw new Error('dry run: rolled back, nothing written');
      const [sl] = await tx`
        WITH s AS (
          INSERT INTO setlists (artist_id, title) VALUES (${band.id}, ${title}) RETURNING id
        ), ins AS (
          INSERT INTO setlist_songs (setlist_id, song_id, position)
          SELECT s.id, u.song_id, u.ord - 1 FROM s, unnest(${ids}::int[]) WITH ORDINALITY AS u(song_id, ord)
        )
        SELECT id FROM s`;
      console.log(`\n  ${created.length} songs created, ${updates.length} completed, setlist #${sl.id} saved`);
      if (dryRun) throw new Error('dry run: rolled back, nothing written');
    });
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(`  ${e.message}`); process.exit(/dry run/.test(e.message) ? 0 : 1); });
