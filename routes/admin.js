// routes/admin.js
// Platform-admin endpoints. Right now this is just supporter-tier management, so
// tiers can be granted and tested before any payment rail exists (and so the
// referral system and billing can reuse grantTier). Admin status comes from the
// is_admin flag (set via the ADMIN_EMAILS env, see db.js).

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { isAdmin } = require('../moderation');
const { grantTier, revokeTier } = require('../entitlements');
const { logger } = require('../logger');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  next();
}

// Grant or change a user's supporter tier. days omitted/0 = permanent.
router.post('/grant', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.body.userId);
  const tier = Number(req.body.tier);
  const days = req.body.days == null ? 0 : Number(req.body.days);
  if (!userId || !(tier >= 0 && tier <= 3)) {
    return res.status(400).json({ error: 'userId and tier (0 to 3) are required' });
  }
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const entitlements = await grantTier(userId, tier, days, 'admin_grant:' + req.user.id);
  logger.info({ admin: req.user.id, userId, tier, days }, 'admin granted supporter tier');
  res.json({ ok: true, entitlements });
});

// Clear a user's supporter status.
router.post('/revoke', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.body.userId);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const entitlements = await revokeTier(userId, 'admin_revoke:' + req.user.id);
  logger.info({ admin: req.user.id, userId }, 'admin revoked supporter tier');
  res.json({ ok: true, entitlements });
});

// Owner analytics: signups, usage, time on platform, top entry pages + buttons.
// Aggregate only; computed live from the users + analytics_events tables.
const HEARTBEAT_SEC = 20; // client sends a heartbeat every ~20s while visible
router.get('/analytics', requireAuth, requireAdmin, async (req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const many = (sql, ...a) => db.prepare(sql).all(...a);

  const totalUsers = (await one('SELECT COUNT(*) c FROM users')).c;
  const newUsers24h = (await one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-1 day')")).c;
  const newUsers7d = (await one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-7 days')")).c;
  const signupsByDay = await many(
    "SELECT date(created_at) d, COUNT(*) c FROM users WHERE created_at >= datetime('now','-14 days') GROUP BY d ORDER BY d DESC"
  );

  const activeUsers7d = (await one(
    "SELECT COUNT(DISTINCT user_id) c FROM analytics_events WHERE user_id IS NOT NULL AND created_at >= datetime('now','-7 days')"
  )).c;
  const totalPageviews = (await one("SELECT COUNT(*) c FROM analytics_events WHERE type='pageview'")).c;
  const totalClicks = (await one("SELECT COUNT(*) c FROM analytics_events WHERE type='click'")).c;
  const totalSessions = (await one("SELECT COUNT(DISTINCT session_id) c FROM analytics_events WHERE session_id != ''")).c;

  // Average time on platform per session: average heartbeats/session * interval.
  const avgHb = (await one(
    "SELECT AVG(hb) a FROM (SELECT session_id, COUNT(*) hb FROM analytics_events WHERE type='heartbeat' AND session_id != '' AND created_at >= datetime('now','-30 days') GROUP BY session_id)"
  )).a;
  const avgSessionSec = avgHb ? Math.round(avgHb * HEARTBEAT_SEC) : 0;

  const topPages = await many(
    "SELECT label, COUNT(*) c FROM analytics_events WHERE type='pageview' AND label != '' GROUP BY label ORDER BY c DESC LIMIT 10"
  );
  // Entry pages: the first page viewed in each session (SQLite bare-column min).
  const entryPages = await many(
    "SELECT label, COUNT(*) c FROM (SELECT session_id, label, MIN(created_at) t FROM analytics_events WHERE type='pageview' AND session_id != '' GROUP BY session_id) GROUP BY label ORDER BY c DESC LIMIT 10"
  );
  const topButtons = await many(
    "SELECT label, COUNT(*) c FROM analytics_events WHERE type='click' AND label != '' GROUP BY label ORDER BY c DESC LIMIT 10"
  );

  const supporters = (await one('SELECT COUNT(*) c FROM users WHERE supporter_tier > 0')).c;
  const qualifiedReferrals = (await one("SELECT COUNT(*) c FROM referrals WHERE status='qualified'")).c;

  res.json({
    totals: { totalUsers, newUsers24h, newUsers7d, activeUsers7d, totalPageviews, totalClicks, totalSessions, avgSessionSec, supporters, qualifiedReferrals },
    signupsByDay,
    topPages,
    entryPages,
    topButtons,
  });
});

// User management ? platform administration.
// Listing is available to admins; changing admin status is founder-only.
function requireFounder(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first' });
  if (!req.user.is_founder) return res.status(403).json({ error: 'Founder only' });
  next();
}

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

  let users;
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '\\$&') + '%';
    users = await db.prepare(
      "SELECT id, name, username, email, created_at, is_admin, is_founder, is_official, supporter_tier, supporter_since, supporter_expires, standing, karma " +
      "FROM users WHERE name LIKE ? OR username LIKE ? OR email LIKE ? " +
      "ORDER BY created_at DESC LIMIT ?"
    ).all(like, like, like, limit);
  } else {
    users = await db.prepare(
      "SELECT id, name, username, email, created_at, is_admin, is_founder, is_official, supporter_tier, supporter_since, supporter_expires, standing, karma " +
      "FROM users ORDER BY created_at DESC LIMIT ?"
    ).all(limit);
  }

  res.json({ users, canManageAdmins: !!req.user.is_founder });
});
router.post('/users/:id/admin', requireAuth, requireAdmin, requireFounder, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const target = await db.prepare(
    'SELECT id, name, username, email, is_admin, is_founder FROM users WHERE id = ?'
  ).get(userId);

  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.is_founder) {
    return res.status(403).json({ error: 'The founder account cannot be changed' });
  }

  const enabled = req.body && (
    req.body.enabled === true ||
    req.body.enabled === 1 ||
    req.body.enabled === '1'
  );

  await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(enabled ? 1 : 0, userId);

  await db.prepare(
    "INSERT INTO mod_actions (actor_id, action, target_type, target_id, reason, is_public) VALUES (?, ?, 'user', ?, ?, 0)"
  ).run(
    req.user.id,
    enabled ? 'grant_admin' : 'revoke_admin',
    userId,
    enabled ? 'Founder granted platform admin access' : 'Founder revoked platform admin access'
  );

  logger.info(
    { founder: req.user.id, userId, enabled },
    enabled ? 'founder granted admin access' : 'founder revoked admin access'
  );

  res.json({
    ok: true,
    user: Object.assign({}, target, { is_admin: enabled ? 1 : 0 })
  });
});

// Current supporters (admin view).
router.get('/supporters', requireAuth, requireAdmin, async (req, res) => {
  const supporters = await db.prepare(
    'SELECT id, name, email, supporter_tier, supporter_since, supporter_expires ' +
    'FROM users WHERE supporter_tier > 0 ORDER BY supporter_tier DESC, supporter_since DESC'
  ).all();
  res.json({ supporters });
});

module.exports = router;
