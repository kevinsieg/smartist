// Single source of truth for plan tiers. getPlan() is the only seam real
// billing later replaces (a provider webhook would write artists.config.plan;
// nothing else changes). Move a feature key between the two `features` arrays to change
// what is free vs paid.
const PLANS = {
  free: {
    label: 'Free',
    limits: { storageMB: 30, songs: 100 },
    features: ['songs', 'setlists', 'gigs', 'hub'],
  },
  pro: {
    label: 'Pro',
    // Pro is a free self-serve switch until paid billing exists, so its
    // storage is capped: unlimited space in a public bucket is free file
    // hosting for anyone who signs up. null = unlimited.
    limits: { storageMB: 2048, songs: null },
    features: ['songs', 'setlists', 'gigs', 'hub', 'venues', 'organizers', 'pro-import', 'booking'],
  },
};

function planKey(artist) {
  return PLANS[artist?.config?.plan] ? artist.config.plan : 'free';
}

function getPlan(artist) {
  return PLANS[planKey(artist)];
}

function hasFeature(artist, key) {
  return getPlan(artist).features.includes(key);
}

function storageLimitBytes(artist) {
  const mb = getPlan(artist).limits.storageMB;
  return mb == null ? null : mb * 1024 * 1024;
}

function songLimit(artist) {
  return getPlan(artist).limits.songs;
}

function wouldExceedStorage(artist, usedBytes, addBytes) {
  const limit = storageLimitBytes(artist);
  if (limit == null) return false;
  return Number(usedBytes) + Number(addBytes) > limit;
}

function planSummary(artist) {
  const key = planKey(artist);
  const p = PLANS[key];
  return { key, label: p.label, limits: p.limits, features: p.features };
}

// Writes a 402 and returns false when the band's plan lacks `key`.
function requireFeature(res, artist, key) {
  if (hasFeature(artist, key)) return true;
  res.status(402).json({ error: 'upgrade_required', feature: key });
  return false;
}

module.exports = {
  PLANS, getPlan, hasFeature, storageLimitBytes, songLimit,
  wouldExceedStorage, planSummary, requireFeature,
};
