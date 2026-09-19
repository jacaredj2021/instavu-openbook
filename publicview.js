// publicview.js
// The read-only PUBLIC surface: what a logged-out visitor, Google, or a social-media
// link scraper is allowed to see WITHOUT an account. This is the single security
// boundary for public exposure, so it is deliberately strict and lives in one place.
//
// Only GENUINELY world-visible content is ever returned:
//   - a post is public iff visibility='visible' AND it is not a group post AND
//     (it is a public personal post OR it lives in a PUBLIC community);
//   - a profile is public iff its profile_visibility is 'public';
//   - friends-only posts, private/friends-only communities, group posts, removed or
//     auto-hidden content, and non-public profiles are NEVER exposed here.
// Blocks/mutes do not apply (there is no logged-in viewer). Nothing here needs auth.

const db = require('./db');
const { publicUser } = require('./auth');
const { decoratePost, decoratePosts } = require('./postview');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Absolute URL for an OG image (scrapers need an absolute URL). Media that already
// lives on the CDN is absolute; a local /uploads/ path is prefixed with the base URL.
function absUrl(base, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return base.replace(/\/$/, '') + (u.charAt(0) === '/' ? u : '/' + u);
}

// Is this raw post row world-visible? The shared predicate used everywhere below.
async function isPublicPostRow(p) {
  if (!p) return false;
  if ((p.visibility || 'visible') !== 'visible') return false;
  if (p.group_id) return false;
  if (p.community_id) {
    const c = await db.prepare('SELECT privacy FROM communities WHERE id = ?').get(p.community_id);
    return !!(c && c.privacy === 'public');
  }
  return p.audience === 'public';
}

// A single public post (decorated for a viewer-less render), or null.
async function publicPost(id) {
  const p = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!(await isPublicPostRow(p))) return null;
  const post = await decoratePost(p, 0);
  post.comments = await publicComments(p.id);
  return post;
}

// Visible top-level + threaded comments on a public post. Removed/hidden comments are
// dropped (no viewer, so nothing is tombstoned, just omitted).
async function publicComments(postId) {
  const rows = await db
    .prepare("SELECT * FROM comments WHERE post_id = ? AND visibility = 'visible' ORDER BY created_at ASC, id ASC LIMIT 200")
    .all(Number(postId));
  if (!rows.length) return [];
  // Batch the author lookup into ONE query (avoid an N+1: a hot post could otherwise
  // fire up to 200 networked reads on a single unauthenticated page view).
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const ph = ids.map(() => '?').join(',');
  const byId = new Map();
  for (const u of await db.prepare('SELECT * FROM users WHERE id IN (' + ph + ')').all(...ids)) byId.set(u.id, publicUser(u));
  return rows.map((c) => ({
    id: c.id,
    parent_id: c.parent_id || null,
    content: c.content,
    created_at: c.created_at,
    author: byId.get(c.user_id) || null,
  }));
}

// A public profile (only if profile_visibility = 'public') plus its public posts, or null.
async function publicProfile(handle) {
  const raw = String(handle || '').replace(/^@/, '');
  const user = /^\d+$/.test(raw)
    ? await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(raw))
    : await db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(raw);
  if (!user) return null;
  if ((user.profile_visibility || 'public') !== 'public') return null;
  const rows = await db.prepare(
    "SELECT p.* FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.user_id = ? AND p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "ORDER BY p.created_at DESC LIMIT 20"
  ).all(user.id);
  const followers = (await db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(user.id)).c;
  return { user: publicUser(user), posts: await decoratePosts(rows, 0), followersCount: followers, postsCount: rows.length };
}

// The public Discover feed: newest public content site-wide (personal public posts +
// posts in public communities), for a logged-out taste of the network and for SEO.
async function publicDiscover(limit) {
  const n = Math.min(Number(limit) || 30, 50);
  const rows = await db.prepare(
    "SELECT p.* FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "ORDER BY p.created_at DESC, p.id DESC LIMIT ?"
  ).all(n);
  return decoratePosts(rows, 0);
}

// Public communities (for a logged-out browse + the sitemap).
async function publicCommunities(limit) {
  const n = Math.min(Number(limit) || 30, 100);
  const rows = await db.prepare(
    "SELECT id, name, description FROM communities WHERE privacy = 'public' ORDER BY created_at DESC LIMIT ?"
  ).all(n);
  return rows;
}

// Entries for the sitemap: public posts (content-gated so thin one-liners are not
// advertised), public-profile usernames, and public community names, each with a
// last-modified date so Google has a freshness hint.
async function sitemapEntries() {
  const posts = await db.prepare(
    "SELECT p.id, p.created_at FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "AND (p.image != '' OR length(trim(coalesce(p.title,'') || ' ' || coalesce(p.content,''))) >= 80) " +
    "ORDER BY p.created_at DESC LIMIT 1000"
  ).all();
  // Only PUBLIC profiles that have actually authored public content: an empty profile is
  // thin (and already served noindex), so it should not be advertised in the sitemap.
  const users = await db.prepare(
    "SELECT DISTINCT u.username FROM users u JOIN posts p ON p.user_id = u.id LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE (u.profile_visibility IS NULL OR u.profile_visibility = 'public') AND u.username IS NOT NULL AND u.username != '' " +
    "AND p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "LIMIT 1000"
  ).all();
  const communities = await db.prepare("SELECT name, created_at FROM communities WHERE privacy = 'public' ORDER BY created_at DESC LIMIT 1000").all();
  return {
    posts: posts.map((r) => ({ id: r.id, lastmod: String(r.created_at || '').slice(0, 10) })),
    usernames: users.map((r) => r.username),
    communities: communities.map((r) => ({ name: r.name, lastmod: String(r.created_at || '').slice(0, 10) })),
  };
}

