'use strict';

// For interpolating user-controlled text (band names, addresses, song titles)
// into HTML email bodies — a band name is whatever its admin typed.
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escHtml };
