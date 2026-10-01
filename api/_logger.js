const fs   = require('fs');
const path = require('path');

// VERCEL_ENV is injected by Vercel: 'production' | 'preview' | 'development'.
// Not set when running outside Vercel (e.g. plain `node`).
const VERCEL_ENV   = process.env.VERCEL_ENV;
const IS_LOCAL     = VERCEL_ENV === 'development' || !VERCEL_ENV;
const IS_PROD      = VERCEL_ENV === 'production';
const LOG_DIR      = path.join(process.cwd(), 'logs');
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function todayPath() {
  return path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

function writeToFile(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = todayPath();
    const isNew   = !fs.existsSync(logPath);
    fs.appendFileSync(logPath, line + '\n');
    if (isNew) pruneOldLogs();
  } catch {}
}

// ── Cloud log transport ───────────────────────────────────────────────────────
// To switch providers, update these four values only.
const TRANSPORT = {
  envVar:  'BETTERSTACK_TOKEN',
  url:     'https://in.logs.betterstack.com',
  auth:    token => `Bearer ${token}`,
  success: 202,
};
// ─────────────────────────────────────────────────────────────────────────────

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

// Per-request context: { fields, buffer }. fields (the request id from
// api/_handler.js) are added to every entry written while that request runs.
/** @type {AsyncLocalStorage<{ fields: object, buffer: object[] }>} */
const context = new AsyncLocalStorage();

// Production entries are buffered and sent in one POST when the request is
// done (flush, called by wrap()): an awaited HTTPS call per log line added the
// provider's latency to requests, several times over for some of them. Each
// request keeps its own buffer, so with several requests in flight on one
// instance a flush sends only its own request's lines. Entries written outside
// any request (module load) go to the instance buffer and ride along with the
// next flush.
let buffer = [];

// The send runs after the response (waitUntil), so it no longer delays
// requests; the timeout bounds how long it keeps the instance busy.
const SEND_TIMEOUT_MS = 2000;

async function sendToCloud(entries) {
  const token = process.env[TRANSPORT.envVar];
  if (!token || !entries.length) return;
  try {
    const ac  = new AbortController();
    const t   = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
    const res = await fetch(TRANSPORT.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TRANSPORT.auth(token) },
      body:    JSON.stringify(entries),
      signal:  ac.signal,
    });
    clearTimeout(t);
    if (res.status !== TRANSPORT.success) console.error(`[logger] HTTP ${res.status}`);
  } catch (e) {
    console.error('[logger] transport error:', e.message);
  }
}

// Email addresses never leave for the log provider (or a log file) in clear:
// they become <12 hex of sha256>@<domain> — still matchable by hashing the
// address you look for, and the domain stays readable.
const EMAIL_RE = /[^\s@"'<>(),;:]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
function redactEmail(address, domain) {
  const hash = crypto.createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 12);
  return `${hash}@${domain}`;
}
function redact(value) {
  if (typeof value === 'string') return value.replace(EMAIL_RE, redactEmail);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

async function write(level, event, data) {
  const store = context.getStore();
  const entry = redact({ ts: new Date().toISOString(), level, event, ...store?.fields, ...data });
  console.log(JSON.stringify(entry));
  if (IS_LOCAL) {
    writeToFile(JSON.stringify(entry));
  } else if (IS_PROD) {
    (store ? store.buffer : buffer).push(entry);
  }
  // preview: stdout only — logs visible in Vercel function dashboard
}

// Sends the current request's buffered entries, plus any written outside a
// request. Called once per request by wrap(), inside withContext.
async function flush() {
  const store = context.getStore();
  const entries = store ? store.buffer.splice(0) : [];
  if (buffer.length) entries.unshift(...buffer.splice(0));
  if (!entries.length) return;
  await sendToCloud(entries);
}

// Runs fn with ctx (e.g. { requestId }) attached to every entry it logs.
function withContext(ctx, fn) {
  return context.run({ fields: ctx, buffer: [] }, fn);
}

module.exports = {
  info:  (event, data = {}) => write('info',  event, data),
  warn:  (event, data = {}) => write('warn',  event, data),
  error: (event, data = {}) => write('error', event, data),
  flush,
  withContext,
  redact,
};
