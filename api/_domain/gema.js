'use strict';

// GEMA CSV import: parsers for the three export files and the two imports
// (works from Identifikatoren / Werkinformationen, rightholders from
// Beteiligte). Used by the pro-import page (songs catch-all, gema-import) and
// by scripts/import_gema.js, so both read the files the same way.
//
// The imports take a postgres.js `sql` and return { status, body }.

const { GEMA_ROLE_TYPES } = require('../_constants');
const logger = require('../_logger');

// ── CSV parsing ───────────────────────────────────────────────────────────────

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
  if (headerIdx === -1) throw new Error('Header row "Werknummer,..." not found — wrong file type?');
  const headers = parseCsvLine(lines[headerIdx]);
  return lines.slice(headerIdx + 1)
    .map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i] ?? ''])))
    .filter(r => r.Werknummer);
}

// Beteiligte has two header rows (a group-label row, then the real header
// starting with "Werknummer"). Columns 3 and 16 are both "IP-Name-Nr." and 4
// and 17 both "Rolle" (Beteiligte vs. Vertritt), so fields are read by index.
function parseBeteiligte(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.startsWith('Werknummer'));
  if (headerIdx === -1) throw new Error('Header row "Werknummer,..." not found — wrong file type?');
  return lines.slice(headerIdx + 1)
    .map(line => {
      const f = parseCsvLine(line);
      if (!f[0]) return null;
      return {
        gema_work_number:   f[0],
        name:               f[2],
        ip_name_number:     f[3]  || null,
        role:               normRole(f[4]),
        role_order:         f[5]  || null,
        publisher_relation: f[6]  || null,
        ar_share:           parseShare(f[7]),
        vr_share:           parseShare(f[8]),
        ar_share_cumulated: parseShare(f[9]),
        vr_share_cumulated: parseShare(f[10]),
        society_ar:         f[11] || null,
        society_vr:         f[12] || null,
        represents_name:    f[15] || null,
        represents_ip:      f[16] || null,
        represents_role:    normRole(f[17]),
      };
    })
    .filter(Boolean);
}

