#!/usr/bin/env node
// Runs all unit suites and prints a combined summary.
// Each suite under tests/unit/ can also be run standalone.
const { makeRunner } = require('./unit/_runner');

const suites = [
  require('./unit/validate'),
  require('./unit/token'),
  require('./unit/pdf'),
  require('./unit/r2'),
  require('./unit/lyrics'),
  require('./unit/ratelimit'),
  require('./unit/gema'),
  require('./unit/ai'),
  require('./unit/handler'),
  require('./unit/subscribe'),
  require('./unit/contact'),
  require('./unit/arrangement'),
  require('./unit/user_token'),
  require('./unit/auth'),
  require('./unit/identity'),
];

(async () => {
  const r = makeRunner();
  for (const suite of suites) {
    const result = suite(r);
    if (result instanceof Promise) await result;
  }
  process.exit(r.summary() > 0 ? 1 : 0);
})();
