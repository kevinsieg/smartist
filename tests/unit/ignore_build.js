'use strict';

// vercel.json's ignoreCommand decides, per Git push, whether a Vercel project
// builds. Exit 0 skips the build, anything else builds. Projects that set
// SKIP_PREVIEW_BUILDS=1 build only dev and main; every other project builds
// every branch.

const path = require('path');
const { execFileSync } = require('child_process');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

function builds(env) {
  const { ignoreCommand } = require(path.join(ROOT, 'vercel.json'));
  try {
    execFileSync('sh', ['-c', ignoreCommand], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' });
    return false;
  } catch (e) {
    return e.status === 1;
  }
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\nvercel ignored build step'));

  test('without SKIP_PREVIEW_BUILDS every branch builds', () => {
    for (const ref of ['dev', 'main', 'claude/some-branch', ''])
      assert(builds({ VERCEL_GIT_COMMIT_REF: ref }), `${ref || '(no ref)'} skipped`);
  });
  test('with SKIP_PREVIEW_BUILDS=1 dev and main build', () => {
    for (const ref of ['dev', 'main'])
      assert(builds({ SKIP_PREVIEW_BUILDS: '1', VERCEL_GIT_COMMIT_REF: ref }), `${ref} skipped`);
  });
  test('with SKIP_PREVIEW_BUILDS=1 other branches are skipped', () => {
    for (const ref of ['claude/some-branch', 'feature/dev', 'main-fix'])
      assert(!builds({ SKIP_PREVIEW_BUILDS: '1', VERCEL_GIT_COMMIT_REF: ref }), `${ref} built`);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
