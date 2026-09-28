/* ==================================================================
   MCS — mcsoccer.net
   Shared by every page. Each feature checks its markup exists first.
   ================================================================== */

(function () {
  "use strict";

  const CFG = window.MCS || {};
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => [...(root || document).querySelectorAll(s)];
  const has = (k) => Object.prototype.hasOwnProperty.call(CFG, k);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── config into the page ──────────────────────────────────────────
     A value set to "" hides whatever depends on it, as site.config.js
     promises. A value that's missing entirely (config failed to load)
     leaves the built-in defaults in the markup alone. */

  // Captured before anything can swap the label (e.g. to "Copied!"), so a
  // copy always puts the real address on the clipboard.
  const firstAddress = $("[data-address]");
  const ADDRESS = ((CFG.address || (firstAddress && firstAddress.textContent) || "") + "").trim();

  if (CFG.address) {
    $$("[data-address]").forEach((el) => (el.textContent = CFG.address));
  } else if (has("address")) {
    $$("[data-copy-address]").forEach((el) => (el.hidden = true));
  }

  if (CFG.versionLine) {
    $$("[data-version]").forEach((el) => (el.textContent = CFG.versionLine));
  } else if (has("versionLine")) {
    $$("[data-version]").forEach((el) => (el.hidden = true));
  }

  if (CFG.tierListUrl) {
    $$("[data-tierlist-link]").forEach((a) => (a.href = CFG.tierListUrl));
  } else if (has("tierListUrl")) {
    $$("[data-tierlist-link]").forEach((a) => {
      const li = a.closest("li");
      (li || a).hidden = true;
    });
  }

  const invite = (CFG.discordInvite || "").trim();

  $$("[data-discord-link]").forEach((a) => {
    if (!invite) return; // keeps its in-page fallback href (the Discord section)
    a.href = invite;
    a.target = "_blank";
    a.rel = "noopener";
  });

  $$("[data-discord-button]").forEach((a) => {
    if (invite) {
      a.href = invite;
      return;
    }
    a.removeAttribute("href");
    a.removeAttribute("target");
    a.setAttribute("aria-disabled", "true");
    const label = $("[data-discord-label]", a);
    if (label) label.textContent = "Invite coming soon";
  });

  $$("[data-year]").forEach((el) => (el.textContent = String(new Date().getFullYear())));

  /* ── one polite live region for status messages ────────────────── */

  const status = document.createElement("div");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  document.body.appendChild(status);
  let statusTimer = null;
  const announce = (msg) => {
    // Screen readers that honour aria-modal ignore everything outside an
    // open dialog, so inside the join modal use the region that lives there.
    const open = $(".modal.is-open [data-status]");
    const region = open || status;
    // clear first so repeating the same message is still announced
    region.textContent = "";
    clearTimeout(statusTimer);
    setTimeout(() => (region.textContent = msg), 50);
    statusTimer = setTimeout(() => (region.textContent = ""), 4000);
  };

  /* ── hero video ────────────────────────────────────────────────── */

  const media = $("[data-hero-media]");
  if (media && CFG.heroVideo) {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("aria-hidden", "true");
    if (CFG.heroPoster) v.poster = CFG.heroPoster;
    // A looping background with no pause control can't run for people who
    // asked for reduced motion (WCAG 2.2.2): they get a still frame.
    v.loop = !reduceMotion;
    v.preload = reduceMotion ? "metadata" : "auto";
    v.src = CFG.heroVideo;
    // a broken or missing file falls back to the stand-in underneath
    v.addEventListener("error", () => { v.remove(); media.classList.remove("has-video"); });
    v.addEventListener("loadeddata", () => media.classList.add("has-video"), { once: true });
    media.appendChild(v);
    if (!reduceMotion) {
      // the autoplay attribute is only a request; ask explicitly as well.
      // A rejection just means the browser is saving power; the poster shows.
      v.autoplay = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /* ── copy the server address ───────────────────────────────────── */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // clipboard API needs https or localhost; fall back to a selection,
      // and give focus back afterwards so keyboard users keep their place
      const prev = document.activeElement;
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      t.remove();
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      return ok;
    }
  }

  $$("[data-copy-address]").forEach((btn) => {
    let copiedAt = 0;
    let hovering = false;
    let timer = null;

    const revert = () => btn.classList.remove("is-copied");

    // Only a real mouse counts as hovering. A touch tap also fires
    // compatibility mouse events, which would pin the label on "Copied".
    btn.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hovering = true; });
    btn.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      hovering = false;
      if (!btn.classList.contains("is-copied")) return;
      // as on hoplite: swap back on leave, but never before a full second
      const wait = Math.max(0, 1000 - (Date.now() - copiedAt));
      clearTimeout(timer);
      timer = setTimeout(revert, wait);
    });

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!ADDRESS) return;
      const ok = await copyText(ADDRESS);
      if (!ok) return;
      announce("Server address copied");

      if ($(".slot", btn)) {
        copiedAt = Date.now();
        btn.classList.add("is-copied");
        clearTimeout(timer);
        timer = setTimeout(() => { if (!hovering) revert(); }, 2200);
      } else {
        // the inline chip in the join steps
        const label = $("[data-address]", btn);
        if (!label) return;
        label.textContent = "Copied!";
        setTimeout(() => (label.textContent = ADDRESS), 1400);
      }
    });
  });

  /* ── dialogs: the join modal and the mobile drawer ─────────────── */

  // everything outside an open dialog is made inert, which traps focus
  const backdropParts = () =>
    $$("body > nav, body > main, body > footer, body > aside, body > .modal").filter(Boolean);

  function openLayer(layer, extra) {
    if (!layer) return;
    layer._returnFocus = document.activeElement;
    layer._openedAt = Date.now();
    backdropParts().forEach((el) => { if (el !== layer) el.inert = true; });
    layer.inert = false;
    layer.setAttribute("aria-hidden", "false");
    layer.classList.add("is-open");
    if (extra) extra.classList.add("is-open");
    document.body.style.overflow = "hidden";
    const first = layer.querySelector("button, a[href], input");
    if (first) setTimeout(() => first.focus(), 30);
  }

  function closeLayer(layer, extra) {
    if (!layer || !layer.classList.contains("is-open")) return;
    layer.classList.remove("is-open");
    if (extra) extra.classList.remove("is-open");
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    backdropParts().forEach((el) => {
      if (el !== layer && !el.classList.contains("modal") && el.id !== "drawer") el.inert = false;
    });
    document.body.style.overflow = "";
    if (layer._returnFocus && layer._returnFocus.focus) layer._returnFocus.focus();
  }

  const modal = $("#connect");
  const drawer = $("#drawer");
  const scrim = $("[data-scrim]");
  const toggle = $("[data-drawer-open]");

  const closeDrawer = () => {
    closeLayer(drawer, scrim);
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  };

  $$("[data-open-connect]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      // closeDrawer, not closeLayer, so the toggle's aria-expanded resets too
      if (drawer && drawer.classList.contains("is-open")) closeDrawer();
      openLayer(modal);
    })
  );
  $$("[data-close-connect]").forEach((b) => b.addEventListener("click", () => closeLayer(modal)));

  if (modal) {
    // Close on the backdrop only when the press also STARTED there. That
    // stops a drag-select ending outside the box, or the second click of a
    // double-click that opened it, from closing the dialog.
    let downOnBackdrop = false;
    modal.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === modal; });
    modal.addEventListener("click", (e) => {
      if (e.target !== modal || !downOnBackdrop) return;
      if (Date.now() - (modal._openedAt || 0) < 350) return;
      closeLayer(modal);
    });
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      openLayer(drawer, scrim);
      toggle.setAttribute("aria-expanded", "true");
    });
  }
  $$("[data-drawer-close]").forEach((b) => b.addEventListener("click", closeDrawer));
  if (scrim) scrim.addEventListener("click", closeDrawer);
  if (drawer) $$("a", drawer).forEach((a) => a.addEventListener("click", closeDrawer));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal && modal.classList.contains("is-open")) return closeLayer(modal);
    if (drawer && drawer.classList.contains("is-open")) return closeDrawer();
  });

  /* ── game modes slider ─────────────────────────────────────────── */

  const MODES = [
    {
      key: "match",
      name: "Match",
      tag: "2 × 10 minute halves",
      desc:
        "Two timed halves with no score limit. Ends swap at half time, and whoever " +
        "didn't start with the ball kicks off the second half. Every half opens " +
        "with a backward-pass kickoff, and a coin flip decides who goes first.",
    },
    {
      key: "knockout",
      name: "Knockout",
      tag: "Extra time + penalties",
      desc:
        "Built for tournaments, because a knockout can't end level. A tie goes " +
        "to two five-minute halves of extra time, then a penalty shootout: three " +
        "takers and a keeper each, best of three, then sudden death.",
    },
    {
      key: "scrim",
      name: "Scrim",
      tag: "No clock",
      desc:
        "First to the goal limit wins, however long it takes. It opens with a " +
        "lob: the ball goes up from the centre spot and everyone scrambles for " +
        "it. No kickoff rule, just football.",
    },
    {
      key: "quick",
      name: "Quick Game",
      tag: "First to 5",
      desc:
        "The fastest way to play. No clock and no halves: the first team to " +
        "five goals takes it.",
    },
  ];

  const slider = $("[data-slider]");
  if (slider) {
    const panel = $("[data-mode-panel]", slider);
    const dotsWrap = $("[data-dots]", slider);
    const arts = $$("[data-art]", slider);
    let current = 0;
    let busy = false;

    const dots = MODES.map((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pg-dot";
      b.setAttribute("aria-label", m.name);
      b.innerHTML = "<i></i>";
      b.addEventListener("click", () => go(i, Math.sign(i - current)));
      dotsWrap.appendChild(b);
      return b;
    });

    function fill(i) {
      const m = MODES[i];
      $("[data-mode-name]", panel).textContent = m.name;
      $("[data-mode-desc]", panel).textContent = m.desc;
      $("[data-mode-tag]", panel).textContent = m.tag;
      dots.forEach((d, j) => d.setAttribute("aria-current", j === i ? "true" : "false"));
      arts.forEach((a) => a.classList.toggle("is-on", a.dataset.art === m.key));
    }

    // `dir` comes from the control the user pressed (+1 next, -1 previous),
    // so wrapping from the first mode back to the last still slides back.
    function go(i, dir) {
      i = (i + MODES.length) % MODES.length;
      if (i === current || busy) return;
      const forward = dir >= 0;
      busy = true;

      // text leaves one way, the new text arrives from the other
      panel.classList.add(forward ? "is-leaving-l" : "is-leaving-r");
      setTimeout(() => {
        current = i;
        fill(i);
        panel.classList.remove("is-leaving-l", "is-leaving-r");
        panel.classList.add(forward ? "is-entering-r" : "is-entering-l");
        void panel.offsetWidth;
        panel.classList.remove("is-entering-l", "is-entering-r");
        busy = false;
      }, 200);
    }

    $("[data-prev]", slider).addEventListener("click", () => go(current - 1, -1));
    $("[data-next]", slider).addEventListener("click", () => go(current + 1, +1));
    slider.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") go(current - 1, -1);
      if (e.key === "ArrowRight") go(current + 1, +1);
    });

    fill(0);
  }

  /* ── top of the tier list, read live from the tier list site ───── */

  const tierBox = $("[data-tier-top]");
  if (tierBox && !CFG.tierListUrl) {
    // no tier list configured (or config failed to load): don't leave a
    // "Loading…" box up forever
    tierBox.hidden = true;
  } else if (tierBox) {
    const list = $("[data-tier-players]", tierBox);
    const fail = (msg) => {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "tier-empty";
      li.textContent = msg;
      list.appendChild(li);
    };

    let dataUrl = null;
    try {
      const base = new URL(CFG.tierListUrl, location.href);
      base.search = "";
      base.hash = "";
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      dataUrl = new URL("data.js", base).href;
    } catch {}

    if (!dataUrl) {
      fail("The tier list couldn't be reached right now.");
    } else {
      const s = document.createElement("script");
      s.src = dataUrl;
      s.async = true;
      s.onload = () => {
        // data.js declares a global `const TIER_DATA`, which is reachable by
        // name from here even though it is not a property of window
        let data = null;
        try { data = typeof TIER_DATA !== "undefined" ? TIER_DATA : null; } catch {}
        const top = data && Array.isArray(data.tiers) && data.tiers[0];
        if (!top) return fail("The tier list couldn't be read right now.");

        list.innerHTML = "";
        ["high", "low"].forEach((band) => {
          (Array.isArray(top[band]) ? top[band] : []).forEach((name) => {
            name = String(name);
            const li = document.createElement("li");
            li.className = band === "low" ? "low" : "";
            if (typeof top.color === "string") li.style.setProperty("--rail", top.color);

            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            img.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/56`;
            img.onerror = () => {
              img.onerror = null;
              img.src = `https://minotar.net/helm/${encodeURIComponent(name)}/56`;
            };

            const n = document.createElement("span");
            n.textContent = name;
            const tag = document.createElement("small");
            tag.textContent = (band === "high" ? "HT" : "LT") + top.tier;

            li.append(img, n, tag);
            list.appendChild(li);
          });
        });

        if (!list.children.length) fail("Tier 1 is empty right now.");

        const up = data.meta && data.meta.updated;
        const upEl = $("[data-tier-updated]", tierBox);
        if (up && upEl) upEl.textContent = "Updated " + up;
      };
      s.onerror = () => fail("The tier list couldn't be reached right now.");
      document.head.appendChild(s);
    }
  }

  /* ── the cup: the nav link and the home banner ─────────────────────
     One look at /api/v1/tournaments/current per page load (soccer/docs/
     tournaments.md), through the same HTTPS proxy as match history. Until
     a clear answer names a cup, everything here stays hidden: a 404 (no
     cups on the game server yet), an error or a slow answer shows nothing
     to visitors. The cup page reuses this answer for its first draw. */

  // matchesApi, or on localhost a ?api=http://localhost:PORT override that
  // lasts for the tab (the same key matches.js uses)
  function apiBase() {
    let base = String(CFG.matchesApi || "").trim();
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      const q = new URLSearchParams(location.search).get("api");
      try {
        if (q) sessionStorage.setItem("mh-api", q);
        base = sessionStorage.getItem("mh-api") || base;
      } catch { if (q) base = q; }
    }
    if (!base) return "";
    try {
      const u = new URL(base, location.href);
      if (!/^https?:$/.test(u.protocol)) return "";
      if (location.protocol === "https:" && u.protocol === "http:") return "";
      return u.href.replace(/\/+$/, "");
    } catch { return ""; }
  }

  const cupItems = $$("[data-cup-nav]");
  const cupBanner = $("[data-cup-banner]");
  const cupLinks = $$("[data-cup-link]");
  const cupBase = cupItems.length || cupBanner || cupLinks.length ? apiBase() : "";

  if (cupBase) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const answer = fetch(cupBase + "/api/v1/tournaments/current", { headers: { Accept: "application/json" }, signal: ctl.signal })
      .then((res) => res.json().catch(() => null).then((body) => ({
        status: res.status, body, cache: (res.headers.get("X-MCS-Cache") || "").toUpperCase(),
      })))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    window.__mcsCup = { base: cupBase, answer };
    answer.then((res) => { try { showCup(res); } catch {} });
  }

  // the latest round among some matches ("Semifinals live now"), or the
  // earliest ("Quarterfinals up next")
  function roundOf(list, latest) {
    const pick = list.slice().sort((a, b) => (latest ? b.round - a.round : a.round - b.round))[0];
    return pick ? pick.name : "";
  }

  function showCup(res) {
    const d = res && res.status === 200 && res.body && typeof res.body === "object" ? res.body : null;
    const T = d && d.tournament && typeof d.tournament === "object" && !Array.isArray(d.tournament) ? d.tournament : null;
    if (!T) return;

    const live = d.live === true;
    const all = [];
    (Array.isArray(T.rounds) ? T.rounds : []).forEach((r) => {
      if (!r || !Array.isArray(r.matches)) return;
      const name = String(r.name || "").trim() || "Round " + (Number(r.round) || 1);
      r.matches.forEach((m) => { if (m && typeof m === "object") all.push({ state: m.state, round: Number(r.round) || 0, name }); });
    });
    const playing = live ? all.filter((m) => m.state === "LIVE") : [];

    cupItems.forEach((li) => {
      li.hidden = false;
      li.classList.toggle("is-live", live);
      li.classList.toggle("is-on", playing.length > 0);
      const a = $("a", li);
      if (!a) return;
      let note = $(".visually-hidden", a);
      if (!note) { note = document.createElement("span"); note.className = "visually-hidden"; a.appendChild(note); }
      note.textContent = playing.length ? " (live now)" : live ? " (on now)" : "";
    });
    cupLinks.forEach((el) => (el.hidden = false));
    $$("[data-cup-demote]").forEach((el) => el.classList.add("btn-dark"));

    // the home banner: only while the cup is open
    if (!cupBanner || !live) return;
    const name = String(T.name || "").trim() || "MCS Cup";
    const n = Number(T.teamCount) || 0, max = Number(T.maxTeams) || 0;
    let line = "";
    if (T.state === "SIGNUP") line = (max && n >= max ? "Sign-ups full " : "Sign-ups open ") + n + (max ? "/" + max : "");
    else if (T.state === "RUNNING") {
      if (playing.length) line = roundOf(playing, true) + " live now";
      else {
        const next = roundOf(all.filter((m) => m.state === "READY"), false) || roundOf(all.filter((m) => m.state === "WAITING"), false);
        line = next ? next + " up next" : "Bracket drawn";
      }
    } else return;

    const tag = $("[data-cup-banner-tag]", cupBanner);
    if (tag) {
      tag.classList.toggle("is-live", playing.length > 0);
      tag.innerHTML = playing.length
        ? '<i aria-hidden="true"></i>Live'
        : '<svg class="px" viewBox="0 0 16 16" aria-hidden="true"><path fill="#1f5a2e" d="M1 2h2v1H1zM1 3h1v2H1zM2 5h1v1H2zM13 2h2v1h-2zM14 3h1v2h-1zM13 5h1v1h-1zM11 2h2v4h-2zM10 6h2v1h-2zM9 7h2v1H9zM6 8h4v1H6zM7 9h2v1H7zM4 12h8v2H4zM3 14h10v1H3z"/><path fill="#0b1210" d="M3 2h8v4H3zM4 6h6v1H4zM5 7h4v1H5zM7 10h2v1H7zM5 11h6v1H5z"/><path fill="#3a6b2a" d="M3 1h10v1H3zM4 2h1v5H4z"/></svg>Cup';
    }
    const nm = $("[data-cup-banner-name]", cupBanner);
    const ln = $("[data-cup-banner-line]", cupBanner);
    if (nm) nm.textContent = name;
    if (ln) ln.textContent = line;
    cupBanner.hidden = false;
    // open the slot smoothly rather than shoving the headline down
    requestAnimationFrame(() => requestAnimationFrame(() => cupBanner.classList.add("is-on")));
  }

  /* ── scroll reveals ────────────────────────────────────────────────
     <head> added .reveal-on before first paint and armed a failsafe that
     removes it unless this flag is set. So if anything above threw, the
     page still shows everything instead of staying blank. */

  const root = document.documentElement;
  if (root.classList.contains("reveal-on")) {
    if (!("IntersectionObserver" in window)) {
      root.classList.remove("reveal-on");
    } else {
      const show = (el) => el.classList.add("is-in");
      const showAll = () => $$("[data-reveal]").forEach(show);

      // Reveal as soon as any part of a target is on screen (a little way
      // in from the bottom edge). An earlier version waited for 35% of each
      // feature card, which a card taller than ~2.9 viewports can never
      // reach: at 300-400% zoom its text and buttons stayed invisible.
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const t = en.target;
          if (t.hasAttribute("data-reveal-group")) $$("[data-reveal]", t).forEach(show);
          else show(t);
          io.unobserve(t);
        });
      }, { threshold: 0, rootMargin: "0px 0px -12% 0px" });

      $$("[data-reveal-group]").forEach((g) => io.observe(g));
      $$("[data-reveal]").forEach((el) => {
        if (!el.closest("[data-reveal-group]")) io.observe(el);
      });

      // Anything that takes keyboard focus must already be visible, and so
      // must the rest of its card, or you'd tab onto a button with no heading.
      document.addEventListener("focusin", (e) => {
        if (!e.target.closest) return;
        const group = e.target.closest("[data-reveal-group]");
        if (group) return $$("[data-reveal]", group).forEach(show);
        const el = e.target.closest("[data-reveal]");
        if (el) show(el);
      });

      // Printing never scrolls, so observers never fire: show everything.
      window.addEventListener("beforeprint", showAll);
    }
    window.__mcsRevealReady = true;
  }
})();
