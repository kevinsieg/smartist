#!/usr/bin/env node
'use strict';

// Creates the band the CI integration job tests against: a Pro workspace
// (venues and organizers are Pro features) with one admin login and two songs
// for the setlist tests to reference.
// Idempotent. Refuses anything but a database on this machine.
//
//   DATABASE_URL=postgres://…@localhost/… ARTIST_SLUG=ci ARTIST_EMAIL=… ARTIST_PASSWORD=… \
//     node tests/harness/seed.js

const bcrypt = require('bcryptjs');
const { connect } = require('../../scripts/_lib');

async function main() {
  const { DATABASE_URL, ARTIST_SLUG, ARTIST_EMAIL, ARTIST_PASSWORD } = process.env;
  if (!DATABASE_URL || !ARTIST_SLUG || !ARTIST_EMAIL || !ARTIST_PASSWORD) {
    throw new Error('DATABASE_URL, ARTIST_SLUG, ARTIST_EMAIL and ARTIST_PASSWORD are required');
  }
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DATABASE_URL)) {
    throw new Error('refusing to seed a database that is not on localhost');
  }
  const sql = connect(DATABASE_URL);
  try {
    const hash = await bcrypt.hash(ARTIST_PASSWORD, 10);
    const [band] = await sql`
      INSERT INTO artists (slug, name, config) VALUES (${ARTIST_SLUG}, 'CI Band', ${sql.json({ plan: 'pro' })})
      ON CONFLICT (slug) DO UPDATE SET config = artists.config || ${sql.json({ plan: 'pro' })}
      RETURNING id`;
    await sql`
      INSERT INTO users (artist_id, email, password_hash, role)
      VALUES (${band.id}, ${ARTIST_EMAIL.toLowerCase()}, ${hash}, 'admin')
      ON CONFLICT (artist_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`;
    await sql`
      INSERT INTO songs (artist_id, title, key)
      SELECT ${band.id}, t, k FROM (VALUES ('CI Song One', 'C'), ('CI Song Two', 'Am')) v(t, k)
      WHERE NOT EXISTS (SELECT 1 FROM songs WHERE artist_id = ${band.id} AND title = v.t AND NOT deleted)`;
    console.log(`seeded ${ARTIST_SLUG} (pro, admin ${ARTIST_EMAIL})`);
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
