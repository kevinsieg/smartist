const { makeMediaHandler } = require('../../../_media');

module.exports = makeMediaHandler({
  keyPrefix:    'sheets/',
  extraKey:     'sheetUrl',
  maxBytes:     20 * 1024 * 1024,
  actionPrefix: 'sheet',
  mimePrefix:   'application/pdf',
  // allowedExts omitted → handler accepts only .pdf (extension check only, no ct param)
});
