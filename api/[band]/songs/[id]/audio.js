const { makeMediaHandler } = require('../../../_media');

module.exports = makeMediaHandler({
  keyPrefix:    'audio/',
  extraKey:     'listenUrl',
  maxBytes:     50 * 1024 * 1024,
  actionPrefix: 'audio',
  allowedExts:  new Set(['mp3', 'm4a', 'ogg', 'wav', 'flac']),
  mimePrefix:   'audio/',
});
