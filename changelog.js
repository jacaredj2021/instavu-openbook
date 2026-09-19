// changelog.js
// The official OpenBook account posts product updates (new features and bug fixes)
// to its own public feed, so anyone who follows it can see what is being built, in
// the open, and like / comment / share it. Entries are published at boot,
// idempotently: each has a stable slug claimed in the changelog table, so a restart
// never re-posts or duplicates an entry.
//
// To announce a new fix or feature, add an entry with a NEW unique slug below and it
// posts on the next deploy. Keep each one short and human.

const db = require('./db');
const { systemUserId } = require('./moderation');
const { logger } = require('./logger');

const CHANGELOG = [
  { slug: '2026-06-onboarding',
    body: 'Welcome to OpenBook! New members now get a friendly welcome message and a Get started guide, so it is easy to take your first steps: claim a username, make your first post, invite friends, and more.' },
  { slug: '2026-06-suggestions-roadmap',
    body: 'You steer what we build. Share an idea in the Suggestions box, everyone votes, and the most-wanted ideas rise to the top of the public roadmap. Every status change is logged in the open.' },
  { slug: '2026-06-edit-delete-dms',
    body: 'Messages can now be edited (an "edited" mark then shows) and deleted for everyone, just like you would expect. Your messages, your control.' },
  { slug: '2026-06-back-button',
    body: 'Fixed: the back button now returns you to the last page you were on instead of dropping you out of the app, and logged-in members no longer see a flash of the login screen.' },
  { slug: '2026-06-follow-openbook',
    body: 'This is the official OpenBook account. Follow it to see new features and bug fixes the moment they ship, and tell us what you think. We build in the open.' },
  { slug: '2026-06-google-passkey-login',
    body: 'Two new ways to sign in. You can now log in with Google, or set up a passkey and sign in with just your fingerprint, face, or device PIN (Face ID, Touch ID, or Windows Hello). Passkeys are passwordless, and your biometric never leaves your device, we only ever store a public key. Add one any time from Settings. As always, how you sign in is only your identity, it never affects your karma, standing, or reach.' },
  { slug: '2026-06-30-messages-and-clarity',
    body: 'UPDATE: Messages now has a search box, and the OpenBook account stays pinned to the top of your chats so you can always find it. We also labeled the up and down arrows as Vote so they are clear, gave the Get started panel a clear close button, made author avatars clickable to their profile, let you find people by their @username in search, and fixed scrolling in the OpenBook chat. Keep the feedback coming, it shapes what we build.' },
  { slug: '2026-06-30-terms-of-service',
    body: 'UPDATE: Added a plain-language Terms of Service page, linked in the footer next to the Privacy Policy. Like everything here it is short, readable, and lives in the open: you own what you post, here are the rules of the road, and money never buys influence.' },
  { slug: '2026-06-30-vote-control-polish',
    body: 'CHANGE: A small polish to the vote control. The Vote label now sits neatly under the up and down arrows instead of beside them, so the action row under each post stays clean on both desktop and mobile.' },
  { slug: '2026-06-30-mentions',
    body: 'UPDATE: You can now @mention people. Type @username in a post or comment and it turns into a clickable link to their profile, and they get notified. Use @friends to ping your friends, or @everyone to reach your friends and followers. Your privacy is respected: a friends-only post never notifies people who cannot see it. Two more: adding a friend now follows them automatically once they accept, and the Add friend and Follow buttons are the same size now.' },
  { slug: '2026-06-30-comments-and-drafts',
    body: 'FIX: Comments got some love. You can now edit your own comments (an edited mark then shows), clicking a comment no longer jumps you to the author profile by accident (only their name does), and we now remember an unsent post or comment for you, so if you navigate away by mistake and come back, what you were typing is still there.' },
  { slug: '2026-06-30-block-mute',
    body: 'UPDATE: You are in control of who can reach you. Open the More menu on anyone profile to Block them (a full two-way cutoff: no messages, mentions, follows, comments, or seeing each other anywhere, and any friendship is removed) or Mute them (quietly hide their posts from your feed without blocking). In Settings you can also choose who can @mention you: everyone, friends only, or no one, and manage your blocked and muted lists. Blocking and muting are private and never affect anyone karma, standing, or reach.' },
  { slug: '2026-07-01-block-hardening',
    body: 'FIX: We made blocking complete and instant. When you block someone you now disappear from each other everywhere, not just the main feed: community and group feeds and their member lists, search results, and even notifications from before the block. A block also can never touch anyone karma now, so you can no longer vote on or react to a blocked person comment. We also added a limit so a flood of brand-new accounts cannot spam your mentions. Blocking still only changes who can reach you, never anyone standing or reach.' },
  { slug: '2026-07-01-saves-reposts-search',
    body: 'UPDATE: Five new things to make OpenBook nicer to use. Save any post to a private bookmarks list that only you can see. Repost to share a post with your own followers, with an optional comment. Search across people, communities, and posts from the top bar. Link previews turn a bare link into a titled card. And content warnings let you blur a sensitive post behind a short label, so hard topics can exist without being forced on anyone. None of these touch karma, standing, or reach.' },
  { slug: '2026-07-01-profile-actions-layout',
    body: 'FIX: On a profile, the action buttons (Message, Friends, Follow, and the rest) now sit in a tidy two-up grid instead of one long row, so the name and stats get their space back and no longer get squeezed. A small polish for a cleaner profile header on desktop and mobile.' },
  { slug: '2026-07-02-shareable-public',
    body: 'UPDATE: Your public posts and profile are now shareable to anyone, even people without an account. Share a link and it shows a proper preview, and it opens to the real content with a friendly Join button. Search engines can find public OpenBook content too, so the more we share, the more OpenBook grows the honest way. Friends-only posts and private profiles stay completely private, as always.' },
  { slug: '2026-07-02-new-here',
    body: 'UPDATE: A warmer welcome for new members. A fresh account now lands on Invite friends, your Home feed fills up with Discover so it is never empty on day one, and the sign-up page shows how many of the first 5000 founding spots are left. Founders keep the Pioneer badge forever.' },
  { slug: '2026-07-02-discoverable',
    body: 'UPDATE: OpenBook is much easier to find and share now. Every public community has its own shareable page, there is an Explore page and a What is new page anyone can browse, and shared links show a proper preview image. Search engines can now understand and index our public content, so people can discover OpenBook on Google, the honest way. Private posts, private profiles, and private communities stay completely private, as always.' },
  { slug: '2026-07-04-mobile-action-row',
    body: 'FIX: On phones the row of buttons under each post (like, comment, share, save, report) was too cramped. It now shows clean, easy-to-tap icons on small screens, with the text labels still there on bigger screens and a tooltip on each. The share count still shows next to the share icon.' },
  { slug: '2026-07-04-menu-and-theme',
    body: 'CHANGE: We tidied the left menu into a clearer order (Get started, Friends, Groups, Saved, Invite friends, Jury duty, Suggest us, Support OpenBook), and moved the light and dark switch up to the top bar as a quick moon or sun button so it is always one tap away. The Suggestions page is now called Suggest us.' },
  { slug: '2026-07-05-message-notifications',
    body: 'UPDATE: You can now be notified about new messages. Turn on notifications in Settings and a new direct message reaches you with a sound and a red count on the OpenBook app icon, even when OpenBook is closed. It works best on your phone once you add OpenBook to your home screen. It is fully your choice: opt in per device, turn it off any time, and like everything here it never touches anyone karma, standing, or reach.' },
  { slug: '2026-07-05-notifications-guide',
    body: 'CHANGE: The Notifications section in Settings now has a short step-by-step guide showing exactly how to turn message notifications on: add OpenBook to your home screen, open it from that icon, then tap Allow. It also explains that on a computer you can skip the home-screen step, and what to do if you tapped Block by mistake.' },
];

