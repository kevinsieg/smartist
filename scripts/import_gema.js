#!/usr/bin/env node
/**
 * Band Tools — GEMA works importer
 *
 * Imports works and rightholders from GEMA CSV exports.
 * Accepts any combination of the three export files from the same batch:
 *   Identifikatoren-Table 1.csv   → gema_work_number, title, iswc, isrc       (→ gema_works)
 *   Werkinformationen-Table 1.csv → language, performers, genre, duration, dates (→ gema_works)
 *   Beteiligte-Table 1.csv        → name, role, AR/VR shares per rightholder   (→ gema_rightholders)
 *
 * Title matching (--ids / --info): auto-links each work to a song by matching
 * the GEMA title (uppercase) against songs.title (case-insensitive). Unmatched
 * works are imported with song_id = NULL for manual linking later.
 *
 * Rightholder import (--beteiligte): replace-all per work — existing rows for
 * affected works are deleted before re-inserting, so re-runs are idempotent.
 *
 * Usage:
 *   node scripts/import_gema.js --artist <slug> --ids <Identifikatoren.csv>
 *   node scripts/import_gema.js --artist <slug> --ids <...csv> --info <Werkinformationen.csv>
 *   node scripts/import_gema.js --artist <slug> --beteiligte <Beteiligte.csv>
 *   node scripts/import_gema.js --artist <slug> --ids <...csv> --info <...csv> --beteiligte <...csv>
 *   Add --dry-run to preview without writing.
 *
 * Reads DATABASE_URL from .env or .env.local in the project root.
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

function loadEnv(...files) {
  for (const file of files) {
    try {
      fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      });
    } catch {}
  }
}
const root = path.join(__dirname, '..');
loadEnv(path.join(root, '.env'), path.join(root, '.env.local'));

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(field.trim()); field = ''; }
    else { field += ch; }
  }
  fields.push(field.trim());
  return fields;
}

function parseCsv(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.startsWith('Werknummer'));
  if (headerIdx === -1) throw new Error('Header row (Werknummer,...) not found');
  const headers = parseCsvLine(lines[headerIdx]);
  return lines.slice(headerIdx + 1)
    .map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i] ?? ''])))
    .filter(r => r.Werknummer);
}

// ── Value normalisers ─────────────────────────────────────────────────────────

const LANG_MAP = { DEUTSCH: 'DE', ENGLISCH: 'EN', FRANZOESISCH: 'FR', FRANZÖSISCH: 'FR' };
const ROLE_MAP = {
  'KOMPONIST/-IN':  'composer',
  'TEXTDICHTER/-IN': 'lyricist',
  'ORIGINALVERLAG': 'publisher',
  'BEARBEITER/-IN': 'arranger',
  'SUB-VERLEGER':   'sub-publisher',
  'URHEBER/-IN':    'author',
};

function normLanguage(s) {
  return LANG_MAP[s?.toUpperCase()] ?? (s || null);
}

function normRole(s) {
  return ROLE_MAP[s?.toUpperCase()] ?? (s || null);
}

function parseShare(s) {
  if (!s || s === '-') return null;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseDuration(s) {
  // "HH:MM:SS" → seconds, "" or "-" → null
  if (!s || s === '-') return null;
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function parseGermanDate(s) {
  // "DD.MM.YYYY" → "YYYY-MM-DD", "" → null
  if (!s) return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── Beteiligte CSV parser ─────────────────────────────────────────────────────
// The Beteiligte export has two header rows: line 1 is a group-label row
// ("Angaben zur Werke-Produktion,,Beteiligte,..."), line 2 is the real header
// starting with "Werknummer". parseCsv() already skips to the Werknummer line.
//
// Columns 3 and 16 are both named "IP-Name-Nr." and columns 4 and 17 are both
// "Rolle" (Beteiligte vs. Vertritt sections), so we access by index rather than
// by the generic key-based map.

function parseBeteiligte(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.startsWith('Werknummer'));
  if (headerIdx === -1) throw new Error('Header row (Werknummer,...) not found in Beteiligte CSV');
  return lines.slice(headerIdx + 1)
    .map(line => {
      const f = parseCsvLine(line);
      if (!f[0]) return null;
      return {
        gema_work_number:    f[0],
        name:                f[2],
        ip_name_number:      f[3]  || null,
        role:                normRole(f[4]),
        role_order:          f[5]  || null,
        publisher_relation:  f[6]  || null,
        ar_share:            parseShare(f[7]),
        vr_share:            parseShare(f[8]),
        ar_share_cumulated:  parseShare(f[9]),
        vr_share_cumulated:  parseShare(f[10]),
        society_ar:          f[11] || null,
        society_vr:          f[12] || null,
        represents_name:     f[15] || null,
        represents_ip:       f[16] || null,
        represents_role:     normRole(f[17]),
      };
    })
    .filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const flag   = k => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : null; };

  // --artist like every other script; --band kept for old command lines.
  const slug           = flag('--artist') || flag('--band') || process.env.ARTIST_SLUG;
  const idsFile        = flag('--ids');
  const infoFile       = flag('--info');
  const beteiligteFile = flag('--beteiligte');

  if (!slug || (!idsFile && !infoFile && !beteiligteFile)) {
    console.error('Usage: node scripts/import_gema.js --artist <slug> [--ids <ids.csv>] [--info <info.csv>] [--beteiligte <beteiligte.csv>] [--dry-run]');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  await new Promise(resolve => {
    let host;
    try { host = new URL(process.env.DATABASE_URL).hostname; } catch { host = '(unknown)'; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n  database: ${host}`);
    rl.question('  Continue? (y/n): ', answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) { console.log('  Aborted.'); process.exit(0); }
      resolve();
    });
  });

  const sql  = neon(process.env.DATABASE_URL);
  const rows = await sql`SELECT id FROM artists WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length) { console.error(`Band "${slug}" not found`); process.exit(1); }
  const bandId = rows[0].id;

  // Build lookup: UPPERCASE_TITLE → song_id
  const songs  = await sql`SELECT id, title FROM songs WHERE artist_id = ${bandId} AND deleted = false`;
  const songMap = new Map(songs.map(s => [s.title.toUpperCase(), s.id]));

  // Parse CSVs
  const idsRows  = idsFile  ? parseCsv(fs.readFileSync(idsFile,  'utf8')) : [];
  const infoRows = infoFile ? parseCsv(fs.readFileSync(infoFile, 'utf8')) : [];

  // Index info rows by Werknummer for fast merge
  const infoByWork = new Map(infoRows.map(r => [r.Werknummer, r]));

  // Merge: start from ids if provided, else from info
  const workNumbers = idsFile
    ? idsRows.map(r => r.Werknummer)
    : infoRows.map(r => r.Werknummer);

  let matched = 0, unmatched = 0, errors = 0;

  for (const wn of workNumbers) {
    const id   = idsRows.find(r => r.Werknummer === wn);
    const info = infoByWork.get(wn);

    const title  = id?.Titel || info?.Titel || '';
    const songId = songMap.get(title) ?? null;
    if (songId) matched++; else unmatched++;

    const record = {
      artist_id:                bandId,
      gema_work_number:       wn,
      title,
      iswc:                   id?.ISWC                  || null,
      isrc:                   id?.ISRC                  || null,
      publisher_work_numbers: id?.Verlagswerknummern    || null,
      language:               normLanguage(info?.Sprache),
      performers:             info?.['Interpretinnen / Interpreten'] || null,
      gema_genre:             info?.Gattung              || null,
      duration_sec:           parseDuration(info?.Dauer),
      first_registered_at:    parseGermanDate(info?.['Erstmals geladen']),
      last_updated_at:        parseGermanDate(info?.['Letzte Aktualisierung']),
      song_id:                songId,
    };

    if (dryRun) {
      const performer = record.performers ? `  performer="${record.performers}"` : '';
      console.log(`[dry-run] ${wn} "${title}"  lang=${record.language ?? '—'}  ISWC=${record.iswc ?? '—'}${performer}  song_id=${songId ?? 'none'}`);
      continue;
    }

    try {
      await sql`
        INSERT INTO gema_works
          (artist_id, gema_work_number, title, iswc, isrc, publisher_work_numbers,
           language, performers, gema_genre, duration_sec, first_registered_at,
           last_updated_at, song_id)
        VALUES
          (${record.artist_id}, ${record.gema_work_number}, ${record.title},
           ${record.iswc}, ${record.isrc}, ${record.publisher_work_numbers},
           ${record.language}, ${record.performers}, ${record.gema_genre},
           ${record.duration_sec}, ${record.first_registered_at},
           ${record.last_updated_at}, ${record.song_id})
        ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
          title                  = EXCLUDED.title,
          iswc                   = COALESCE(EXCLUDED.iswc,                  gema_works.iswc),
          isrc                   = COALESCE(EXCLUDED.isrc,                  gema_works.isrc),
          publisher_work_numbers = COALESCE(EXCLUDED.publisher_work_numbers, gema_works.publisher_work_numbers),
          language               = COALESCE(EXCLUDED.language,              gema_works.language),
          performers             = COALESCE(EXCLUDED.performers,             gema_works.performers),
          gema_genre             = COALESCE(EXCLUDED.gema_genre,             gema_works.gema_genre),
          duration_sec           = COALESCE(EXCLUDED.duration_sec,           gema_works.duration_sec),
          first_registered_at    = COALESCE(EXCLUDED.first_registered_at,    gema_works.first_registered_at),
          last_updated_at        = COALESCE(EXCLUDED.last_updated_at,        gema_works.last_updated_at),
          song_id                = COALESCE(gema_works.song_id, EXCLUDED.song_id)
      `;
    } catch (err) {
      console.error(`  ERROR ${wn}: ${err.message}`);
      errors++;
    }
  }

  const total = workNumbers.length;
  if (dryRun) {
    console.log(`\n[dry-run] ${total} works — ${matched} matched to songs, ${unmatched} unmatched`);
  } else {
    console.log(`Imported ${total - errors}/${total} works — ${matched} auto-linked to songs, ${unmatched} unmatched, ${errors} errors`);
  }

  // ── Beteiligte import ─────────────────────────────────────────────────────
  if (!beteiligteFile) return;

  const bRows = parseBeteiligte(fs.readFileSync(beteiligteFile, 'utf8'));

  // Build work-number → gema_works.id map for this band
  const allWorkNums = [...new Set(bRows.map(r => r.gema_work_number))];
  const dbWorks = await sql`
    SELECT id, gema_work_number FROM gema_works
    WHERE artist_id = ${bandId} AND gema_work_number = ANY(${allWorkNums})
  `;
  const workIdMap = new Map(dbWorks.map(w => [w.gema_work_number, w.id]));

  const missing = allWorkNums.filter(wn => !workIdMap.has(wn));
  if (missing.length) {
    console.warn(`Warning: ${missing.length} work number(s) not in gema_works — run --ids first. First few: ${missing.slice(0, 5).join(', ')}`);
  }

  const linked = bRows.filter(r => workIdMap.has(r.gema_work_number));

  if (dryRun) {
    for (const r of linked) {
      console.log(`[dry-run] ${r.gema_work_number}  ${r.name} (${r.role ?? r.role})  AR=${r.ar_share ?? '—'}%  via ${r.society_ar ?? '—'}`);
    }
    console.log(`\n[dry-run] ${linked.length} rightholders across ${allWorkNums.length} works (${missing.length} not found)`);
    return;
  }

  // Replace-all: delete existing rightholders for affected works, then re-insert
  const affectedIds = [...new Set(linked.map(r => workIdMap.get(r.gema_work_number)))];
  await sql`DELETE FROM gema_rightholders WHERE gema_work_id = ANY(${affectedIds})`;

  let bInserted = 0, bErrors = 0;
  for (const r of linked) {
    try {
      await sql`
        INSERT INTO gema_rightholders
          (gema_work_id, name, ip_name_number, role, role_order, publisher_relation,
           ar_share, vr_share, ar_share_cumulated, vr_share_cumulated,
           society_ar, society_vr, represents_name, represents_ip, represents_role)
        VALUES
          (${workIdMap.get(r.gema_work_number)}, ${r.name}, ${r.ip_name_number}, ${r.role},
           ${r.role_order}, ${r.publisher_relation}, ${r.ar_share}, ${r.vr_share},
           ${r.ar_share_cumulated}, ${r.vr_share_cumulated}, ${r.society_ar}, ${r.society_vr},
           ${r.represents_name}, ${r.represents_ip}, ${r.represents_role})
      `;
      bInserted++;
    } catch (err) {
      console.error(`  ERROR rightholder ${r.gema_work_number} ${r.name}: ${err.message}`);
      bErrors++;
    }
  }

  console.log(`Imported ${bInserted}/${linked.length} rightholders across ${affectedIds.length} works — ${bErrors} errors`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
