'use strict';

// Song reads and writes shared by api/[artist]/songs.js and the songs catch-all.
//
// Lyrics live in song_lyrics, not in songs.extra: a band's lyrics run to
// megabytes, and the song list is loaded on every songs and setlist page. Lists
// carry has_lyrics; the text comes with one song's details (songDetail) or, for
// the CSV export, on request (listSongs withLyrics).

const LYRICS_MAX = 20000;
const LANGUAGE_MAX = 10;

// Keys that used to live in songs.extra and are real columns now. An older
// client (or a cached page) may still send them inside extra.
const MOVED_EXTRA_KEYS = ['lyrics', 'language'];

// One GEMA work per song for the list columns — the lowest work number wins.
function gemaJoin(sql) {
  return sql`
    LEFT JOIN LATERAL (
      SELECT iswc, gema_work_number, language
      FROM gema_works
      WHERE song_id = s.id AND artist_id = s.artist_id
      ORDER BY gema_work_number
      LIMIT 1
    ) g ON true`;
}

// The song list. Play counts are aggregated once per band (one scan of its
// setlists) instead of fanning every song out over setlist_songs, and both
// sides of that join are scoped to the band.
//   page:            { limit, offset } → adds COUNT(*) OVER() AS total
//   activeOnly:      only songs with active = true
//   withArrangement: has_arrangement column (members only)
//   withLyrics:      the lyrics text too (CSV export)
function listSongs(sql, artistId, { page = null, activeOnly = false, withArrangement = false, withLyrics = false } = {}) {
  return sql`
    WITH plays AS (
      SELECT ss.song_id, count(DISTINCT ss.setlist_id)::int AS play_count, max(sl.created_at) AS last_played_at
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      WHERE sl.artist_id = ${artistId}
      GROUP BY ss.song_id
    )
    SELECT s.*,
      COALESCE(p.play_count, 0) AS play_count,
      p.last_played_at,
      g.iswc, g.gema_work_number, g.language AS gema_language,
      (l.song_id IS NOT NULL) AS has_lyrics
      ${withLyrics ? sql`, l.lyrics` : sql``}
      ${withArrangement ? sql`, EXISTS (
        SELECT 1 FROM song_arrangements sa
        WHERE sa.song_id = s.id AND sa.artist_id = s.artist_id
      ) AS has_arrangement` : sql``}
      ${page ? sql`, COUNT(*) OVER()::int AS total` : sql``}
    FROM songs s
    LEFT JOIN plays p       ON p.song_id = s.id
    LEFT JOIN song_lyrics l ON l.song_id = s.id
    ${gemaJoin(sql)}
    WHERE s.artist_id = ${artistId}
      AND s.deleted = false
      ${activeOnly ? sql`AND s.active = true` : sql``}
    ORDER BY s.title
    ${page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``}
  `;
}

// The songs in /api/config (setlist generator, dashboard): the rows and their
// GEMA identifiers, nothing computed.
function configSongs(sql, artistId) {
  return sql`
    SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language,
      EXISTS (SELECT 1 FROM song_lyrics l WHERE l.song_id = s.id) AS has_lyrics
    FROM songs s
    ${gemaJoin(sql)}
    WHERE s.artist_id = ${artistId} AND s.deleted = false
    ORDER BY s.title
  `;
}

// One live song with its lyrics — the song panel, the lyrics modal and stage.
async function songDetail(sql, artistId, songId) {
  const [song] = await sql`
    SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language,
      l.lyrics, (l.song_id IS NOT NULL) AS has_lyrics
    FROM songs s
    LEFT JOIN song_lyrics l ON l.song_id = s.id
    ${gemaJoin(sql)}
    WHERE s.id = ${songId} AND s.artist_id = ${artistId} AND s.deleted = false
  `;
  return song ?? null;
}

// Lyrics as stored: trimmed, and empty means none.
function cleanLyrics(value) {
  if (value == null) return { value: null };
  if (typeof value !== 'string') return { error: 'lyrics must be a string' };
  if (value.length > LYRICS_MAX) return { error: 'Lyrics too long (max 20 000 characters)' };
  return { value: value.trim() || null };
}

// A language code (EN, DE, FR, …) as stored: upper case, empty means none.
// Returns false when it is too long, like validateStr.
function cleanLanguage(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > LANGUAGE_MAX) return false;
  return s.toUpperCase();
}

// Splits the keys that are columns now out of an incoming extra object, so
// they never land in songs.extra again. Returns { extra, lyrics, language },
// where lyrics / language are undefined when extra did not carry them.
function splitMovedKeys(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return { extra, lyrics: undefined, language: undefined };
  const rest = { ...extra };
  const moved = {};
  for (const k of MOVED_EXTRA_KEYS) {
    if (k in rest) { moved[k] = rest[k]; delete rest[k]; }
  }
  return { extra: rest, lyrics: moved.lyrics, language: moved.language };
}

// Saves (or, with null, removes) one song's lyrics and writes the audit entry,
// in one statement. Returns the song ({ id, title }) or null when the song is
// not a live song of this band.
async function writeLyrics(sql, artistId, songId, lyrics, action = 'lyrics_update') {
  const [song] = await sql`
    WITH s AS (
      SELECT id, title FROM songs
      WHERE id = ${songId} AND artist_id = ${artistId} AND deleted = false
    ), saved AS (
      INSERT INTO song_lyrics (song_id, artist_id, lyrics)
      SELECT id, ${artistId}, ${lyrics}::text FROM s WHERE ${lyrics}::text IS NOT NULL
      ON CONFLICT (song_id) DO UPDATE SET lyrics = EXCLUDED.lyrics, updated_at = now()
    ), removed AS (
      DELETE FROM song_lyrics
      WHERE song_id IN (SELECT id FROM s) AND ${lyrics}::text IS NULL
    ), logged AS (
      INSERT INTO song_logs (artist_id, song_id, action, song_data)
      SELECT ${artistId}, id, ${action}, jsonb_build_object('title', title) FROM s
    )
    SELECT id, title FROM s
  `;
  return song ?? null;
}

// What the lyrics search needs: title, performer, and the language/genre the
// GEMA work gives (the song's own language when none is linked).
async function lyricsSearchInfo(sql, artistId, songId) {
  const [song] = await sql`
    SELECT s.title, s.interpret, s.reference_interpret,
      COALESCE(g.language, s.language) AS language,
      g.gema_genre AS genre
    FROM songs s
    LEFT JOIN LATERAL (
      SELECT language, gema_genre FROM gema_works
      WHERE song_id = s.id AND artist_id = s.artist_id
      ORDER BY gema_work_number LIMIT 1
    ) g ON true
    WHERE s.id = ${songId} AND s.artist_id = ${artistId} AND s.deleted = false
  `;
  return song ?? null;
}

module.exports = {
  LYRICS_MAX, listSongs, configSongs, songDetail, cleanLyrics, cleanLanguage,
  splitMovedKeys, writeLyrics, lyricsSearchInfo,
};
