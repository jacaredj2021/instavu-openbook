// routes/push.js
// The browser side of Web Push: hand the client the public VAPID key, register a
// browser's push subscription, and forget it on request. All three require a logged-in
// user (only a signed-in person subscribes their own device). When push is disabled
// (no VAPID keys set) the endpoints still answer, reporting enabled: false, so the
// client can quietly hide the "turn on notifications" control.

const express = require('express');
const { requireAuth } = require('../auth');
const push = require('../push');

const router = express.Router();

// The public key the browser needs to create a subscription, plus whether push is on
// at all. Safe to expose (the public key is meant to be shared with browsers).
router.get('/vapid', requireAuth, (req, res) => {
  res.json({ enabled: push.ENABLED, key: push.publicKey() });
});

// Register (or refresh) this browser's push subscription for the logged-in user.
router.post('/subscribe', requireAuth, async (req, res) => {
  if (!push.ENABLED) return res.status(503).json({ error: 'Push notifications are not enabled.' });
  const sub = req.body && req.body.subscription;
  const r = await push.saveSubscription(req.user.id, sub, req.get('user-agent') || '');
  if (!r.ok) return res.status(400).json({ error: r.error || 'Could not save the subscription.' });
  res.json({ ok: true });
});

// Forget this browser's subscription (the user turned notifications off here).
router.post('/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  await push.removeSubscription(endpoint);
  res.json({ ok: true });
});

module.exports = router;
