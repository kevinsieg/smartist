#!/usr/bin/env node
/**
 * Artist Tools — Setup Wizard
 *
 * Guides through first-time setup or artist reconfiguration:
 *   1. Verify (and optionally apply) the database schema
 *   2. Create a new artist or update an existing one
 *   3. Configure display fields, filter fields, and logo
 *   4. Review and save
 *
 * Usage:
 *   node scripts/setup.js
 *   DATABASE_URL=<url> node scripts/setup.js
 *
 * Reads DATABASE_URL from .env.local in the project root if not set.
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const bcrypt     = require('bcryptjs');
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

loadEnv(path.join(__dirname, '..', '.env.local'));
loadEnv(path.join(__dirname, '.env.local'));

// ── Print helpers ──────────────────────────────────────────────────────────

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);

function header(n, total, title) {
  console.log(`\n${B(`Step ${n}/${total} — ${title}`)}`);
  console.log(D('─'.repeat(44)));
}

// ── Readline / prompt helpers ──────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt, hint = '') {
  const suffix = hint ? ` ${D(`[${hint}]`)}` : '';
  return new Promise(resolve =>
    rl.question(`  ${prompt}${suffix}: `, answer => resolve(answer.trim()))
  );
}

async function confirm(prompt) {
  const answer = await ask(`${prompt} (y/n)`);
  return /^y/i.test(answer);
}

async function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  console.log(`\n  ${D('database:')} ${B(host)}`);
  if (!await confirm('Connect to this database?')) {
    console.log(D('\n  Aborted.\n'));
    process.exit(0);
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function schemaApplied(sql) {
  try {
    await sql`SELECT 1 FROM artists LIMIT 0`;
    return true;
  } catch {
    return false;
  }
}

async function applySchema(sql) {
  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // Strip comment lines, split on semicolons, drop empty fragments
  const statements = src
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    try {
      await sql([stmt]); // neon HTTP: tagged template with raw string, no params
    } catch (e) {
      if (e.message.toLowerCase().includes('already exists')) continue;
      throw e;
    }
  }
}

// ── Standard field definitions ─────────────────────────────────────────────
//
// `required` fields are always included in displayFields.
// Numbered fields are optional; their display number equals their array index
// (since the required field is index 0 and shown separately with *).

const STANDARD_FIELDS = [
  { field: 'title',               label: 'Song',           required: true },
  { field: 'key',                 label: 'Key' },
  { field: 'genre',            label: 'Genre' },
  { field: 'tempo',               label: 'Tempo' },
  { field: 'length_min',          label: 'Length' },
  { field: 'interpret',           label: 'Interpret' },
  { field: 'reference_interpret', label: 'Ref. interpret' },
  { field: 'comment',             label: 'Comment' },
];

// ── Step 1 — Schema ────────────────────────────────────────────────────────

async function stepSchema(sql) {
  header(1, 4, 'Database schema');

  if (await schemaApplied(sql)) {
    ok('Schema already applied');
    return;
  }

  warn('No schema found in the database.');
  if (!await confirm('Apply schema.sql now?')) {
    console.log(Y('\n  Run manually:  psql $DATABASE_URL < scripts/schema.sql'));
    console.log(Y('  Then re-run this wizard.\n'));
    process.exit(0);
  }

  process.stdout.write('  Applying schema.sql...');
  try {
    await applySchema(sql);
    console.log(` ${G('done')}`);
  } catch (e) {
    console.log(` ${R('failed')}\n`);
    console.error(`  ${R(e.message)}`);
    console.log(Y('\n  Fallback: psql $DATABASE_URL < scripts/schema.sql\n'));
    process.exit(1);
  }
}

// ── Step 2 — Artist ────────────────────────────────────────────────────────

async function stepArtist(sql) {
  header(2, 4, 'Artist');

  const existing = await sql`SELECT id, slug, name, config FROM artists ORDER BY name`;

  let artist = null;
  let isNew = true;

  if (existing.length) {
    console.log('\n  Existing artists:');
    existing.forEach(b => console.log(`    · ${B(b.name)} ${D(`(${b.slug})`)}`));
    console.log('');
    const choice = await ask('Create a new artist or reconfigure existing? (new / slug)');

    if (choice !== 'new') {
      artist = existing.find(b => b.slug === choice);
      if (!artist) {
        console.log(R(`\n  Artist "${choice}" not found.`));
        process.exit(1);
      }
      isNew = false;
    }
  }

  if (isNew) {
    console.log('');
    const slug = await ask('Slug', 'myartist');
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      console.log(R('\n  Invalid slug — use lowercase letters, digits, hyphens, underscores.'));
      process.exit(1);
    }
    const [taken] = await sql`SELECT 1 FROM artists WHERE slug = ${slug}`;
    if (taken) {
      console.log(R(`\n  Slug "${slug}" is already in use.`));
      process.exit(1);
    }

    const name = await ask('Artist name');
    if (!name) { console.log(R('\n  Artist name is required.')); process.exit(1); }

    const password = await ask('Password');
    if (password.length < 6) { console.log(R('\n  Password must be at least 6 characters.')); process.exit(1); }
    const confirm2 = await ask('Confirm password');
    if (password !== confirm2) { console.log(R('\n  Passwords do not match.')); process.exit(1); }

    const hash = await bcrypt.hash(password, 10);
    const [created] = await sql`
      INSERT INTO artists (slug, name, password_hash, config)
      VALUES (${slug}, ${name}, ${hash}, ${{}}::jsonb)
      RETURNING id, slug, name, config
    `;
    artist = created;
    ok(`Artist ${B(name)} created`);
  } else {
    ok(`Selected: ${B(artist.name)} ${D(`(${artist.slug})`)}`);
    if (artist.config && Object.keys(artist.config).length) {
      warn('This artist already has a config — it will be replaced by the new one.');
      if (!await confirm('Continue?')) { process.exit(0); }
    }
  }

  return artist;
}

// ── Step 3 — Fields ────────────────────────────────────────────────────────

async function stepFields() {
  header(3, 4, 'Song fields');
  const optional = STANDARD_FIELDS.filter(f => !f.required);

  // ── Display fields ──────────────────────────────────────────────────────

  console.log(`\n  ${B('Display fields')} — columns shown in the songs table`);
  console.log(`  ${D('* title — Song (always included)')}`);
  optional.forEach((f, i) =>
    console.log(`  ${D(`  ${i + 1}.`)} ${f.field.padEnd(22)} ${D(f.label)}`)
  );
  console.log('');

  const displayRaw = await ask('Include standard fields by number, or "all"', 'all');
  let displayFields = [{ field: 'title', label: 'Song' }];

  if (displayRaw.toLowerCase() === 'all') {
    displayFields = STANDARD_FIELDS.map(f => ({ field: f.field, label: f.label }));
  } else {
    const nums = displayRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1);
    const picked = [...new Set(nums)].map(n => optional[n - 1]).filter(Boolean);
    displayFields.push(...picked.map(f => ({ field: f.field, label: f.label })));
  }

  // ── Custom extra fields ─────────────────────────────────────────────────

  const extraFields = [];
  console.log(`\n  ${B('Custom (extra) fields')} — artist-specific data stored in JSONB`);
  console.log(`  ${D('Format:  fieldName : Label : type')}`);
  console.log(`  ${D('Types:   text (default) | integer | boolean')}`);
  console.log(`  ${D('Example: lead:Lead Singer:text   or   capo:Capo:integer')}`);
  console.log('');

  while (true) {
    const input = await ask('Add extra field (blank to finish)');
    if (!input) break;
    const [rawName, rawLabel, rawType = 'text'] = input.split(':').map(s => s.trim());
    if (!rawName || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(rawName)) {
      console.log(R('    Field name must start with a letter and contain only letters, digits, underscores.'));
      continue;
    }
    const type = rawType.toLowerCase();
    if (!['text', 'integer', 'boolean'].includes(type)) {
      console.log(R('    Unknown type — use text, integer, or boolean.'));
      continue;
    }
    const label = rawLabel || rawName;
    const fieldPath = `extra.${rawName}`;
    extraFields.push({ field: fieldPath, label, type });
    displayFields.push({ field: fieldPath, label });
    ok(`Added ${fieldPath} — ${label} (${type})`);
  }

  // ── Filter fields ───────────────────────────────────────────────────────

  const filterable = [
    ...displayFields.filter(f => f.field !== 'title' && !f.field.startsWith('extra.')),
    ...extraFields,
  ];

  console.log(`\n  ${B('Filter fields')} — buttons shown in the setlist generator`);
  if (filterable.length) {
    console.log(`  ${D('Available: ' + filterable.map(f => f.field).join(', '))}`);
  }
  console.log('');

  const filterRaw = await ask('Filter fields, comma-separated (blank for none)');
  const filterFields = filterRaw
    ? filterRaw.split(',').map(s => s.trim()).filter(Boolean).flatMap(name => {
        const f = filterable.find(f => f.field === name);
        if (!f) { console.log(Y(`    Skipping unknown field: ${name}`)); return []; }
        return [{ field: f.field, label: f.label, ...(f.type ? { type: f.type } : {}) }];
      })
    : [];

  // ── Logo ─────────────────────────────────────────────────────────────────

  console.log('');
  const logoUrl = await ask('Logo URL or path', '/img/band-logo.png') || '/img/band-logo.png';

  return { displayFields, filterFields, logoUrl };
}

// ── Step 4 — Review & save ─────────────────────────────────────────────────

async function stepReview(sql, artist, { displayFields, filterFields, logoUrl }) {
  header(4, 4, 'Review & save');

  console.log(`\n  Artist: ${B(artist.name)} ${D(`(${artist.slug})`)}`);
  console.log(`  Logo:   ${D(logoUrl)}`);
  console.log(`\n  Display fields:`);
  displayFields.forEach((f, i) =>
    console.log(`    ${D(`${i + 1}.`)} ${f.field.padEnd(26)} ${D(f.label)}`)
  );
  console.log(`\n  Filter fields:`);
  if (filterFields.length) {
    filterFields.forEach(f =>
      console.log(`    · ${f.field.padEnd(26)} ${D(f.label + (f.type ? ` (${f.type})` : ''))}`)
    );
  } else {
    console.log(D('    (none)'));
  }
  console.log('');

  if (!await confirm('Save this configuration?')) {
    console.log(D('\n  Cancelled — no changes written.\n'));
    process.exit(0);
  }

  const config = { logoUrl, displayFields, filterFields };
  await sql`UPDATE artists SET config = ${config} WHERE id = ${artist.id}`;
  ok(`Config saved for ${B(artist.name)}`);

  // Seed placeholder venues (idempotent)
  const placeholders = ['Private Event', 'One-off / TBD', 'Festival (unlisted)'];
  for (const name of placeholders) {
    await sql`
      INSERT INTO venues (artist_id, name, category)
      VALUES (${artist.id}, ${name}, 'placeholder')
      ON CONFLICT DO NOTHING
    `;
  }
  ok('Placeholder venues seeded');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(B('┌──────────────────────────────────────────┐'));
  console.log(B('│   Artist Tools — Setup Wizard             │'));
  console.log(B('└──────────────────────────────────────────┘'));

  if (!process.env.DATABASE_URL) {
    console.log(R('\n  DATABASE_URL is not set.'));
    console.log(D('  Add it to .env.local or export it before running this script.\n'));
    process.exit(1);
  }

  await confirmDb(process.env.DATABASE_URL);

  const sql = neon(process.env.DATABASE_URL);

  try {
    await stepSchema(sql);
    const artist = await stepArtist(sql);
    const fields = await stepFields();
    await stepReview(sql, artist, fields);

    console.log(`\n  ${G('All done!')} ${D('Start the app with: vercel dev')}\n`);
  } catch (e) {
    console.log(`\n  ${R('Error:')} ${e.message}\n`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
