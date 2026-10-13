'use strict';

// Titles that are not identical but probably the same song: "Les Penn' Sardin"
// and "Penn sardin" (case, accents, punctuation and a leading article are
// ignored), "Sa compagne" inside "Sa compagne c'est la mer", or a typo
// ("Terre-neuvas" / "Terre-neuva"). Used by the CSV song import (a possible
// duplicate is shown, never blocking) and by scripts/import_setlist_csv.js.

function normTitle(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(?:le|la|les|l|un|une|the) /, '');
}

// A title prepared for many comparisons: { title, key (normalized), tokens }.
function titleEntry(title) {
  const key = normTitle(title);
  return { title, key, tokens: new Set(key.split(' ')) };
}

function subset(small, large) {
  for (const w of small) if (!large.has(w)) return false;
  return true;
}

// Edit distance of at most `limit`? Stops as soon as a whole row exceeds it, so
// a title far from the others costs a few steps, not its full length squared.
function editWithin(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = v;
      if (v < min) min = v;
    }
    if (min > limit) return false;
    prev = cur;
  }
  return prev[b.length] <= limit;
}

function similarEntries(x, y) {
  if (x.key === y.key) return true;
  const [small, large] = x.tokens.size <= y.tokens.size ? [x.tokens, y.tokens] : [y.tokens, x.tokens];
  if (subset(small, large)) return true;
  const longest = Math.max(x.key.length, y.key.length);
  return Math.min(x.key.length, y.key.length) >= 5 && editWithin(x.key, y.key, Math.floor(longest * 0.25));
}

// Two normalized titles.
function similar(a, b) {
  return similarEntries({ key: a, tokens: new Set(a.split(' ')) }, { key: b, tokens: new Set(b.split(' ')) });
}

module.exports = { normTitle, titleEntry, similarEntries, similar };
