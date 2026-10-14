#!/usr/bin/env node
/**
 * Smartist — Waveforms
 *
 * Computes the waveform of every uploaded recording that has none: Listen,
 * Playback and each voice's own recording (song_media.waveform). New uploads
 * get theirs in the browser; this is for the recordings uploaded before that
 * existed. Needs ffmpeg on the PATH.
 *
 * Usage:
 *   node scripts/waveforms.js [--artist <slug>] [--all] [--dry-run] [--yes]
 *   DATABASE_URL=<url> node scripts/waveforms.js --dry-run     # any other database
 *
 *   --artist   only this band
 *   --all      redo recordings that already have a waveform
 *   --dry-run  list what would be done, change nothing
 *
 * Reads DATABASE_URL from the environment or .env / .env.local; asks before it connects.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const lib  = require('./_lib');
const { waveformPeaks, waveformEncode } = require('../app/js/waveform');

const run = promisify(execFile);
const AUDIO_RE = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

// ffmpeg decodes to mono 8 kHz float samples: plenty for 100 bars, cheap to hold.
async function decodePeaks(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  const n = Math.floor(stdout.length / 4);
  const samples = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + n * 4));
  return waveformEncode(waveformPeaks(samples));
}

async function waveformFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waveform-'));
  const file = path.join(dir, 'in');
  try {
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return await decodePeaks(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  lib.loadEnv();
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const dry = args.includes('--dry-run');
  const slug = args.includes('--artist') ? args[args.indexOf('--artist') + 1] : null;
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  await lib.confirmDb(process.env.DATABASE_URL, { yes: args.includes('--yes') });
  const sql = lib.connect(process.env.DATABASE_URL);
  try {
    // One entry per recording: where it is, and how to store its waveform.
    const inScope = sql`(${slug}::text IS NULL OR a.slug = ${slug})`;
    const mediaRows = async () => (await sql`
      SELECT m.id, m.kind, m.instrument, m.url, s.title, a.slug
      FROM song_media m JOIN songs s ON s.id = m.song_id JOIN artists a ON a.id = m.artist_id
      WHERE NOT s.deleted AND m.kind IN ('listen', 'playback', 'instrument')
        AND (${all} OR m.waveform IS NULL)
        AND ${inScope}
      ORDER BY a.slug, m.id`).map(r => ({
        what: `${r.slug} ${r.kind}${r.instrument ? ' ' + r.instrument : ''} ${r.title}`, url: r.url,
        save: waveform => sql`UPDATE song_media SET waveform = ${waveform} WHERE id = ${r.id}`,
      }));
    const rows = await mediaRows();
    const todo = rows.filter(r => AUDIO_RE.test(r.url));
    console.log(`  ${todo.length} recording(s) to do (${rows.length - todo.length} link(s) skipped)`);
    let done = 0, failed = 0;
    for (const r of todo) {
      if (dry) { console.log(`  would do: ${r.what}`); continue; }
      try {
        await r.save(await waveformFromUrl(r.url));
        done++;
        console.log(`  ok: ${r.what}`);
      } catch (e) {
        failed++;
        console.log(`  failed: ${r.what}: ${e.message}`);
      }
    }
    if (!dry) console.log(`\n  done ${done}, failed ${failed}`);
  } finally {
    await sql.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { decodePeaks };