// 'YYYY-MM-DD HH:MM:SS' (SQLite/UTC) -> ISO 8601 'YYYY-MM-DDTHH:MM:SSZ' for schema/meta.
function isoDate(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  return /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? v.replace(' ', 'T') + 'Z' : v;
}

// Build the Open Graph / Twitter-card meta tags a scraper reads, plus a self-referencing
// canonical (dedupes ?utm= and id-vs-username variants) and a default branded share image
// so a card is never blank. Escaped + length-capped.
function ogMeta({ title, description, url, image, type, base, canonical, published, authorName }) {
  const t = esc(title).slice(0, 140);
  const d = esc(String(description || '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  const img = image || (base ? base.replace(/\/$/, '') + '/og.png' : '');
  const tags = [
    '<meta property="og:site_name" content="OpenBook">',
    '<meta property="og:type" content="' + esc(type || 'website') + '">',
    '<meta property="og:title" content="' + t + '">',
    '<meta property="og:description" content="' + d + '">',
    '<meta property="og:url" content="' + esc(url) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + t + '">',
    '<meta name="twitter:description" content="' + d + '">',
    '<meta name="description" content="' + d + '">',
  ];
  if (img) {
    tags.push('<meta property="og:image" content="' + esc(img) + '">');
    tags.push('<meta property="og:image:width" content="1200">');
    tags.push('<meta property="og:image:height" content="630">');
    tags.push('<meta name="twitter:image" content="' + esc(img) + '">');
  }
  if (canonical) tags.push('<link rel="canonical" href="' + esc(canonical) + '">');
  if (type === 'article' && published) tags.push('<meta property="article:published_time" content="' + esc(isoDate(published)) + '">');
  if (type === 'article' && authorName) tags.push('<meta property="article:author" content="' + esc(authorName) + '">');
  return tags.join('\n    ');
}

// A schema.org JSON-LD data block. type=application/ld+json is a non-executable data
// block, so it is NOT governed by the CSP script-src (browsers never run it). JSON.stringify
// escapes the values; we also neutralize a literal </script> just in case.
function jsonLd(obj) {
  return '<script type="application/ld+json">' + JSON.stringify(obj).replace(/<\/script/gi, '<\\/script') + '</script>';
}

function postJsonLd(post, url, base) {
  const a = post.author || {};
  const node = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: (post.title || String(post.content || '').slice(0, 110) || 'A post on OpenBook'),
    articleBody: post.content || '',
    url,
    datePublished: isoDate(post.created_at),
    author: { '@type': 'Person', name: a.name || 'OpenBook member', url: a.username ? base + '/u/' + a.username : undefined },
    commentCount: post.commentCount || 0,
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.score || 0 },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.commentCount || 0 },
    ],
  };
  return jsonLd(node);
}

function profileJsonLd(data, url, base) {
  const u = data.user || {};
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: u.name || 'OpenBook member',
      alternateName: u.username ? '@' + u.username : undefined,
      description: u.bio || undefined,
      url,
      image: u.avatar ? absUrl(base, u.avatar) : undefined,
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: data.followersCount || 0 },
    },
  });
}

function communityJsonLd(data, url) {
  const c = data.community || {};
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'o/' + c.name,
    description: c.description || undefined,
    url,
  });
}

// A public community by name (only if privacy='public') + its recent public posts. null otherwise.
async function publicCommunity(name) {
  const c = await db.prepare('SELECT * FROM communities WHERE name = ? COLLATE NOCASE').get(String(name || ''));
  if (!c || c.privacy !== 'public') return null;
  const rows = await db.prepare(
    "SELECT * FROM posts WHERE community_id = ? AND visibility = 'visible' AND announcement = 0 ORDER BY created_at DESC, id DESC LIMIT 30"
  ).all(c.id);
  const members = (await db.prepare('SELECT COUNT(*) c FROM community_members WHERE community_id = ?').get(c.id)).c;
  return { community: { id: c.id, name: c.name, description: c.description, icon: c.icon, created_at: c.created_at }, posts: await decoratePosts(rows, 0), memberCount: members };
}

// A post/profile with almost no text is "thin" for SEO; we noindex those (follow still
// lets link equity flow) and keep them out of the sitemap so Google does not judge the
// whole /p space as low quality on a young, low-content site.
function isThinPost(post) {
  if (!post) return true;
  if (post.image || post.linkPreview) return false; // an image/link card is not thin
  return String((post.title || '') + ' ' + (post.content || '')).trim().length < 80;
}

module.exports = {
  esc, absUrl, isoDate, isPublicPostRow, publicPost, publicComments, publicProfile,
  publicDiscover, publicCommunities, publicCommunity, sitemapEntries, ogMeta,
  jsonLd, postJsonLd, profileJsonLd, communityJsonLd, isThinPost,
};
