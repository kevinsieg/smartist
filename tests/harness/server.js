'use strict';

// Local stand-in for Vercel's router, for the CI integration job: vercel.json
// rewrites, static files, and the one function at /api (api/index.js), which
// /api/* reaches only through its rewrite, as on Vercel. Not vercel dev: that
// needs a Vercel login.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = vercel.rewrites;
// The production Content-Security-Policy, so the browser tests run under it
// and an inline script or handler shows up as a console error there too.
const CSP = vercel.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;

function matchRewrite(p) {
  for (const r of rewrites) {
    const names = [];
    const re = new RegExp('^' + r.source.replace(/:(\w+)(\*?)/g, (_, n, star) => { names.push(n + star); return star ? '(.*)' : '([^/]+)'; }) + '$');
    const m = re.exec(p);
    if (!m) continue;
    let dest = r.destination;
    names.forEach((n, i) => { dest = dest.split(':' + n).join(m[i + 1]); });
    return dest;
  }
  return null;
}

// Mail goes to an outbox here instead of to the provider, so the flows that mail
// a link (invites, resets, shares) run end to end. Tests read it at
// GET /__outbox?to=<address>. A real RESEND_API_KEY in the env turns this off.
const outbox = [];
if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = 'local-outbox';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, opts);
    outbox.push(JSON.parse(String(opts?.body)));
    return new Response(JSON.stringify({ id: `local-${outbox.length}` }), { status: 200 });
  };
}

// The function lives at /api only; any other /api/* path is Vercel's 404
// unless a rewrite sent it there.
function resolve(p) {
  if (p !== '/api') return null;
  return { file: path.join(ROOT, 'api', 'index.js'), query: {} };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;
  let extra = new URLSearchParams();
  if (u.pathname === '/__outbox') {
    const to = u.searchParams.get('to');
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ outbox: outbox.filter(m => [].concat(m.to).includes(to)) }));
  }
  const rw = matchRewrite(p);
  if (rw) { const d = new URL(rw, 'http://localhost'); p = d.pathname; extra = d.searchParams; }
  if (!p.startsWith('/api')) {
    const file = path.join(ROOT, p);
    if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      if (ext === '.html') res.setHeader('Content-Security-Policy', CSP);
      return res.end(fs.readFileSync(file));
    }
    res.statusCode = 404; return res.end('not found');
  }
  const route = resolve(p);
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return res; };
  res.send = b => { if (typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b); res.end(b); return res; };
  res.redirect = (a, b) => { const [code, loc] = typeof a === 'number' ? [a, b] : [307, a]; res.statusCode = code; res.setHeader('Location', loc); res.end(); return res; };
  if (!route) { res.statusCode = 404; return res.end('not found'); }
  const query = { ...route.query };
  for (const [k, v] of u.searchParams) query[k] = v;
  for (const [k, v] of extra) query[k] = v;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  let body = raw;
  if ((req.headers['content-type'] || '').includes('application/json')) { try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; } }
  req.query = query; req.body = body;
  // Vercel keeps the original URL on req.url after a rewrite.
  try {
    const handler = require(route.file);
    await handler(req, res);
  } catch (e) { console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end('crash'); } }
}).listen(process.env.PORT || 3000, () => console.log('harness on :' + (process.env.PORT || 3000)));
