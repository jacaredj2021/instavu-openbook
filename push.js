// push.js
// Web Push notifications, so a direct message reaches someone even when OpenBook is
// closed on their phone: the phone shows a system notification (with its own sound)
// and a red count badge appears on the OpenBook home-screen icon.
//
// This is deliberately OFF until the operator sets VAPID keys, exactly like the email
// mailer is off without a Resend key. With no keys, ENABLED is false: the client is
// never offered the "turn on notifications" control and no push is ever attempted, so
// the app behaves exactly as before (the in-app chime still plays while a tab is open).
//
// To turn it on, generate a VAPID key pair once and put it in the host environment:
//   npx web-push generate-vapid-keys
// then set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT, a
// mailto: address). The public key is safe to share with browsers; the private key is
// a signing secret and is only ever read from the environment here, never committed.
//
// Credible neutrality: a notification is only a delivery channel. It never touches
// karma, standing, reach, or votes. We only ever push to a user about their OWN
// messages, and a block already prevents a blocked person's DM from existing at all.

const db = require('./db');
const { logger } = require('./logger');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:nmservicesww@gmail.com';

const ENABLED = !!(webpush && PUBLIC_KEY && PRIVATE_KEY);

if (ENABLED) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    logger.info('web push enabled');
  } catch (e) {
    logger.warn({ err: e }, 'web push VAPID setup failed; push disabled');
  }
}

// The browser public key the client needs to subscribe. Empty when push is off.
function publicKey() { return ENABLED ? PUBLIC_KEY : ''; }

// A real push endpoint is always an https URL on a public push-service host, which is
// always a DNS name (fcm.googleapis.com, updates.push.services.mozilla.com,
// *.notify.windows.com, web.push.apple.com). We store the endpoint and later POST to
// it via web-push, so as defense-in-depth we reject anything that is not https on a
// DNS host: in particular we reject EVERY IP-literal host outright. That single rule
// closes all private / loopback / link-local ranges at once (IPv4 dotted-quad, IPv6
// loopback / unique-local / link-local, and IPv4-mapped IPv6 like [::ffff:127.0.0.1]),
// so an authenticated user cannot register an endpoint that makes our server probe an
// internal address. The payload we send is encrypted and the response is never
// returned to the user, so the residual DNS-rebinding risk is negligible.
function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.indexOf(':') !== -1) return false;                          // any IPv6 literal (a DNS host never has a colon)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false; // any IPv4 literal
  return true;
}

// Store (or refresh) one browser's push subscription for a user. Keyed by endpoint,
// which is globally unique per browser install, so re-subscribing the same browser
// updates the row instead of duplicating it.
async function saveSubscription(userId, sub, ua) {
  if (!ENABLED) return { ok: false, disabled: true };
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, error: 'invalid subscription' };
  }
  if (!endpointAllowed(sub.endpoint)) return { ok: false, error: 'invalid subscription endpoint' };
  await db.prepare(
    'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, ' +
    'auth = excluded.auth, ua = excluded.ua'
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (ua || '').slice(0, 300));
  return { ok: true };
}

// Forget one browser's subscription (used when the user turns notifications off, or
// when the push service tells us the endpoint is gone).
async function removeSubscription(endpoint) {
  if (!endpoint) return;
  try { await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint); } catch (e) {}
}

// Count of unread direct messages for a user, used as the app-icon badge number.
async function unreadMessageCount(userId) {
  try {
    const r = await db.prepare('SELECT COUNT(*) c FROM messages WHERE recipient_id = ? AND is_read = 0').get(userId);
    return r ? r.c : 0;
  } catch (e) { return 0; }
}

// Send a push to every browser a user has registered. Fire-and-forget with its own
// error handling: a push failure must never disturb the caller (e.g. sending a DM).
// A 404/410 from the push service means that subscription is dead, so we prune it.
async function sendToUser(userId, payload) {
  if (!ENABLED) return;
  let subs = [];
  try {
    subs = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  } catch (e) { return; }
  if (!subs.length) return;
  const body = JSON.stringify(payload || {});
  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body, { TTL: 600 });
    } catch (err) {
      const code = err && err.statusCode;
      // 404/410: the subscription expired or was revoked. 403: the push service
      // rejected our VAPID signature, which after a key rotation means every old
      // subscription is permanently unusable. In all three cases the row is dead, so
      // prune it (the client re-subscribes with the current key on its next visit).
      if (code === 404 || code === 410 || code === 403) {
        await removeSubscription(s.endpoint);
      } else {
        try { logger.warn({ code, userId }, 'web push send failed'); } catch (_) {}
      }
    }
  }));
}

// Build and send the "new direct message" push. Keeps the body short (push payloads
// are size-limited) and never leaks who is unread-counting to anyone else. The tag is
// per sender ("dm:<fromId>") so that if two different people message you while the app
// is closed, their notifications stack instead of one replacing the other (a single
// shared tag would collapse every conversation into one visible notification).
async function notifyNewMessage(recipientId, fromId, senderName, content) {
  if (!ENABLED) return;
  const count = await unreadMessageCount(recipientId);
  let preview = (content || '').toString().replace(/\s+/g, ' ').trim();
  if (preview.length > 120) preview = preview.slice(0, 117) + '...';
  await sendToUser(recipientId, {
    type: 'dm',
    title: senderName ? (senderName + ' sent you a message') : 'New message',
    body: preview || 'You have a new message on OpenBook.',
    url: '/app',
    tag: 'dm:' + (fromId || ''),
    count: count,
  });
}

module.exports = { ENABLED, publicKey, saveSubscription, removeSubscription, sendToUser, notifyNewMessage, unreadMessageCount };
