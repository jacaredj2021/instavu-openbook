// digest.js
// A weekly "what happened on OpenBook" email that pulls members back in. Retention is
// free growth: you already own the email channel (Resend). It is OFF by default and
// only sends to VERIFIED, opted-in members who actually have something waiting, so it
// never spams. Turn it on with DIGEST_ENABLED=1 once you are happy with the copy.

const crypto = require('crypto');
const db = require('./db');
const { send, escapeHtml, EMAIL_CONFIGURED } = require('./mailer');
const { logger } = require('./logger');

const ENABLED = process.env.DIGEST_ENABLED === '1';
const EVERY_DAYS = Number(process.env.DIGEST_DAYS) > 0 ? Number(process.env.DIGEST_DAYS) : 7;
const CHECK_MS = 6 * 60 * 60 * 1000; // wake every 6h; each user still gets at most one per EVERY_DAYS
const BATCH = 200;                    // cap sends per wake so a backlog never stampedes

function baseUrl() { return (process.env.APP_BASE_URL || 'https://openbook.space').replace(/\/$/, ''); }

// A stable per-user unsubscribe token (generated lazily, stored, survives restarts).
async function tokenFor(userId) {
  const row = await db.prepare('SELECT digest_token FROM users WHERE id = ?').get(userId);
  if (row && row.digest_token) return row.digest_token;
  const t = crypto.randomBytes(16).toString('hex');
  await db.prepare('UPDATE users SET digest_token = ? WHERE id = ?').run(t, userId);
  return t;
}

// A member's last-period highlights: new followers, things addressed to them
// (mentions / replies / reactions / friend activity), and a few top public posts.
async function buildDigestData(userId) {
  const since = "datetime('now','-" + EVERY_DAYS + " days')";
  const newFollowers = (await db.prepare(
    'SELECT COUNT(*) c FROM follows WHERE followee_id = ? AND created_at >= ' + since
  ).get(userId)).c;
  const forYou = (await db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND created_at >= " + since +
    " AND type IN ('mention','comment','reaction','friend_request','friend_accept','repost')"
  ).get(userId)).c;
  const top = await db.prepare(
    "SELECT p.id, p.title, p.content FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "AND p.created_at >= " + since +
    " ORDER BY (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = 'post' AND target_id = p.id) DESC, p.created_at DESC LIMIT 3"
  ).all();
  return { newFollowers, forYou, top };
}

function digestHtml(name, data, unsubUrl) {
  const b = baseUrl();
  const rows = [];
  if (data.forYou > 0) rows.push('<b>' + data.forYou + '</b> new mention' + (data.forYou === 1 ? '' : 's') + ', repl' + (data.forYou === 1 ? 'y' : 'ies') + ', and reactions are waiting for you');
  if (data.newFollowers > 0) rows.push('<b>' + data.newFollowers + '</b> new follower' + (data.newFollowers === 1 ? '' : 's'));
  const highlights = rows.length ? '<ul style="padding-left:18px">' + rows.map((r) => '<li style="margin:6px 0">' + r + '</li>').join('') + '</ul>' : '';
  const top = (data.top || []).map((p) => {
    const txt = escapeHtml(String(p.title || p.content || '').replace(/\s+/g, ' ').trim()).slice(0, 120);
    return '<p style="margin:10px 0"><a href="' + b + '/p/' + p.id + '" style="color:#4f46e5;text-decoration:none">&#9650; ' + (txt || 'A post on OpenBook') + '</a></p>';
  }).join('');
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1c1c28">' +
    '<h2 style="color:#4f46e5">Your week on OpenBook' + (name ? ', ' + escapeHtml(name) : '') + '</h2>' +
    (highlights || '<p>Here is what has been happening across OpenBook.</p>') +
    (top ? '<h3 style="margin-top:22px">Worth a look</h3>' + top : '') +
    '<p style="margin:24px 0"><a href="' + b + '/app" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Open OpenBook</a></p>' +
    '<p style="font-size:12px;color:#9a9aa5">You get this because you are a member. <a href="' + unsubUrl + '" style="color:#9a9aa5">Unsubscribe from these emails</a>. Money never buys reach on OpenBook.</p>' +
    '</div>'
  );
}

// One eligible member -> one digest (only if they have something waiting). Returns true if sent.
async function sendOne(u) {
  const data = await buildDigestData(u.id);
  if (data.newFollowers === 0 && data.forYou === 0) {
    // Nothing personal waiting: do not email them (respectful, and better for deliverability).
    await db.prepare("UPDATE users SET digest_last_sent = datetime('now') WHERE id = ?").run(u.id);
    return false;
  }
  const token = await tokenFor(u.id);
  const unsub = baseUrl() + '/api/digest/unsubscribe?u=' + u.id + '&t=' + token;
  const r = await send(u.email, 'Your week on OpenBook', digestHtml(u.name, data, unsub));
  await db.prepare("UPDATE users SET digest_last_sent = datetime('now') WHERE id = ?").run(u.id);
  return !!(r && r.sent);
}

async function runOnce() {
  if (!ENABLED) return 0;
  const due = await db.prepare(
    "SELECT id, name, email FROM users WHERE email_verified = 1 AND email_digest = 1 " +
    "AND email IS NOT NULL AND email != '' AND email NOT LIKE '%@deleted.openbook.local' " +
    "AND (digest_last_sent IS NULL OR digest_last_sent < datetime('now','-" + EVERY_DAYS + " days')) " +
    'LIMIT ' + BATCH
  ).all();
  let sent = 0;
  for (const u of due) {
    try { if (await sendOne(u)) sent++; } catch (e) { try { logger.warn({ err: e, uid: u.id }, 'digest send failed'); } catch (_) {} }
  }
  if (sent) { try { logger.info({ sent }, 'weekly digests sent'); } catch (_) {} }
  return sent;
}

function startDigestJobs() {
  if (!ENABLED) { try { logger.info('weekly digest is OFF (set DIGEST_ENABLED=1 to enable)'); } catch (_) {} return; }
  if (!EMAIL_CONFIGURED) { try { logger.warn('DIGEST_ENABLED=1 but RESEND_API_KEY is unset; digests will no-op'); } catch (_) {} }
  setTimeout(() => { runOnce().catch(() => {}); }, 60 * 1000); // first pass shortly after boot
  setInterval(() => { runOnce().catch(() => {}); }, CHECK_MS);
}

module.exports = { startDigestJobs, runOnce, buildDigestData, tokenFor };
