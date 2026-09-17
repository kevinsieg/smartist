// Request origin resolution shared by OAuth and signup email links.
function origin(req) {
  const h = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
}

module.exports = { origin };
