'use strict';

const LYRICS_SOURCES = ['lyrics.ovh', 'lrclib', 'ai'];

function plainFromSynced(synced) {
  return synced?.replace(/\[\d+:\d+\.\d+\]/g, '').trim() ?? '';
}

module.exports = { LYRICS_SOURCES, plainFromSynced };
