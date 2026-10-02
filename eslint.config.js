'use strict';

// Lint for real mistakes only (unused names, undefined names, unreachable
// code); formatting is left alone. `npm run lint`, also run in CI.

const js = require('@eslint/js');
const globals = require('globals');

const common = { 'no-empty': ['error', { allowEmptyCatch: true }] };
const unused = ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }];

module.exports = [
  { ignores: ['node_modules/', 'logs/', 'data/', '.vercel/', 'app/vendor/'] },
  js.configs.recommended,
  { rules: common },

  // Serverless functions, scripts and tests: CommonJS on Node.
  {
    files: ['api/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': unused },
  },

  // Browser tests evaluate page code inside Playwright.
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Page scripts are classic <script> files sharing one global scope: a name
  // defined in core.js is used by every page, so undefined-name and unused
  // checks cannot see across files and stay off here.
  {
    files: ['app/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off', 'no-redeclare': 'off' },
  },
];
