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
};
