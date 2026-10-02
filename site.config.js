/* ------------------------------------------------------------------
   MCS SITE SETTINGS
   ------------------------------------------------------------------
   The things most likely to change live here, so you never have to
   touch the page markup. Leave a value as "" to hide what depends on it.
   ------------------------------------------------------------------ */

window.MCS = {
  // What players type in Minecraft. Shown in the nav button, the join
  // steps, and anywhere else the address appears.
  address: "play.mcsoccer.net",

  // The small line above the hero headline.
  versionLine: "Java Edition | Open Alpha",

  // Your Discord invite, e.g. "https://discord.gg/abc123". While this is
  // empty, Discord buttons say "Invite coming soon" and don't link anywhere.
  discordInvite: "https://discord.gg/RuAYjQfb7g",

  // The tier list site. The "Top of the tier list" section reads its
  // player data live, so it is always current.
  tierListUrl: "https://tiers.mcsoccer.net/",

  // Hero background video. Record 20-40s of a match, run
  // tools/make-hero.sh on it, and set these two. Until then the hero
  // shows an animated floodlit-pitch stand-in.
  heroVideo: "",   // "assets/video/hero.mp4"
  heroPoster: "",  // "assets/video/hero-poster.jpg"

  // Match history (/matches/). The game server publishes every match,
  // but only over plain http://, which browsers won't let an https://
  // site read. Put the HTTPS proxy's address here (the Cloudflare
  // Worker in tools/matches-proxy/worker.js), e.g.
  // "https://api.mcsoccer.net". While it's empty, the page says match
  // history is on its way.
  matchesApi: "https://api.mcsoccer.net",

  // The Sapphire store (/store/), sold through PayNow. This is the numeric
  // Store ID from PayNow's Dashboard > Store Settings. It's public, not a
  // secret (never put a PayNow API key anywhere on this site). While it's
  // empty, /store/ says the store is on its way, makes no calls to PayNow,
  // and the Store link stays out of the nav whatever storeOpen says.
  paynowStoreId: "606712387873013760",

  // false: /store/ still works in full (for PayNow's reviewers and $0 test
  // orders) but says the store isn't open yet, and the nav has no Store
  // link. true: the notice goes and the Store link shows on every page.
  // Opened 2026-10-02, after PayNow accepted the store.
  storeOpen: true,

  // Where buyers write about a purchase, e.g. "support@mcsoccer.net".
  // Shown wherever the store needs a contact. While it's empty the store
  // points to the Discord instead, but Mojang's rules and PayNow's review
  // both need a real, monitored email before the store opens.
  supportEmail: "mcsoccersupport@gmail.com",

  // PayNow's tax-inclusive pricing (Payment Settings), copied here: true if
  // it's on (buyers pay the price shown, tax included), false if it's off
  // (tax is added at checkout). The store only says "Includes 20% VAT" or
  // "Plus 20% VAT at checkout" when it can tell which; PayNow's reply
  // settles most cases, and this covers the rest. Leave it "" until the
  // setting is decided, and those cases show no tax line at all (the page
  // still says PayNow shows any tax before you pay).
  taxInclusive: "",

  // Testing only, and only on localhost: /store/?paynowApi=http://localhost:PORT
  // points the store at a local mock of PayNow's API, ?paynowStore=<id>
  // swaps the Store ID, and ?paynowTag=<slug> reads another product tag.
  // Each lasts for the tab. They do nothing on mcsoccer.net.
};
