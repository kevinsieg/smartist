#!/usr/bin/env node
// Static routing checks for Vercel rewrites/redirects.

const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const configPath = path.join(__dirname, '..', 'vercel.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const redirects = config.redirects || [];
const rewrites = config.rewrites || [];

assert(
  !redirects.some(r => r.source === '/'),
  'Root redirect shadows the home page rewrite'
);
assert(
  rewrites.some(r => r.source === '/' && r.destination === '/app/index.html'),
  'Root must rewrite to the home page'
);

console.log('routing checks passed');
