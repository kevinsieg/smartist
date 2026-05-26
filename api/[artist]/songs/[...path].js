const { getDb, getArtist, insertAuditLog, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { checkRateLimit, clientIp } = require('../../_ratelimit');
const { suggestLyricsWithAI } = require('../../_ai');
const { makeMediaFn } = require('../../_media');
const { LYRICS_SOURCES, plainFromSynced } = require('../../_lyrics');
const logger = require('../../_logger');

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
  audio:    makeMediaFn({ keyPrefix: 'audio/',    extraKey: 'listenUrl',   maxBytes: 50*1024*1024, actionPrefix: 'audio',    allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' }),
  sheet:    makeMediaFn({ keyPrefix: 'sheets/',   extraKey: 'sheetUrl',    maxBytes: 20*1024*1024, actionPrefix: 'sheet',    mimePrefix: 'application/pdf' }),
  playback: makeMediaFn({ keyPrefix: 'playback/', extraKey: 'playbackUrl', maxBytes: 50*1024*1024, actionPrefix: 'playback', allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' }),
};

module.exports = wrap(async function handler(req, res) {
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/songs/')[1]?.split('/') ?? [];
  const [rawId, action] = pathParts;
  const slug = getSlug(req);

  // ── GEMA import (merged from gema/import.js via vercel.json rewrite) ──────
  if (rawId === 'gema-import') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

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

      const songs = await sql`SELECT id, title FROM songs WHERE artist_id = ${band.id} AND deleted = false`;
      // Two-pass title matching:
      //   1. exact uppercase — handles mixed-case song titles
      //   2. normalised     — ASCII-folds German umlauts so "Ü" == "UE", strips punctuation
      const songMapExact = new Map(songs.map(s => [s.title.toUpperCase(), s.id]));
      const songMapNorm  = new Map(songs.map(s => [normalizeTitle(s.title), s.id]));
      const songById     = new Map(songs.map(s => [s.id, s.title]));

      // Identify which works in the CSV are "own compositions" — i.e. the owner's
      // IP-Name-Nr appears as composer or lyricist in the rightholders table.
      // ownerIpNr can come from the request (typed into the UI) or from bands.config.
      const ownerIpNr = ownerIpNameNumber || band.config?.gemaIpNameNumber || null;
      let ownWorkNums = new Set(); // gema_work_number values where owner is composer/lyricist
      if (ownerIpNr) {
        const owned = await sql`
          SELECT DISTINCT gw.gema_work_number
          FROM gema_rightholders gr
          JOIN gema_works gw ON gw.id = gr.gema_work_id
          WHERE gw.artist_id = ${band.id}
            AND gr.ip_name_number = ${String(ownerIpNr)}
            AND gr.role IN ('composer', 'lyricist', 'author')
        `;
        // Index by both exact and base number (strip -NNN version suffix) for robustness
        for (const { gema_work_number: wn } of owned) {
          ownWorkNums.add(wn);
          ownWorkNums.add(wn.replace(/-\d+$/, ''));
        }
      }

      const workNums = csvRows.map(r => r.Werknummer);
      const existing = await sql`
        SELECT gema_work_number FROM gema_works
        WHERE artist_id = ${band.id} AND gema_work_number = ANY(${workNums})
      `;
      const existingSet = new Set(existing.map(w => w.gema_work_number));

      const rows = [];
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

        if (!dryRun) {
          try {
            if (type === 'info') {
              await sql`
                INSERT INTO gema_works
                  (artist_id, gema_work_number, title, language, performers, gema_genre,
                   duration_sec, first_registered_at, last_updated_at, song_id)
                VALUES
                  (${band.id}, ${r.Werknummer}, ${title},
                   ${row.language},
                   ${r['Interpretinnen / Interpreten'] || null},
                   ${r.Gattung || null},
                   ${row.durationSec},
                   ${parseGermanDate(r['Erstmals geladen'])},
                   ${parseGermanDate(r['Letzte Aktualisierung'])},
                   ${songId})
                ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
                  title               = EXCLUDED.title,
                  language            = COALESCE(EXCLUDED.language,           gema_works.language),
                  performers          = COALESCE(EXCLUDED.performers,          gema_works.performers),
                  gema_genre          = COALESCE(EXCLUDED.gema_genre,          gema_works.gema_genre),
                  duration_sec        = COALESCE(EXCLUDED.duration_sec,        gema_works.duration_sec),
                  first_registered_at = COALESCE(EXCLUDED.first_registered_at, gema_works.first_registered_at),
                  last_updated_at     = COALESCE(EXCLUDED.last_updated_at,     gema_works.last_updated_at),
                  song_id             = COALESCE(gema_works.song_id, EXCLUDED.song_id)
              `;
            } else {
              await sql`
                INSERT INTO gema_works
                  (artist_id, gema_work_number, title, iswc, isrc, publisher_work_numbers, song_id)
                VALUES
                  (${band.id}, ${r.Werknummer}, ${title},
                   ${row.iswc}, ${row.isrc},
                   ${r.Verlagswerknummern || null},
                   ${songId})
                ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
                  title                  = EXCLUDED.title,
                  iswc                   = COALESCE(EXCLUDED.iswc,                   gema_works.iswc),
                  isrc                   = COALESCE(EXCLUDED.isrc,                   gema_works.isrc),
                  publisher_work_numbers = COALESCE(EXCLUDED.publisher_work_numbers,  gema_works.publisher_work_numbers),
                  song_id                = COALESCE(gema_works.song_id, EXCLUDED.song_id)
              `;
            }
          } catch (err) {
            await logger.error('gema_import_row_error', { artistId: band.id, type, workNumber: r.Werknummer, error: err.message });
            row.error = err.message;
            errors++;
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
    const allDbWorks = await sql`
      SELECT id, gema_work_number, title FROM gema_works WHERE artist_id = ${band.id}
    `;
    const workByExact = new Map(allDbWorks.map(w => [w.gema_work_number, w]));
    const workByBase  = new Map(allDbWorks.map(w => [w.gema_work_number.replace(/-\d+$/, ''), w]));
    const findWork = wn => workByExact.get(wn) ?? workByBase.get(wn.replace(/-\d+$/, ''));

    const workMap = new Map(); // csv work number → db work

    // Group rightholders by work number and resolve each to a DB work
    const byWork = new Map();
    for (const r of bRows) {
      if (!byWork.has(r.gema_work_number)) byWork.set(r.gema_work_number, []);
      byWork.get(r.gema_work_number).push(r);
    }
    for (const wn of byWork.keys()) {
      const w = findWork(wn);
      if (w) workMap.set(wn, w);
    }

    // Count existing rightholders per resolved work for the preview
    const resolvedWorkIds = [...new Set([...workMap.values()].map(w => w.id))];
    const existingCounts = resolvedWorkIds.length ? await sql`
      SELECT gema_work_id, count(*)::int AS count FROM gema_rightholders
      WHERE gema_work_id = ANY(${resolvedWorkIds})
      GROUP BY gema_work_id
    ` : [];
    const existingCountMap = new Map(existingCounts.map(r => [r.gema_work_id, r.count]));

    const rows = [];
    let worksFound = 0, worksMissing = 0, errors = 0;

    for (const [wn, rightholders] of byWork.entries()) {
      const work  = workMap.get(wn);
      const found = !!work;
      if (found) worksFound++; else worksMissing++;

      const existingCount = work ? (existingCountMap.get(work.id) ?? 0) : 0;
      const row = {
        gema_work_number: wn,
        title:            work?.title ?? '(not in database — run Werkinformationen import first)',
        found,
        rightholderCount: rightholders.length,
        existingCount,
        // Include names for preview so the user can spot wrong data
        rightholders: rightholders.map(r => ({ name: r.name, role: r.role, ar_share: r.ar_share, society_ar: r.society_ar })),
      };
      rows.push(row);

      if (!dryRun && found) {
        try {
          await sql`DELETE FROM gema_rightholders WHERE gema_work_id = ${work.id}`;
          for (const r of rightholders) {
            await sql`
              INSERT INTO gema_rightholders
                (gema_work_id, name, ip_name_number, role, role_order, publisher_relation,
                 ar_share, vr_share, ar_share_cumulated, vr_share_cumulated,
                 society_ar, society_vr, represents_name, represents_ip, represents_role)
              VALUES
                (${work.id}, ${r.name}, ${r.ip_name_number}, ${r.role}, ${r.role_order},
                 ${r.publisher_relation}, ${r.ar_share}, ${r.vr_share},
                 ${r.ar_share_cumulated}, ${r.vr_share_cumulated},
                 ${r.society_ar}, ${r.society_vr},
                 ${r.represents_name}, ${r.represents_ip}, ${r.represents_role})
            `;
          }
        } catch (err) {
          await logger.error('gema_import_row_error', { artistId: band.id, type, workNumber: wn, error: err.message });
          row.error = err.message;
          errors++;
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

  // ── GET single song (used by stage view) ─────────────────────────────────
  if (!action && req.method === 'GET') {
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const sql = getDb();
    const [song] = await sql`
      SELECT s.*,
        g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works WHERE song_id = s.id ORDER BY gema_work_number LIMIT 1
      ) g ON true
      WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND s.deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });
    return res.json(song);
  }

  // ── DELETE song ───────────────────────────────────────────────────────────
  if (!action) {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
    const [song] = await sql`
      UPDATE songs SET deleted = true
      WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
      RETURNING *
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await insertAuditLog(sql, band.id, songId, 'delete', song);
    return res.status(204).end();
  }

  // ── POST restore ──────────────────────────────────────────────────────────
  if (action === 'restore') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
    const [log] = await sql`
      SELECT * FROM song_logs
      WHERE song_id = ${songId} AND artist_id = ${band.id} AND action = 'delete'
      ORDER BY changed_at DESC
      LIMIT 1
    `;
    if (!log) return res.status(404).json({ error: 'No delete record found for this song' });

    let song;
    const [existing] = await sql`
      SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = true
    `;
    if (existing) {
      [song] = await sql`
        UPDATE songs SET deleted = false
        WHERE id = ${songId} AND artist_id = ${band.id}
        RETURNING *
      `;
    } else {
      const d = log.song_data;
      [song] = await sql`
        INSERT INTO songs (artist_id, title, active, key, genre, tempo, length_min,
                           interpret, reference_interpret, comment, extra)
        VALUES (${band.id}, ${d.title}, ${d.active ?? true}, ${d.key ?? null},
                ${d.genre ?? null}, ${d.tempo ?? null}, ${d.length_min ?? null},
                ${d.interpret ?? null}, ${d.reference_interpret ?? null},
                ${d.comment ?? null}, ${d.extra ?? {}})
        RETURNING *
      `;
    }

    await insertAuditLog(sql, band.id, song.id, 'create', song);
    return res.status(201).json(song);
  }

  // ── GET setlist appearances ───────────────────────────────────────────────
  if (action === 'setlists') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const sql = getDb();
    const setlists = await sql`
      SELECT sl.id, sl.title, sl.comment, sl.created_at,
             g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      LEFT JOIN gigs g ON sl.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      WHERE ss.song_id = ${songId} AND sl.artist_id = ${band.id}
      ORDER BY sl.created_at DESC
    `;
    return res.json(setlists);
  }

  // ── GET GEMA data ─────────────────────────────────────────────────────────
  if (action === 'gema') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const sql = getDb();
    const works = await sql`
      SELECT * FROM gema_works
      WHERE artist_id = ${band.id} AND song_id = ${songId}
      ORDER BY gema_work_number
    `;
    if (!works.length) return res.json({ works: [], rightholders: [] });

    const workIds = works.map(w => w.id);
    const rightholders = await sql`
      SELECT r.*, g.gema_work_number
      FROM gema_rightholders r
      JOIN gema_works g ON g.id = r.gema_work_id
      WHERE r.gema_work_id = ANY(${workIds})
      ORDER BY g.gema_work_number, r.role, r.role_order NULLS LAST, r.name
    `;
    return res.json({ works, rightholders });
  }

  // ── PUT/DELETE lyrics ─────────────────────────────────────────────────────
  if (action === 'lyrics') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();

    if (req.method === 'PUT') {
      const { lyrics } = req.body ?? {};
      if (typeof lyrics !== 'string')
        return res.status(400).json({ error: 'lyrics must be a string' });
      if (lyrics.length > 20000)
        return res.status(400).json({ error: 'Lyrics too long (max 20 000 characters)' });

      const lyricsVal = lyrics.trim() || null;
      const [song] = await sql`
        UPDATE songs SET extra = extra || ${{ lyrics: lyricsVal }}
        WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
        RETURNING id, title
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      await insertAuditLog(sql, band.id, song.id, 'lyrics_update', { title: song.title });
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const [song] = await sql`
        SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      await sql`UPDATE songs SET extra = extra - 'lyrics' WHERE id = ${songId} AND artist_id = ${band.id}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── POST lyrics-suggest ───────────────────────────────────────────────────
  if (action === 'lyrics-suggest') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
    const [song] = await sql`
      SELECT s.title, s.interpret, s.reference_interpret,
        COALESCE(g.language, s.extra->>'language') AS language,
        g.gema_genre AS genre
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT language, gema_genre FROM gema_works
        WHERE song_id = s.id ORDER BY gema_work_number LIMIT 1
      ) g ON true
      WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND s.deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const artist = song.reference_interpret || song.interpret;
    if (!artist) return res.status(400).json({ error: 'No artist on this song — cannot search for lyrics' });

    if (await checkRateLimit(`lyrics-suggest:${band.id}:${songId}`, 3, 300))
      return res.status(429).json({ error: 'Too many requests — wait a few minutes' });
    if (await checkRateLimit(`lyrics-suggest-ip:${clientIp(req)}`, 10, 3600))
      return res.status(429).json({ error: 'Too many requests — try again later' });

    const title    = song.title.replace(/\b\w/g, c => c.toUpperCase());
    const language = song.language || null;
    const genre    = song.genre    || null;
    const ctx      = { artistId: band.id, songId, title, artist, language, genre };
    const found    = (lyrics, source) => res.json({ lyrics, source, sources: LYRICS_SOURCES });
    const miss     = (aiSkipped = false) => res.json({ lyrics: null, sources: LYRICS_SOURCES, aiSkipped });

    try {
      const r = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const data = await r.json();
        if (data.lyrics?.length > 50) {
          await logger.info('lyrics_suggest', { ...ctx, source: 'lyrics.ovh' });
          return found(data.lyrics.trim(), 'lyrics.ovh');
        }
      }
      await logger.info('lyrics_suggest_miss', { ...ctx, source: 'lyrics.ovh', status: r.status });
    } catch (e) {
      await logger.warn('lyrics_suggest_error', { ...ctx, source: 'lyrics.ovh', error: e.message });
    }

    try {
      const r = await fetch(
        `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
        { headers: { 'Lrclib-Client': 'smartist-band-tools' }, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const data   = await r.json();
        const lyrics = data.plainLyrics || plainFromSynced(data.syncedLyrics);
        if (lyrics?.length > 50) {
          await logger.info('lyrics_suggest', { ...ctx, source: 'lrclib' });
          return found(lyrics.trim(), 'lrclib');
        }
      }
      await logger.info('lyrics_suggest_miss', { ...ctx, source: 'lrclib', status: r.status });
    } catch (e) {
      await logger.warn('lyrics_suggest_error', { ...ctx, source: 'lrclib', error: e.message });
    }

    const { lyrics, skipped } = await suggestLyricsWithAI(title, artist, { language, genre });
    if (lyrics) {
      await logger.info('lyrics_suggest', { ...ctx, source: 'ai' });
      return found(lyrics, 'ai');
    }

    await logger.info('lyrics_suggest_miss', { ...ctx, source: 'ai', skipped: skipped ?? false });
    return miss(skipped ?? false);
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