// ── Title normalisation for fuzzy matching ────────────────────────────────────
// GEMA exports use ASCII equivalents of German characters (Ü→UE, Ö→OE, Ä→AE, ß→SS).
// Song titles in the DB may use the actual Unicode characters.
// Normalise both sides to plain uppercase ASCII so they compare equal.
function normalizeTitle(t) {
  return t
    .toUpperCase()
    .replace(/Ü/g, 'UE').replace(/Ö/g, 'OE').replace(/Ä/g, 'AE').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Value normalisers ─────────────────────────────────────────────────────────

const LANG_MAP = { DEUTSCH: 'DE', ENGLISCH: 'EN', FRANZOESISCH: 'FR', FRANZÖSISCH: 'FR' };
const ROLE_MAP = {
  'KOMPONIST/-IN':   'composer',
  'TEXTDICHTER/-IN': 'lyricist',
  'ORIGINALVERLAG':  'publisher',
  'BEARBEITER/-IN':  'arranger',
  'SUB-VERLEGER':    'sub-publisher',
  'URHEBER/-IN':     'author',
};

function normLanguage(s) { return LANG_MAP[s?.toUpperCase()] ?? (s || null); }
function normRole(s)     { return ROLE_MAP[s?.toUpperCase()] ?? (s || null); }

function parseShare(s) {
  if (!s || s === '-') return null;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

// "HH:MM:SS" or "MM:SS" → seconds; "" or "-" → null
function parseDuration(s) {
  if (!s || s === '-') return null;
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// "DD.MM.YYYY" → "YYYY-MM-DD"
function parseGermanDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const fail = (status, error) => ({ status, body: { error } });
const baseNumber = wn => wn.replace(/-\d+$/, '');

// ── Works (Identifikatoren = 'ids', Werkinformationen = 'info') ────────────────

function upsertWorks(sql, artistId, type, recs) {
  return type === 'info' ? sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, language, performers, gema_genre,
       duration_sec, first_registered_at, last_updated_at, song_id)
    SELECT ${artistId}, v.gema_work_number, v.title, v.language, v.performers, v.gema_genre,
           v.duration_sec, v.first_registered_at, v.last_updated_at, v.song_id
    FROM jsonb_to_recordset(${sql.json(recs)}) AS v(
      gema_work_number text, title text, language text, performers text, gema_genre text,
      duration_sec int, first_registered_at date, last_updated_at date, song_id int)
    ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
      title               = EXCLUDED.title,
      language            = COALESCE(EXCLUDED.language,           gema_works.language),
      performers          = COALESCE(EXCLUDED.performers,          gema_works.performers),
      gema_genre          = COALESCE(EXCLUDED.gema_genre,          gema_works.gema_genre),
      duration_sec        = COALESCE(EXCLUDED.duration_sec,        gema_works.duration_sec),
      first_registered_at = COALESCE(EXCLUDED.first_registered_at, gema_works.first_registered_at),
      last_updated_at     = COALESCE(EXCLUDED.last_updated_at,     gema_works.last_updated_at),
      song_id             = COALESCE(gema_works.song_id, EXCLUDED.song_id)
  ` : sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, iswc, isrc, publisher_work_numbers, song_id)
    SELECT ${artistId}, v.gema_work_number, v.title, v.iswc, v.isrc, v.publisher_work_numbers, v.song_id
    FROM jsonb_to_recordset(${sql.json(recs)}) AS v(
      gema_work_number text, title text, iswc text, isrc text,
      publisher_work_numbers text, song_id int)
    ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
      title                  = EXCLUDED.title,
      iswc                   = COALESCE(EXCLUDED.iswc,                   gema_works.iswc),
      isrc                   = COALESCE(EXCLUDED.isrc,                   gema_works.isrc),
      publisher_work_numbers = COALESCE(EXCLUDED.publisher_work_numbers,  gema_works.publisher_work_numbers),
      song_id                = COALESCE(gema_works.song_id, EXCLUDED.song_id)
  `;
}

async function importWorks(sql, band, type, csv, { dryRun = false, ownerIpNameNumber = null } = {}) {
  let csvRows;
  try { csvRows = parseCsv(csv); }
  catch (e) { return fail(400, e.message); }
  if (!csvRows.length) return fail(400, 'No data rows found in CSV');

  // "Own compositions": works where the owner's IP-Name-Nr appears as composer
  // or lyricist. It comes from the request (typed in the UI) or band config.
  const ownerIpNr = ownerIpNameNumber || band.config?.gemaIpNameNumber || null;
  const workNums = csvRows.map(r => r.Werknummer);
  const [songs, owned, existing] = await Promise.all([
    sql`SELECT id, title FROM songs WHERE artist_id = ${band.id} AND deleted = false`,
    ownerIpNr ? sql`
      SELECT DISTINCT gw.gema_work_number
      FROM gema_rightholders gr
      JOIN gema_works gw ON gw.id = gr.gema_work_id
      WHERE gw.artist_id = ${band.id}
        AND gr.ip_name_number = ${String(ownerIpNr)}
        AND gr.role = ANY(${GEMA_ROLE_TYPES})
    ` : [],
    sql`
      SELECT gema_work_number FROM gema_works
      WHERE artist_id = ${band.id} AND gema_work_number = ANY(${workNums})
    `,
  ]);
  // Two-pass title matching:
  //   1. exact uppercase — handles mixed-case song titles
  //   2. normalised     — ASCII-folds German umlauts so "Ü" == "UE", strips punctuation
  const songMapExact = new Map(songs.map(s => [s.title.toUpperCase(), s.id]));
  const songMapNorm  = new Map(songs.map(s => [normalizeTitle(s.title), s.id]));
  const songById     = new Map(songs.map(s => [s.id, s.title]));

  // Indexed by exact and base number (version suffix stripped) for robustness.
  const ownWorkNums = new Set();
  for (const { gema_work_number: wn } of owned) { ownWorkNums.add(wn); ownWorkNums.add(baseNumber(wn)); }
  const existingSet = new Set(existing.map(w => w.gema_work_number));

  const rows = [];
  const records = new Map(); // work number → DB record; a repeated number keeps the last row
  let matchedExact = 0, matchedNorm = 0, ownUnmatched = 0, otherProject = 0, newCount = 0, errors = 0;

  for (const r of csvRows) {
    const title = r.Titel || '';
    const isNew = !existingSet.has(r.Werknummer);
    if (isNew) newCount++;

    const exactId   = songMapExact.get(title.toUpperCase());
    const normId    = exactId === undefined ? songMapNorm.get(normalizeTitle(title)) : undefined;
    const songId    = exactId ?? normId ?? null;
    const matchedBy = exactId !== undefined ? 'exact' : normId !== undefined ? 'normalized' : null;
    const isOwnWork = ownerIpNr
      ? (ownWorkNums.has(r.Werknummer) || ownWorkNums.has(baseNumber(r.Werknummer)))
      : null;

    if (matchedBy === 'exact')           matchedExact++;
    else if (matchedBy === 'normalized') matchedNorm++;
    else if (isOwnWork)                  ownUnmatched++;
    else if (isOwnWork === false)        otherProject++;

    const row = {
      gema_work_number: r.Werknummer,
      title,
      matchedSong: songId ? (songById.get(songId) ?? null) : null,
      matchedBy,
      isOwnWork,
      isNew,
      language:    normLanguage(r.Sprache) ?? null,   // info
      durationSec: parseDuration(r.Dauer),            // info
      iswc: r.ISWC || null,                           // ids
      isrc: r.ISRC || null,                           // ids
    };
    rows.push(row);
    records.set(r.Werknummer, {
      row,
      rec: type === 'info'
        ? {
            gema_work_number:    r.Werknummer,
            title,
            language:            row.language,
            performers:          r['Interpretinnen / Interpreten'] || null,
            gema_genre:          r.Gattung || null,
            duration_sec:        row.durationSec,
            first_registered_at: parseGermanDate(r['Erstmals geladen']),
            last_updated_at:     parseGermanDate(r['Letzte Aktualisierung']),
            song_id:             songId,
          }
        : {
            gema_work_number:       r.Werknummer,
            title,
            iswc:                   row.iswc,
            isrc:                   row.isrc,
            publisher_work_numbers: r.Verlagswerknummern || null,
            song_id:                songId,
          },
    });
  }

  if (!dryRun && records.size) {
    // One statement for the whole file. Only if that fails are the rows
    // retried one by one, so the preview can say which row was at fault.
    try {
      await upsertWorks(sql, band.id, type, [...records.values()].map(x => x.rec));
    } catch (batchErr) {
      await logger.warn('gema_import_batch_failed', { artistId: band.id, type, error: batchErr.message });
      for (const { row, rec } of records.values()) {
        try { await upsertWorks(sql, band.id, type, [rec]); }
        catch (err) {
          await logger.error('gema_import_row_error', { artistId: band.id, type, workNumber: rec.gema_work_number, error: err.message });
          row.error = err.message;
          errors++;
        }
      }
    }
  }

  const matched = matchedExact + matchedNorm;
  const summary = {
    total:        csvRows.length,
    matched,
    matchedExact,
    matchedNorm,
    ownUnmatched: ownerIpNr ? ownUnmatched : null,
    otherProject: ownerIpNr ? otherProject : null,
    unmatched:    csvRows.length - matched,
    new:          newCount,
    existing:     existingSet.size,
    errors,
  };
  await logger.info('gema_import', { artistId: band.id, type, dryRun, ...summary });
  return { status: 200, body: { dryRun, type, rows, summary } };
}

// ── Rightholders (Beteiligte) ─────────────────────────────────────────────────

// Replace-all for the given works: delete the old rightholders and insert the
// new ones in one transaction, so a failure never leaves a work empty.
function replaceRightholders(sql, workIds, recs) {
  return sql.begin(async tx => {
    await tx`DELETE FROM gema_rightholders WHERE gema_work_id = ANY(${workIds}::int[])`;
    if (recs.length) await tx`
      INSERT INTO gema_rightholders
        (gema_work_id, name, ip_name_number, role, role_order, publisher_relation,
         ar_share, vr_share, ar_share_cumulated, vr_share_cumulated,
         society_ar, society_vr, represents_name, represents_ip, represents_role)
      SELECT v.gema_work_id, v.name, v.ip_name_number, v.role, v.role_order, v.publisher_relation,
             v.ar_share, v.vr_share, v.ar_share_cumulated, v.vr_share_cumulated,
             v.society_ar, v.society_vr, v.represents_name, v.represents_ip, v.represents_role
      FROM jsonb_to_recordset(${sql.json(recs)}) AS v(
        gema_work_id int, name text, ip_name_number text, role text, role_order text,
        publisher_relation text, ar_share numeric, vr_share numeric,
        ar_share_cumulated numeric, vr_share_cumulated numeric,
        society_ar text, society_vr text, represents_name text, represents_ip text,
        represents_role text)
    `;
  });
}

async function importRightholders(sql, band, csv, { dryRun = false } = {}) {
  const type = 'beteiligte';
  let bRows;
  try { bRows = parseBeteiligte(csv); }
  catch (e) { return fail(400, e.message); }
  if (!bRows.length) return fail(400, 'No data rows found in CSV');

  // All of the band's works, matched by exact number first and base number
  // (GEMA versioning may differ between exports) second; existing
  // rightholder counts come with the same query.
  const allDbWorks = await sql`
    SELECT w.id, w.gema_work_number, w.title,
           (SELECT count(*)::int FROM gema_rightholders r WHERE r.gema_work_id = w.id) AS rightholders
    FROM gema_works w WHERE w.artist_id = ${band.id}
  `;
  const workByExact = new Map(allDbWorks.map(w => [w.gema_work_number, w]));
  const workByBase  = new Map(allDbWorks.map(w => [baseNumber(w.gema_work_number), w]));
  const findWork = wn => workByExact.get(wn) ?? workByBase.get(baseNumber(wn));

  const byWork = new Map();
  for (const r of bRows) {
    if (!byWork.has(r.gema_work_number)) byWork.set(r.gema_work_number, []);
    byWork.get(r.gema_work_number).push(r);
  }

  const rows = [];
  const writes = new Map(); // db work id → { preview: [rows], rightholders }
  let worksFound = 0, worksMissing = 0, errors = 0;

  for (const [wn, rightholders] of byWork.entries()) {
    const work  = findWork(wn);
    const found = !!work;
    if (found) worksFound++; else worksMissing++;

    const row = {
      gema_work_number: wn,
      title:            work?.title ?? '(not in database — run Werkinformationen import first)',
      found,
      rightholderCount: rightholders.length,
      existingCount:    work ? work.rightholders : 0,
      // Names in the preview so the user can spot wrong data.
      rightholders: rightholders.map(r => ({ name: r.name, role: r.role, ar_share: r.ar_share, society_ar: r.society_ar })),
    };
    rows.push(row);
    // Two CSV numbers can resolve to the same work (exact and base match):
    // the later one replaces the earlier.
    if (found) writes.set(work.id, { preview: [...(writes.get(work.id)?.preview ?? []), row], rightholders });
  }

  if (!dryRun && writes.size) {
    const recsOf = (id, list) => list.map(r => ({ ...r, gema_work_id: id }));
    try {
      await replaceRightholders(sql, [...writes.keys()], [...writes.entries()].flatMap(([id, w]) => recsOf(id, w.rightholders)));
    } catch (batchErr) {
      await logger.warn('gema_import_batch_failed', { artistId: band.id, type, error: batchErr.message });
      for (const [id, w] of writes.entries()) {
        try { await replaceRightholders(sql, [id], recsOf(id, w.rightholders)); }
        catch (err) {
          await logger.error('gema_import_row_error', { artistId: band.id, type, workNumber: w.preview[0].gema_work_number, error: err.message });
          for (const row of w.preview) row.error = err.message;
          errors++;
        }
      }
    }
  }

  const summary = { total: bRows.length, worksFound, worksMissing, rightholderCount: bRows.length, errors };
  await logger.info('gema_import', { artistId: band.id, type, dryRun, ...summary });
  return { status: 200, body: { dryRun, type, rows, summary } };
}

module.exports = {
  parseCsvLine, parseCsv, parseBeteiligte, normalizeTitle, normLanguage, normRole,
  parseShare, parseDuration, parseGermanDate, importWorks, importRightholders,
};
