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

async function sendToCloud(entry) {
  const token = process.env[TRANSPORT.envVar];
  if (!token) return;
  try {
    const ac  = new AbortController();
    const t   = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(TRANSPORT.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TRANSPORT.auth(token) },
      body:    JSON.stringify(entry),
      signal:  ac.signal,
    });
    clearTimeout(t);
    if (res.status !== TRANSPORT.success) console.error(`[logger] HTTP ${res.status}`);
  } catch (e) {
    console.error('[logger] transport error:', e.message);
  }
}

async function write(level, event, data) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  console.log(JSON.stringify(entry));
  if (IS_LOCAL) {
    writeToFile(JSON.stringify(entry));
  } else if (IS_PROD) {
    await sendToCloud(entry);
  }
  // preview: stdout only — logs visible in Vercel function dashboard
}

module.exports = {
  info:  (event, data = {}) => write('info',  event, data),
  warn:  (event, data = {}) => write('warn',  event, data),
  error: (event, data = {}) => write('error', event, data),
};
