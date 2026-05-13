#!/usr/bin/env node
// Runs all unit suites and prints a combined summary.
// Each suite under tests/unit/ can also be run standalone.
const { makeRunner } = require('./unit/_runner');

const suites = [
  require('./unit/validate'),
  require('./unit/token'),
  require('./unit/pdf'),
  require('./unit/r2'),
];

const r = makeRunner();
for (const suite of suites) suite(r);
process.exit(r.summary() > 0 ? 1 : 0);