async function publishChangelog() {
  try {
    await db.exec(
      "CREATE TABLE IF NOT EXISTS changelog (slug TEXT PRIMARY KEY, post_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    const sysId = await systemUserId();
    let posted = 0;
    for (const entry of CHANGELOG) {
      // Atomic claim on the slug (PRIMARY KEY): only the first run posts it.
      const claim = await db.prepare('INSERT OR IGNORE INTO changelog (slug) VALUES (?)').run(entry.slug);
      if (!claim.changes) continue; // already posted
      try {
        const info = await db.prepare(
          "INSERT INTO posts (user_id, content, audience, type, visibility) VALUES (?, ?, 'public', 'text', 'visible')"
        ).run(sysId, entry.body);
        await db.prepare('UPDATE changelog SET post_id = ? WHERE slug = ?').run(info.lastInsertRowid, entry.slug);
        posted++;
      } catch (e) {
        try { logger.warn({ err: e, slug: entry.slug }, 'changelog post insert failed'); } catch (_) {}
      }
    }
    if (posted) logger.info({ posted }, 'published OpenBook changelog posts');
    return posted;
  } catch (e) {
    try { logger.warn({ err: e }, 'publishChangelog failed'); } catch (_) {}
    return 0;
  }
}

module.exports = { publishChangelog, CHANGELOG };
