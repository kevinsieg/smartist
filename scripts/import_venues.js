#!/usr/bin/env node
/**
 * Imports venues from a CSV file into the venues table.
 *
 * CSV columns: NOM LIEU, ADRESSE, CP, MAIL, TEL, REMARQUES
 *   ADRESSE is parsed into postcode (5-digit) + city. Street is not stored
 *   (no street column in venues). TEL and REMARQUES go into comment.
 *   Country is hardcoded to "France".
 *
 * Duplicate detection: fuzzy name match against existing venues for the artist.
 *   Prompts [s]kip / [i]nsert / [m]erge for each potential duplicate.
 *   Merge fills null fields in the existing row with incoming data.
 *
 * Usage:
 *   node scripts/import_venues.js --artist <slug> <file.csv>
 */

'use strict';

const { neon } = require('@neondatabase/serverless');
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
loadEnv(path.join(__dirname, '..', '.env.local'));

// ── Args ───────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const artistIdx = args.indexOf('--artist');

if (artistIdx === -1 || !args[artistIdx + 1]) {
  console.error('Usage: node scripts/import_venues.js --artist <slug> <file.csv>');
  process.exit(1);
}

const slug = args[artistIdx + 1];
const file = args.find((a, i) => i !== artistIdx && i !== artistIdx + 1);

if (!file) {
  console.error('No CSV file specified.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or export it.');
  process.exit(1);
}

// ── CSV parser ─────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(l => l.trim())) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        fields.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
}

// ── Address parsing ────────────────────────────────────────────────────────
// Handles multi-segment addresses like
// "Bassin de la Villette face au, 34 Quai de la Loire, 75019 Paris".
// Greedy match takes everything up to the last ", 5digits City".
// Street part is then split into street_number + street name.

function parseAddress(raw) {
  if (!raw?.trim()) return { street_number: null, street: null, postcode: null, city: null };

  let streetRaw = null, postcode = null, city = null;

  const m = raw.trim().match(/^(.*),\s*(\d{5})\s+(.+)$/);
  if (m) {
    streetRaw = m[1].trim() || null;
    postcode  = m[2];
    city      = m[3].trim();
  } else {
    streetRaw = raw.trim();
  }

  // Split "63 Rue Grande" → number "63", street "Rue Grande"
  // Handles formats like "63", "63B", "63 bis"
  let street_number = null, street = null;
  if (streetRaw) {
    const sm = streetRaw.match(/^(\d+\s*(?:bis|ter|quater|[A-Za-z])?)\s+(.+)$/i);
    if (sm) { street_number = sm[1].trim(); street = sm[2].trim(); }
    else street = streetRaw;
  }

  return { street_number, street, postcode, city };
}

// ── Duplicate detection ────────────────────────────────────────────────────

function normalizeName(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortWords(s) {
  return s.split(' ').filter(Boolean).sort().join(' ');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Soundex: English/French phonetic encoding. "Smith"/"Smyth"→S530, "Jon"/"John"→J500.
function soundex(word) {
  const TABLE = {b:1,f:1,p:1,v:1, c:2,g:2,j:2,k:2,q:2,s:2,x:2,z:2, d:3,t:3, l:4, m:5,n:5, r:6};
  const s = word.replace(/[^a-z]/g, '');
  if (!s) return '';
  let code = s[0].toUpperCase(), prev = TABLE[s[0]] || 0;
  for (let i = 1; i < s.length && code.length < 4; i++) {
    const c = TABLE[s[i]];
    if (c && c !== prev) code += c;
    if (s[i] !== 'h' && s[i] !== 'w') prev = c || 0;
  }
  return code.padEnd(4, '0');
}

// Cologne Phonetics (Kölner Phonetik): designed for German.
// Handles ä/ö/ü, ß, sch, tz, ph, etc.
// "Meyer"/"Meier"→07, "Schmidt"/"Schmitt"→863, "Müller"/"Mueller"→657.
function cologne(word) {
  const s = word.toUpperCase()
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U')
    .replace(/ß/g, 'SS').replace(/[^A-Z]/g, '');
  if (!s) return '';
  const raw = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], prev = s[i - 1] || '', next = s[i + 1] || '';
    let c;
    switch (ch) {
      case 'A': case 'E': case 'I': case 'J': case 'O': case 'U': case 'Y': c = '0'; break;
      case 'H':  c = '';  break;
      case 'B':  c = '1'; break;
      case 'P':  c = next === 'H' ? '3' : '1'; break;
      case 'D': case 'T': c = 'CSZ'.includes(next) ? '8' : '2'; break;
      case 'F': case 'V': case 'W': c = '3'; break;
      case 'G': case 'K': case 'Q': c = '4'; break;
      case 'C':
        if (i === 0) c = 'AHKLOQRUX'.includes(next) ? '4' : '8';
        else if ('SZ'.includes(prev)) c = '8';
        else c = 'AHKOQUX'.includes(next) ? '4' : '8';
        break;
      case 'X':  c = 'CKQ'.includes(prev) ? '8' : '48'; break;
      case 'L':  c = '5'; break;
      case 'M': case 'N': c = '6'; break;
      case 'R':  c = '7'; break;
      case 'S': case 'Z': c = '8'; break;
      default:   c = '';
    }
    if (c) raw.push(...c);
  }
  return raw
    .filter((c, i) => c !== raw[i - 1])     // remove consecutive duplicates
    .filter((c, i) => i === 0 || c !== '0') // remove non-leading zeros
    .join('');
}

