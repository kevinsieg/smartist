const { getDb, getSlug } = require('../../_db');
const { requireAuth, getAccess, canOpenStage, canBrowseCatalogue } = require('../../_auth');
const { wrap } = require('../../_handler');
const { clientIp } = require('../../_ratelimit');
const { MEDIA_CONFIGS, makeMediaFn } = require('../../_media');
const { suggestLyrics } = require('../../_lyrics');
const { GEMA_ROLE_TYPES } = require('../../_constants');
const { validateStr } = require('../../_validate');
const logger = require('../../_logger');
const { energyToScale } = require('../../_song_values');
const { requireFeature } = require('../../_plans');
const { songDetail, cleanLyrics, writeLyrics } = require('../../_domain/songs');

// ── GEMA import helpers (merged from gema/import.js) ─────────────────────────
// Matches the logic in scripts/import_gema.js — keep in sync if either changes.

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

// Beteiligte has two header rows; parseCsv() already skips to the Werknummer line.
// Duplicate column names (IP-Name-Nr., Rolle) are resolved by index.
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

function parseDuration(s) {
  if (!s || s === '-') return null;
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function parseGermanDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const MEDIA = {
  audio:    makeMediaFn(MEDIA_CONFIGS.audio),
  sheet:    makeMediaFn(MEDIA_CONFIGS.sheet),
  playback: makeMediaFn(MEDIA_CONFIGS.playback),
};

module.exports = wrap(async function handler(req, res) {
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/songs/')[1]?.split('/') ?? [];
  let rawId  = pathParts[0];
  let action = pathParts[1];
  let arrId  = Number(pathParts[2]);
  let arrSub = pathParts[3]; // 'activate' or undefined

  // vercel dev: multi-segment paths fail on catch-alls; vercel.json rewrites flatten them
  if (rawId === 'arrangements' && req.query.songId) {
    rawId  = req.query.songId;
    action = 'arrangements';
    arrId  = Number(req.query.arrId) || 0;
    arrSub = req.query.sub;
  }
  if (rawId === 'gema' && req.query.songId) {
    rawId  = req.query.songId;
    action = 'gema';
  }
  // vercel dev: single-segment sub-routes also need flattening rewrites
  if (req.query.songId && ['audio', 'sheet', 'playback', 'setlists', 'restore'].includes(rawId)) {
    action = rawId;
    rawId  = req.query.songId;
  }
  const slug = getSlug(req);


  // ── GEMA import (merged from gema/import.js via vercel.json rewrite) ──────
  if (rawId === 'gema-import') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!requireFeature(res, band, 'pro-import')) return;

    const { type, csv, dryRun = false, ownerIpNameNumber } = req.body || {};

    if (!type || !['info', 'ids', 'beteiligte'].includes(type))
      return res.status(400).json({ error: 'type must be "info", "ids", or "beteiligte"' });
    if (typeof csv !== 'string' || csv.length < 10)
      return res.status(400).json({ error: 'csv must be a non-empty string' });
    if (csv.length > 5_000_000)
      return res.status(400).json({ error: 'CSV too large (max 5 MB)' });

    const sql = getDb();

    // ── Werkinformationen / Identifikatoren (info / ids) ──────────────────────
    if (type === 'info' || type === 'ids') {
      let csvRows;
      try { csvRows = parseCsv(csv); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      if (!csvRows.length) return res.status(400).json({ error: 'No data rows found in CSV' });

      // Identify which works in the CSV are "own compositions" — i.e. the owner's
      // IP-Name-Nr appears as composer or lyricist in the rightholders table.
      // ownerIpNr can come from the request (typed into the UI) or from bands.config.
      const ownerIpNr = ownerIpNameNumber || band.config?.gemaIpNameNumber || null;
      const workNums = csvRows.map(r => r.Werknummer);
      // The three lookups are independent: one round-trip.
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

      const ownWorkNums = new Set(); // gema_work_number values where owner is composer/lyricist
      // Index by both exact and base number (strip -NNN version suffix) for robustness
      for (const { gema_work_number: wn } of owned) {
        ownWorkNums.add(wn);
        ownWorkNums.add(wn.replace(/-\d+$/, ''));
      }
      const existingSet = new Set(existing.map(w => w.gema_work_number));

      const rows = [];
      const records = new Map(); // work number → DB record; a repeated number keeps the last row
      let matchedExact = 0, matchedNorm = 0, ownUnmatched = 0, otherProject = 0, newCount = 0, errors = 0;

      for (const r of csvRows) {
        const title = r.Titel || '';
        const isNew = !existingSet.has(r.Werknummer);
        if (isNew) newCount++;

        // Resolve song link: exact → normalised → null
        const exactId  = songMapExact.get(title.toUpperCase());
        const normId   = exactId === undefined ? songMapNorm.get(normalizeTitle(title)) : undefined;
        const songId   = exactId ?? normId ?? null;
        const matchedBy = exactId !== undefined ? 'exact' : normId !== undefined ? 'normalized' : null;

        const csvBase   = r.Werknummer.replace(/-\d+$/, '');
        const isOwnWork = ownerIpNr
          ? (ownWorkNums.has(r.Werknummer) || ownWorkNums.has(csvBase))
          : null;

        if (matchedBy === 'exact')           matchedExact++;
        else if (matchedBy === 'normalized') matchedNorm++;
        else {
          if (isOwnWork)              ownUnmatched++;
          else if (isOwnWork === false) otherProject++;
        }

        const row = {
          gema_work_number: r.Werknummer,
          title,
          matchedSong: songId ? (songById.get(songId) ?? null) : null,
          matchedBy,
          isOwnWork,
          isNew,
          // info fields
          language:    normLanguage(r.Sprache) ?? null,
          durationSec: parseDuration(r.Dauer),
          // ids fields
          iswc: r.ISWC || null,
          isrc: r.ISRC || null,
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
        const upsert = (db, recs) => (type === 'info' ? db`
          INSERT INTO gema_works
            (artist_id, gema_work_number, title, language, performers, gema_genre,
             duration_sec, first_registered_at, last_updated_at, song_id)
          SELECT ${band.id}, v.gema_work_number, v.title, v.language, v.performers, v.gema_genre,
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
        ` : db`
          INSERT INTO gema_works
            (artist_id, gema_work_number, title, iswc, isrc, publisher_work_numbers, song_id)
          SELECT ${band.id}, v.gema_work_number, v.title, v.iswc, v.isrc, v.publisher_work_numbers, v.song_id
          FROM jsonb_to_recordset(${sql.json(recs)}) AS v(
            gema_work_number text, title text, iswc text, isrc text,
            publisher_work_numbers text, song_id int)
          ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
            title                  = EXCLUDED.title,
            iswc                   = COALESCE(EXCLUDED.iswc,                   gema_works.iswc),
            isrc                   = COALESCE(EXCLUDED.isrc,                   gema_works.isrc),
            publisher_work_numbers = COALESCE(EXCLUDED.publisher_work_numbers,  gema_works.publisher_work_numbers),
            song_id                = COALESCE(gema_works.song_id, EXCLUDED.song_id)
        `);
        // One statement for the whole file. Only if that fails are the rows
        // retried one by one, so the preview can say which row was at fault.
        try {
          await upsert(sql, [...records.values()].map(x => x.rec));
        } catch (batchErr) {
          await logger.warn('gema_import_batch_failed', { artistId: band.id, type, error: batchErr.message });
          for (const { row, rec } of records.values()) {
            try { await upsert(sql, [rec]); }
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
        ownUnmatched: ownerIpNr ? ownUnmatched  : null,
        otherProject: ownerIpNr ? otherProject  : null,
        unmatched:    csvRows.length - matched,
        new:          newCount,
        existing:     existingSet.size,
        errors,
      };
      await logger.info('gema_import', { artistId: band.id, type, dryRun, ...summary });
      return res.json({ dryRun, type, rows, summary });
    }

    // ── Beteiligte ─────────────────────────────────────────────────────────────
    let bRows;
    try { bRows = parseBeteiligte(csv); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!bRows.length) return res.status(400).json({ error: 'No data rows found in CSV' });

    // Load all works for this band and build two lookup maps:
    //   exact:    "15299392-001" → work (primary)
    //   base:     "15299392"     → work (fallback — GEMA versioning may differ between exports)
    // The base-number strip removes the trailing "-NNN" version suffix.
    // Existing rightholder counts come with the same query.
    const allDbWorks = await sql`
      SELECT w.id, w.gema_work_number, w.title,
             (SELECT count(*)::int FROM gema_rightholders r WHERE r.gema_work_id = w.id) AS rightholders
      FROM gema_works w WHERE w.artist_id = ${band.id}
    `;
    const workByExact = new Map(allDbWorks.map(w => [w.gema_work_number, w]));
    const workByBase  = new Map(allDbWorks.map(w => [w.gema_work_number.replace(/-\d+$/, ''), w]));
    const findWork = wn => workByExact.get(wn) ?? workByBase.get(wn.replace(/-\d+$/, ''));

    // Group rightholders by work number and resolve each to a DB work
    const byWork = new Map();
    for (const r of bRows) {
      if (!byWork.has(r.gema_work_number)) byWork.set(r.gema_work_number, []);
      byWork.get(r.gema_work_number).push(r);
    }

    const rows = [];
    const writes = new Map(); // db work id → { rows: [preview rows], rightholders }
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
        // Include names for preview so the user can spot wrong data
        rightholders: rightholders.map(r => ({ name: r.name, role: r.role, ar_share: r.ar_share, society_ar: r.society_ar })),
      };
      rows.push(row);
      if (found) {
        // Two CSV numbers can resolve to the same work (exact and base match):
        // the later one replaces the earlier, as the per-work loop did.
        writes.set(work.id, { preview: [...(writes.get(work.id)?.preview ?? []), row], rightholders });
      }
    }

    if (!dryRun && writes.size) {
      // Replace-all per work: delete the old rightholders and insert the new
      // ones in one transaction, so a failure never leaves a work empty.
      const replace = (ids, recs) => sql.begin(async tx => {
        await tx`DELETE FROM gema_rightholders WHERE gema_work_id = ANY(${ids}::int[])`;
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
      const recsOf = (id, list) => list.map(r => ({ ...r, gema_work_id: id }));
      try {
        await replace([...writes.keys()], [...writes.entries()].flatMap(([id, w]) => recsOf(id, w.rightholders)));
      } catch (batchErr) {
        await logger.warn('gema_import_batch_failed', { artistId: band.id, type, error: batchErr.message });
        for (const [id, w] of writes.entries()) {
          try { await replace([id], recsOf(id, w.rightholders)); }
          catch (err) {
            await logger.error('gema_import_row_error', { artistId: band.id, type, workNumber: w.preview[0].gema_work_number, error: err.message });
            for (const row of w.preview) row.error = err.message;
            errors++;
          }
        }
      }
    }

    const summary = {
      total:            bRows.length,
      worksFound,
      worksMissing,
      rightholderCount: bRows.length,
      errors,
    };
    await logger.info('gema_import', { artistId: band.id, type, dryRun, ...summary });
    return res.json({ dryRun, type, rows, summary });
  }

  const songId = Number(rawId);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  // ── Media (audio, sheet, playback) ────────────────────────────────────────
  if (action in MEDIA) {
    req.query.id = rawId;
    return MEDIA[action](req, res);
  }

  // ── GET /api/:artist/songs/:id/arrangements ───────────────────────────────
  // Public — no auth required; arrangements are read-only display data (used by stage view)
  if (action === 'arrangements' && !arrId && req.method === 'GET') {
    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // Stage reads this for the active chart, and a public catalogue shows it.
    if (!user && !canOpenStage(band) && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });
    const sql = getDb();
    const [[song], arrangements] = await Promise.all([
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`,
      sql`
        SELECT id, name, is_active, hidden_instruments, rows, created_at, updated_at
        FROM song_arrangements
        WHERE song_id = ${songId} AND artist_id = ${band.id}
        ORDER BY created_at ASC
      `,
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.json(arrangements);
  }

  // ── POST /api/:artist/songs/:id/arrangements — create version ─────────────
  if (action === 'arrangements' && !arrId && req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const sql = getDb();
    const { rows = [], hidden_instruments = [], copy_from } = req.body ?? {};
    const [[song], [src]] = await Promise.all([
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`,
      copy_from
        ? sql`SELECT rows, hidden_instruments FROM song_arrangements WHERE id = ${Number(copy_from)} AND song_id = ${songId} AND artist_id = ${band.id}`
        : [],
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    const rawName = req.body?.name;
    const name = rawName === undefined ? 'Default' : (validateStr(rawName, 200) || 'Default');
    let sourceRows = rows;
    let sourceHidden = hidden_instruments;
    if (copy_from) {
      if (!src) return res.status(400).json({ error: 'copy_from arrangement not found' });
      sourceRows = src.rows;
      sourceHidden = src.hidden_instruments;
    }
    const [created] = await sql`
      INSERT INTO song_arrangements (song_id, artist_id, name, rows, hidden_instruments)
      VALUES (${songId}, ${band.id}, ${name}, ${sql.json(sourceRows)}::jsonb, ${sql.json(sourceHidden)}::jsonb)
      RETURNING *
    `;
    return res.status(201).json(created);
  }

  // ── PUT /api/:artist/songs/:id/arrangements/:arrId — update ───────────────
  if (action === 'arrangements' && arrId && !arrSub && req.method === 'PUT') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const { name, rows, hidden_instruments } = req.body ?? {};
    const updates = {};
    if (name !== undefined) {
      const validatedName = validateStr(name, 200);
      if (validatedName === false) return res.status(400).json({ error: 'name too long' });
      if (validatedName) updates.name = validatedName;
    }
    if (rows !== undefined)               updates.rows               = sql.json(rows);
    if (hidden_instruments !== undefined) updates.hidden_instruments = sql.json(hidden_instruments);
    if (!Object.keys(updates).length)     return res.status(400).json({ error: 'Nothing to update' });
    const [updated] = await sql`
      UPDATE song_arrangements
      SET
        name               = COALESCE(${updates.name               ?? null}, name),
        rows               = COALESCE(${updates.rows               ?? null}::jsonb, rows),
        hidden_instruments = COALESCE(${updates.hidden_instruments ?? null}::jsonb, hidden_instruments),
        updated_at         = NOW()
      WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
      RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Arrangement not found' });
    return res.json(updated);
  }


  // ── POST /api/:artist/songs/:id/arrangements/:arrId/activate ─────────────
  // Deactivate the others, then activate this one — two statements in that
  // order, because at most one version per song may be active (unique index).
  // Pipelined in one transaction; the first touches nothing unless the target
  // exists, so an unknown id changes nothing.
  if (action === 'arrangements' && arrId && arrSub === 'activate' && req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const [, [updated]] = await sql.begin(tx => [
      tx`
        UPDATE song_arrangements SET is_active = false
        WHERE song_id = ${songId} AND artist_id = ${band.id} AND is_active AND id <> ${arrId}
          AND EXISTS (SELECT 1 FROM song_arrangements
                      WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id})
      `,
      tx`
        UPDATE song_arrangements SET is_active = true, updated_at = NOW()
        WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
        RETURNING *
      `,
    ]);
    if (!updated) return res.status(404).json({ error: 'Arrangement not found' });
    return res.json(updated);
  }

  // ── DELETE /api/:artist/songs/:id/arrangements/:arrId ─────────────────────
  if (action === 'arrangements' && arrId && !arrSub && req.method === 'DELETE') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    if (!Number.isInteger(arrId) || arrId <= 0) return res.status(400).json({ error: 'Invalid arrangement id' });
    const sql = getDb();
    const [arr] = await sql`
      DELETE FROM song_arrangements WHERE id = ${arrId} AND song_id = ${songId} AND artist_id = ${band.id}
      RETURNING id
    `;
    if (!arr) return res.status(404).json({ error: 'Arrangement not found' });
    return res.status(204).end();
  }

  // ── GET single song (song details, stage view); includes lyrics and arrangements
  if (!action && req.method === 'GET') {
    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // One song by id: what a stage link opens, and what a public catalogue
    // lists. The song list itself is gated separately in songs.js.
    if (!user && !canOpenStage(band) && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });
    const sql = getDb();
    const [song, arrangements] = await Promise.all([
      songDetail(sql, band.id, songId),
      sql`
        SELECT id, name, is_active, updated_at
        FROM song_arrangements
        WHERE song_id = ${songId} AND artist_id = ${band.id}
        ORDER BY created_at ASC
      `,
    ]);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    // A visitor without a session never sees the band's private notes.
    if (!user) delete song.comment;
    return res.json({ ...song, arrangements });
  }

  // ── DELETE song ───────────────────────────────────────────────────────────
  // Soft delete: the row, its lyrics and its arrangements stay, so a restore
  // brings all of it back. Flag and audit entry in one statement.
  if (!action) {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    const sql = getDb();
    const [song] = await sql`
      WITH s AS (
        UPDATE songs SET deleted = true
        WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'delete', to_jsonb(s) FROM s
      )
      SELECT id FROM s
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.status(204).end();
  }

  // ── POST restore ──────────────────────────────────────────────────────────
  if (action === 'restore') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    const sql = getDb();
    // The common case — the row is still there, flagged — is one statement:
    // clear the flag and log it, if a delete record exists.
    const [restored] = await sql`
      WITH s AS (
        UPDATE songs SET deleted = false
        WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = true
          AND EXISTS (SELECT 1 FROM song_logs
                      WHERE song_id = ${songId} AND artist_id = ${band.id} AND action = 'delete')
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'create', to_jsonb(s) FROM s
      )
      SELECT * FROM s
    `;
    if (restored) return res.status(201).json(restored);

    // The row is gone (hard-deleted before soft delete existed): rebuild it
    // from the last delete snapshot — unless the song is live, when there is
    // nothing to restore.
    const [[log], [live]] = await Promise.all([
      sql`
        SELECT song_data FROM song_logs
        WHERE song_id = ${songId} AND artist_id = ${band.id} AND action = 'delete'
        ORDER BY changed_at DESC
        LIMIT 1
      `,
      sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id}`,
    ]);
    if (!log) return res.status(404).json({ error: 'No delete record found for this song' });
    if (live) return res.status(409).json({ error: 'Song is not deleted' });
    const d = log.song_data;
    const [song] = await sql`
      WITH s AS (
        INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                           bpm, length_min, interpret, reference_interpret, comment, language, extra)
        VALUES (${band.id}, ${d.title}, ${d.active ?? true}, ${d.heart ?? false}, ${d.key ?? null},
                ${d.genre ?? null}, ${energyToScale(d.energy ?? d.tempo) ?? null}, ${d.time_signature ?? null},
                ${d.bpm ?? null}, ${d.length_min ?? null},
                ${d.interpret ?? null}, ${d.reference_interpret ?? null},
                ${d.comment ?? null}, ${d.language ?? d.extra?.language ?? null},
                ${(({ lyrics: _l, language: _g, ...rest }) => rest)(d.extra ?? {})})
        RETURNING *
      ), logged AS (
        INSERT INTO song_logs (artist_id, song_id, action, song_data)
        SELECT artist_id, id, 'create', to_jsonb(s) FROM s
      )
      SELECT * FROM s
    `;
    return res.status(201).json(song);
  }

  // ── GET setlist appearances ───────────────────────────────────────────────
  if (action === 'setlists') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // Which setlists a song appears in — gig history for that song.
    if (!user && !canBrowseCatalogue(band))
      return res.status(401).json({ error: 'Sign in to view this' });

    const sql = getDb();
    const setlists = await sql`
      SELECT sl.id, sl.title, sl.comment, sl.created_at,
             g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      LEFT JOIN gigs g ON sl.gig_id = g.id AND g.artist_id = sl.artist_id
      LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
      WHERE ss.song_id = ${songId} AND sl.artist_id = ${band.id}
      ORDER BY sl.created_at DESC
    `;
    return res.json(setlists);
  }

  // ── GET GEMA data ─────────────────────────────────────────────────────────
  if (action === 'gema') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { artist: band, user } = await getAccess(req, slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    // GEMA registration data is rights administration, never public.
    if (!user)
      return res.status(401).json({ error: 'Sign in to view this' });

    const sql = getDb();
    const [works, rightholders] = await Promise.all([
      sql`
        SELECT * FROM gema_works
        WHERE artist_id = ${band.id} AND song_id = ${songId}
        ORDER BY gema_work_number
      `,
      sql`
        SELECT r.*, g.gema_work_number
        FROM gema_rightholders r
        JOIN gema_works g ON g.id = r.gema_work_id
        WHERE g.artist_id = ${band.id} AND g.song_id = ${songId}
        ORDER BY g.gema_work_number, r.role, r.role_order NULLS LAST, r.name
      `,
    ]);
    return res.json({ works, rightholders });
  }


  // ── PUT/DELETE lyrics (body-dispatched POSTs in songs.js do the same) ─────
  if (action === 'lyrics') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const sql = getDb();

    if (req.method === 'PUT') {
      if (typeof req.body?.lyrics !== 'string')
        return res.status(400).json({ error: 'lyrics must be a string' });
      const lyrics = cleanLyrics(req.body.lyrics);
      if (lyrics.error) return res.status(400).json({ error: lyrics.error });
      const song = await writeLyrics(sql, band.id, songId, lyrics.value);
      if (!song) return res.status(404).json({ error: 'Song not found' });
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const song = await writeLyrics(sql, band.id, songId, null, 'lyrics_delete');
      if (!song) return res.status(404).json({ error: 'Song not found' });
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── POST lyrics-suggest ───────────────────────────────────────────────────
  if (action === 'lyrics-suggest') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const result = await suggestLyrics(getDb(), band, songId, clientIp(req));
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: 'Not found' });
});

module.exports._test = {
  parseCsvLine,
  parseCsv,
  parseBeteiligte,
  normalizeTitle,
  normLanguage,
  normRole,
  parseShare,
  parseDuration,
  parseGermanDate,
};
