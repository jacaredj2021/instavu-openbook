// routes/public.js
// The no-auth PUBLIC read API. Everything here is GET-only and returns ONLY
// world-visible content (see publicview.js for the single security boundary), so a
// logged-out visitor, Google, or a link scraper can read public posts / profiles /
// discover without an account. GETs are already exempt from the CSRF + email-verify
// gates, so this needs no auth and touches nothing.

const express = require('express');
const pv = require('../publicview');

const router = express.Router();

router.get('/post/:id', async (req, res) => {
  const post = await pv.publicPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_public' });
  res.json({ post });
});

router.get('/user/:handle', async (req, res) => {
  const data = await pv.publicProfile(req.params.handle);
  if (!data) return res.status(404).json({ error: 'not_public' });
  res.json(data);
});

router.get('/discover', async (req, res) => {
  res.json({ posts: await pv.publicDiscover(req.query.limit) });
});

router.get('/communities', async (req, res) => {
  res.json({ communities: await pv.publicCommunities(req.query.limit) });
});

module.exports = router;