const STOP_WORDS = new Set([
  // French
  'le','la','les','de','du','des','au','aux','l','d','et','en','a',
  // English
  'the','at','of',
  // German
  'der','die','das','dem','den','am','an','im','in','von','vor','zu','zum','zur','bei',
]);

// Returns both a Soundex key (EN/FR) and a Cologne key (DE) for a normalised name.
// Matching on either key counts as a phonetic hit.
function phoneticKeys(normedName) {
  const words = normedName.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));
  if (!words.length) return { sdx: '', col: '' };
  return {
    sdx: words.map(soundex).sort().join(' '),
    col: words.map(cologne).sort().join(' '),
  };
}

function isSimilar(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  const maxLen = Math.max(na.length, nb.length);
  const sa = sortWords(na), sb = sortWords(nb);
  const ka = phoneticKeys(na), kb = phoneticKeys(nb);
  return na === nb
    || sa === sb                               // same words, different order
    || (ka.sdx && ka.sdx === kb.sdx)           // Soundex match (EN/FR)
    || (ka.col && ka.col === kb.col)           // Cologne match (DE)
    || na.includes(nb) || nb.includes(na)
    || levenshtein(na, nb) / maxLen < 0.25
    || levenshtein(sa, sb) / maxLen < 0.25;
}

// ── Street abbreviation expansion ─────────────────────────────────────────
// Normalises before INSERT so stored data is consistent and future duplicate
// checks compare like for like.

const STREET_ABBREVS = [
  // French
  [/\bav\./gi,   'Avenue'],
  [/\bave\./gi,  'Avenue'],
  [/\bbd\./gi,   'Boulevard'],
  [/\bblvd\./gi, 'Boulevard'],
  [/\bbld\./gi,  'Boulevard'],
  [/\brte\./gi,  'Route'],
  [/\bpl\./gi,   'Place'],
  [/\bimp\./gi,  'Impasse'],
  [/\bchem\./gi, 'Chemin'],
  [/\ball\./gi,  'Allée'],
  [/\bsq\./gi,   'Square'],
  [/\bst\./gi,   'Saint'],
  [/\bste\./gi,  'Sainte'],
  [/\bdr\./gi,   'Docteur'],
  [/\bcol\./gi,  'Colonel'],
  [/\blt\./gi,   'Lieutenant'],
  [/\bgen\./gi,  'Général'],
  [/\bcdt\./gi,  'Commandant'],
  // German
  [/\bstr\./gi,     'Straße'],
  [/\bstrasse\b/gi, 'Straße'],  // normalise ASCII spelling
  [/\bhbf\./gi,     'Hauptbahnhof'],
  [/\bbhf\./gi,     'Bahnhof'],
  [/\bkfm\./gi,     'Kaufmann'],
  [/\bpfr\./gi,     'Pfarrer'],
  [/\bprof\./gi,    'Professor'],
  // NOTE: "Pl." is ambiguous — Place (FR) vs Platz (DE).
  // French rule above takes precedence. Revisit when language detection is added.
];

function expandStreetAbbrevs(s) {
  if (!s) return s;
  return STREET_ABBREVS.reduce((acc, [pat, rep]) => acc.replace(pat, rep), s);
}

// ── Interactive prompt ─────────────────────────────────────────────────────

