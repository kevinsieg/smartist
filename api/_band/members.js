const { getArtist, getSlug } = require('../_db');
const { requireAuth, requireRole } = require('../_auth');
const { toInput, send } = require('../_domain/http');
const { wrap } = require('../_handler');
const members = require('../_domain/members');

// /api/:artist/members — a band's members (api/_domain/members.js). This file only
// decides who may call what: the two email links are public, everything else
// needs a session, and managing other members needs the admin role.

const PUBLIC = {
  'accept-invite':        members.acceptInvite,
  'confirm-email-change': members.confirmEmailChange,
};

// POST actions any signed-in member may take on their own account, and the
// admin-only ones.
const OWN   = { 'change-password': members.changePassword, 'request-email-change': members.requestEmailChange };
const ADMIN = { 'invite': members.invite, 'resend-invite': members.resendInvite };

module.exports = wrap(async function handler(req, res) {
  const slug   = getSlug(req);
  const [action = ''] = req.query.path || [];   // POST /members/:action
  /** @type {Record<string, any>} */
  const ctx    = { ...toInput(req), slug };

  if (req.method === 'POST' && PUBLIC[action]) {
    // An invite belongs to one band; the email-change link spans all of them.
    if (action === 'accept-invite') {
      ctx.band = await getArtist(slug);
      if (!ctx.band) return res.status(404).json({ error: 'Not found' });
    }
    return send(res, await PUBLIC[action](ctx));
  }

  const band = await requireAuth(req, res, slug);
  if (!band) return;
  Object.assign(ctx, { band, user: req.user });

  if (req.method === 'POST' && OWN[action]) return send(res, await OWN[action](ctx));

  const adminFn = req.method === 'GET'    ? members.listMembers
                : req.method === 'PUT'    ? members.setRole
                : req.method === 'DELETE' ? members.removeMember
                : req.method === 'POST'   ? ADMIN[action]
                : null;
  if (!adminFn) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireRole(req, res, 'admin')) return;
  return send(res, await adminFn(ctx));
});
