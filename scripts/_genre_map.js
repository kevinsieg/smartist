'use strict';

const path = require('path');

// One map per database and workspace: dev and production both hold a "klang",
// and a slug alone let one audit overwrite the other's reviewed map.
function mapFile(databaseUrl, slug) {
  let endpoint;
  try { endpoint = new URL(databaseUrl).hostname.split('.')[0].replace(/-pooler$/, ''); }
  catch { endpoint = 'unknown'; }
  return path.join(__dirname, '..', 'data', `genre_map.${endpoint}.${slug}.json`);
}

module.exports = { mapFile };
