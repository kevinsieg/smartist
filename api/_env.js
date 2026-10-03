'use strict';

// Every environment variable the API reads, in one place, so a deployment can
// be checked after it goes out (GET /api/config?action=health) instead of
// failing one route at a time. Several Vercel projects run this code, each
// with its own variables: a missing APP_SECRET once kept two of them down for
// months because only the project that was tested had it.
//
//   required    — the API cannot serve anything without it
//   recommended — a feature breaks without it (uploads, email, links)
//   pairs       — optional, but only meaningful when set together
//
// Values are never reported, only names.

const REQUIRED = ['DATABASE_URL', 'APP_SECRET'];

const RECOMMENDED = [
  'APP_ORIGIN',                                   // links in emails, OAuth redirect
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME', 'R2_PUBLIC_URL',              // song media, posters, logos
  'RESEND_API_KEY', 'RESEND_FROM',                // invites, resets, shares
];

// Only checked on the production environment: preview and local log elsewhere.
const PRODUCTION = ['BETTERSTACK_TOKEN'];

const PAIRS = [
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
];

// The newest migration block in scripts/schema.sql. Health reports whether
// the database has it; tests/unit/env.js keeps the two in step.
const SCHEMA_VERSION = '2026-10-07';

const isSet = name => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

// True unless the URL names a Neon host other than its pooled endpoint.
function usesNeonPooler(url) {
  const host = (/@([^/:?]+)/.exec(String(url)) || [])[1] || '';
  return !/\.neon\.tech$/i.test(host) || /-pooler\./i.test(host);
}

function envReport(env = process.env.VERCEL_ENV) {
  const missing = REQUIRED.filter(n => !isSet(n));
  const warnings = RECOMMENDED.filter(n => !isSet(n));
  if (env === 'production') warnings.push(...PRODUCTION.filter(n => !isSet(n)));
  for (const pair of PAIRS) {
    const set = pair.filter(isSet);
    if (set.length && set.length < pair.length) warnings.push(...pair.filter(n => !isSet(n)));
  }
  // Every function instance holds its own connections: on Neon only the
  // pooled endpoint (the `-pooler` host) takes that many at once.
  if (isSet('DATABASE_URL') && !usesNeonPooler(process.env.DATABASE_URL))
    warnings.push('DATABASE_URL (use the -pooler host)');
  return { missing, warnings };
}

module.exports = { REQUIRED, RECOMMENDED, PRODUCTION, PAIRS, SCHEMA_VERSION, envReport, usesNeonPooler };