let rl;
function ask(question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function pad(s, w) { return String(s ?? '').padEnd(w).slice(0, w); }

function showComparison(existing, incoming) {
  const fields = ['name', 'street_number', 'street', 'postcode', 'city', 'country', 'generic_email', 'comment'];
  const W = 36;
  console.log('');
  console.log(`  ${'Field'.padEnd(16)}  ${'Existing'.padEnd(W)}  Incoming`);
  console.log(`  ${'-'.repeat(16)}  ${'-'.repeat(W)}  ${'-'.repeat(W)}`);
  for (const f of fields) {
    const ev = String(existing[f] ?? ''), iv = String(incoming[f] ?? '');
    const mark = ev !== iv ? '*' : ' ';
    console.log(`${mark} ${f.padEnd(16)}  ${pad(ev, W)}  ${pad(iv, W)}`);
  }
  console.log('');
}

// ── DB prompt ─────────────────────────────────────────────────────────────

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  console.log(`\n  database: ${host}`);
  return ask('  Continue? (y/n): ').then(a => {
    if (!/^y/i.test(a)) { console.log('  Aborted.'); process.exit(0); }
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await confirmDb(process.env.DATABASE_URL);
  const sql = neon(process.env.DATABASE_URL);

  const [artist] = await sql`SELECT id FROM artists WHERE slug = ${slug} LIMIT 1`;
  if (!artist) {
    console.error(`Artist "${slug}" not found. Run setup.js first.`);
    rl.close(); process.exit(1);
  }

  // Load all existing (non-deleted) venues for this artist upfront
  const existing = await sql`
    SELECT id, name, street_number, street, postcode, city, country, generic_email, comment
    FROM venues
    WHERE artist_id = ${artist.id} AND deleted = false
  `;

  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  if (rows.length < 2) {
    console.error('CSV file has no data rows.');
    rl.close(); process.exit(1);
  }

  const header = rows[0].map(h => h.toUpperCase().trim());
  const col    = name => header.indexOf(name);

  const iName      = col('NOM LIEU');
  const iAdresse   = col('ADRESSE');
  const iMail      = col('MAIL');
  const iTel       = col('TEL');
  const iRemarques = col('REMARQUES');

  if (iName === -1) {
    console.error('Expected column "NOM LIEU" not found in CSV header.');
    rl.close(); process.exit(1);
  }

  let imported = 0, skipped = 0, merged = 0;

  for (const row of rows.slice(1)) {
    const name = row[iName]?.trim();
    if (!name) { skipped++; continue; }

    const parsed = parseAddress(iAdresse !== -1 ? row[iAdresse] : '');
    const { street_number, postcode, city } = parsed;
    const street = expandStreetAbbrevs(parsed.street);
    const mail    = iMail      !== -1 ? row[iMail]?.trim()      || null : null;
    const tel     = iTel       !== -1 ? row[iTel]?.trim()       || null : null;
    const remarks = iRemarques !== -1 ? row[iRemarques]?.trim() || null : null;

    const commentParts = [];
    if (tel)     commentParts.push(`Tel: ${tel}`);
    if (remarks) commentParts.push(remarks);
    const comment = commentParts.length ? commentParts.join('\n') : null;

    const incoming = { name, street_number, street, postcode, city, country: 'France', generic_email: mail, comment };

    // Duplicate check
    const match = existing.find(e => isSimilar(e.name, name));

    if (match) {
      console.log(`\n  Potential duplicate: "${name}" matches existing "${match.name}"`);
      showComparison(match, incoming);
      const answer = await ask('  [s]kip  [i]nsert anyway  [m]erge into existing  > ');

      if (/^s/i.test(answer)) {
        skipped++;
        continue;
      }

      if (/^m/i.test(answer)) {
        // Fill null fields in existing row with incoming values
        const updates = {};
        for (const [k, v] of Object.entries(incoming)) {
          if (k === 'name') continue;
          if (v !== null && (match[k] === null || match[k] === '')) updates[k] = v;
        }
        if (Object.keys(updates).length === 0) {
          console.log('  No new data to merge — keeping existing record as-is.');
        } else {
          console.log('  Merging fields:', Object.keys(updates).join(', '));
          await sql`
            UPDATE venues SET
              street_number = COALESCE(street_number, ${updates.street_number ?? null}),
              street        = COALESCE(street,        ${updates.street        ?? null}),
              postcode      = COALESCE(postcode,      ${updates.postcode      ?? null}),
              city          = COALESCE(city,          ${updates.city          ?? null}),
              country       = COALESCE(country,       ${updates.country       ?? null}),
              generic_email = COALESCE(generic_email, ${updates.generic_email ?? null}),
              comment       = COALESCE(comment,       ${updates.comment       ?? null}),
              last_updated  = NOW()
            WHERE id = ${match.id}
          `;
          merged++;
        }
        // Update local cache so subsequent rows can find merged state
        Object.assign(match, updates);
        continue;
      }

      // [i]nsert — fall through to insert below
    }

    await sql`
      INSERT INTO venues
        (artist_id, name, street_number, street, postcode, city, country, generic_email, comment)
      VALUES
        (${artist.id}, ${name}, ${street_number}, ${street}, ${postcode}, ${city}, ${'France'}, ${mail}, ${comment})
    `;

    existing.push({ id: null, ...incoming });
    imported++;
  }

  rl.close();
  console.log(`\nDone — ${imported} inserted, ${merged} merged, ${skipped} skipped.`);
})().catch(e => { console.error(e.message); rl?.close(); process.exit(1); });
