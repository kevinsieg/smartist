'use strict';

// api/_env.js lists every variable the API reads; the health check reports what
// is missing. SCHEMA_VERSION must be the newest migration schema.sql records,
// or the health check would call an up-to-date database "behind" (or the reverse).

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

function run(r) {
  const { test, assert, assertEq, B } = r;
  const { envReport, SCHEMA_VERSION, REQUIRED, RECOMMENDED, PAIRS } = require(path.join(ROOT, 'api/_env'));
  const { migrationIds, splitStatements } = require(path.join(ROOT, 'scripts/apply_schema'));
  const schema = fs.readFileSync(path.join(ROOT, 'scripts/schema.sql'), 'utf8');

  console.log(B('\nenvironment and schema version'));

  test('SCHEMA_VERSION is the last migration schema.sql records', () => {
    const ids = migrationIds(schema);
    assert(ids.length > 0, 'schema.sql records no migrations');
    assertEq(ids[ids.length - 1], SCHEMA_VERSION);
  });

  test('migration ids are unique and in order', () => {
    const ids = migrationIds(schema);
    assertEq(new Set(ids).size, ids.length, 'duplicate migration id');
    assertEq([...ids].sort(), ids, 'migration ids out of order');
  });

  test('schema.sql splits into statements without DO blocks', () => {
    const stmts = splitStatements(schema);
    assert(stmts.length > 30, `only ${stmts.length} statements`);
    assert(!stmts.some(s => /\$\$/.test(s)), 'a $$ block cannot survive the ; split');
  });

  test('every variable the API reads is listed in api/_env.js or known optional', () => {
    // Optional ones with safe defaults, not worth a warning.
    const OPTIONAL = new Set(['ARTIST_SLUG', 'GEMINI_API_KEY', 'GROQ_API_KEY',
      'MISTRAL_API_KEY', 'FACEBOOK_TRUST_EMAIL', 'SUPER_ADMIN_EMAILS', 'DEMO_ARTIST_SLUG',
      'CONTACT_EMAIL', 'VERCEL_ENV', 'BETTERSTACK_TOKEN']);
    const listed = new Set([...REQUIRED, ...RECOMMENDED, ...PAIRS.flat(), ...OPTIONAL]);
    const used = new Set();
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith('.js')) return;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/envVar:\s*'([A-Z0-9_]+)'/g)) used.add(m[1]);
    });
    walk(path.join(ROOT, 'api'));
    const unlisted = [...used].filter(n => !listed.has(n));
    assertEq(unlisted, [], 'add these to api/_env.js (and .env.example)');
  });

  test('envReport names missing required and recommended variables, never values', () => {
    const saved = { ...process.env };
    try {
      for (const n of [...REQUIRED, ...RECOMMENDED, 'BETTERSTACK_TOKEN', ...PAIRS.flat()]) delete process.env[n];
      process.env.APP_SECRET = 'x';
      process.env.GOOGLE_CLIENT_ID = 'only-half';
      const rep = envReport('production');
      assertEq(rep.missing, ['DATABASE_URL']);
      assert(rep.warnings.includes('R2_PUBLIC_URL'), 'recommended missing');
      assert(rep.warnings.includes('BETTERSTACK_TOKEN'), 'production-only missing');
      assert(rep.warnings.includes('GOOGLE_CLIENT_SECRET'), 'half a pair');
      assert(!rep.warnings.includes('FACEBOOK_APP_ID'), 'an unset pair is fine');
      assert(!JSON.stringify(rep).includes('only-half'), 'a value leaked');
      assert(!envReport('preview').warnings.includes('BETTERSTACK_TOKEN'), 'preview logs elsewhere');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test('a Neon DATABASE_URL must be the pooled endpoint', () => {
    const { usesNeonPooler } = require(path.join(ROOT, 'api/_env'));
    assert(usesNeonPooler('postgresql://u:p@ep-x-123-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'), 'pooler');
    assert(!usesNeonPooler('postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech/db?sslmode=require'), 'direct');
    assert(usesNeonPooler('postgres://u:p@localhost:5433/db'), 'not Neon: no opinion');
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech/db';
      const rep = envReport('production');
      assert(rep.warnings.includes('DATABASE_URL (use the -pooler host)'), 'warned');
      assert(!JSON.stringify(rep).includes('ep-x-123'), 'host leaked');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    }
  });

  test('.env.example documents every listed variable', () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const missing = [...REQUIRED, ...RECOMMENDED, ...PAIRS.flat(), 'BETTERSTACK_TOKEN']
      .filter(n => !new RegExp(`^#?\\s*${n}=`, 'm').test(example));
    assertEq(missing, []);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
