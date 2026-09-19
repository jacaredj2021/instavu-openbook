// routes/digest.js
// One-click unsubscribe from the weekly digest, linked from the email itself. No login
// needed (an email client opens it directly); the per-user token is the authorization.
// It flips email_digest off; the member can re-enable it later. GET is exempt from the
// CSRF + email gates, so this is reachable straight from the email.

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/unsubscribe', async (req, res) => {
  const id = Number(req.query.u);
  const t = String(req.query.t || '');
  let ok = false;
  try {
    if (id && t) {
      const row = await db.prepare('SELECT digest_token FROM users WHERE id = ?').get(id);
      if (row && row.digest_token && row.digest_token === t) {
        await db.prepare('UPDATE users SET email_digest = 0 WHERE id = ?').run(id);
        ok = true;
      }
    }
  } catch (e) { ok = false; }
  const msg = ok
    ? 'You have been unsubscribed from OpenBook weekly emails. You can turn them back on any time from Settings.'
    : 'This unsubscribe link is invalid or has expired.';
  res.status(ok ? 200 : 400).type('html').send(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1c1c28">' +
    '<h2 style="color:#4f46e5">OpenBook</h2><p>' + msg + '</p>' +
    '<p><a href="/" style="color:#4f46e5">Back to OpenBook</a></p></div>'
  );
});

module.exports = router;
