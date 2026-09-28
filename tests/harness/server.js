'use strict';

// Local stand-in for Vercel's router, for the CI integration job: vercel.json
// rewrites, then file-system routing into api/ with the [artist] and [...path]
// params, and static files. Not vercel dev: that needs a Vercel login.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = vercel.rewrites;

function matchRewrite(p) {
  for (const r of rewrites) {
    const names = [];
    const re = new RegExp('^' + r.source.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = re.exec(p);
    if (!m) continue;
    let dest = r.destination;
    names.forEach((n, i) => { dest = dest.split(':' + n).join(m[i + 1]); });
    return dest;
  }
  return null;
}

function resolve(p) {
  const segs = p.split('/').filter(Boolean); // ['api', ...]
  if (segs[0] !== 'api') return null;
  if (segs.length === 2 && fs.existsSync(path.join(ROOT, 'api', segs[1] + '.js')))
    return { file: path.join(ROOT, 'api', segs[1] + '.js'), query: {} };
  const artist = segs[1], rest = segs.slice(2);
  if (!rest.length) return null;
  const base = path.join(ROOT, 'api', '[artist]');
  if (rest.length === 1 && fs.existsSync(path.join(base, rest[0] + '.js')))
    return { file: path.join(base, rest[0] + '.js'), query: { artist } };
  const catchAll = path.join(base, rest[0], '[...path].js');
  if (fs.existsSync(catchAll)) return { file: catchAll, query: { artist, path: rest.slice(1) } };
  return null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;
  let extra = new URLSearchParams();
  const rw = matchRewrite(p);
  if (rw) { const d = new URL(rw, 'http://localhost'); p = d.pathname; extra = d.searchParams; }
  if (!p.startsWith('/api')) {
    const file = path.join(ROOT, p);
    if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
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
