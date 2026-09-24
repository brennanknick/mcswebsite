/* ==================================================================
   MCS — match history (/matches/)

   Reads the game server's match-history API (docs: soccer/docs/
   match-history.md) through the HTTPS proxy set as `matchesApi` in
   site.config.js. The API itself is plain http:// on the game server,
   which a browser won't fetch from an https:// page.

   Every view lives on this one page, routed by the query string, so a
   static host can serve all of them:
     ./                       matches   (?mode= &field= &results=1 &page=)
     ./?m=<match id>          match report
     ./?p=<uuid>              player    (?mode= &page=)
     ./?tab=leaders           leaderboards (?stat= &mode= &limit=)
     ./?tab=players           player search
   404.html sends the game's /matches/<id> style chat links here.
   ================================================================== */

(function () {
  "use strict";

  const main = document.querySelector("[data-mh]");
  if (!main) return;

  const CFG = window.MCS || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = $("[data-mh-view]");
  const head = $("[data-mh-head]");
  const tabs = $("[data-mh-tabs]");
  const counters = $("[data-mh-counters]");
  const liveBox = $("[data-mh-live]");
  const liveList = $("[data-mh-live-list]");
  const staleNote = $("[data-mh-stale]");
  const searchSlot = $("[data-mh-search]");

  /* ── what the data looks like ──────────────────────────────────── */

  const ID_RE = /^\d{8}-\d{6}-[a-z0-9_]{1,40}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const CREST_RE = /^[0-9a-f]{4,5}$/;
  const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
  const SIDES = ["RED", "BLUE"];

  const MODES = { MATCH: "Match", SCRIM: "Scrim", QUICK: "Quick game" };
  const POSITIONS = {
    GK: "Goalkeeper", CB: "Center Back", LD: "Left Defense", RD: "Right Defense",
    LW: "Left Wing", RW: "Right Wing", FW: "Forward",
  };

  // leaderboards: [api key, label, kind, what it means]
  const STATS = [
    ["goals", "Goals", "count", "Goals scored. Own goals don't count."],
    ["assists", "Assists", "count", "Passes caught in the air that went straight into a goal."],
    ["ga", "Goals + assists", "count", "Goals and assists together."],
    ["wins", "Wins", "count", "Matches won."],
    ["winrate", "Win rate", "rate", "Share of matches won. A draw counts as not won."],
    ["mvps", "MVPs", "count", "Player of the match awards."],
    ["cleansheets", "Clean sheets", "count", "In goal at full time, and the other side didn't score."],
    ["saves", "Saves", "count", "Shots caught by the keeper, and balls stopped on the line."],
    ["steals", "Steals", "count", "Tackles that won the ball."],
    ["tackles", "Tackles", "count", "Hits on the player with the ball."],
    ["interceptions", "Interceptions", "count", "The other side's balls caught in the air."],
    ["rating", "Rating", "rate", "Average match rating, from 3.0 to 10.0."],
    ["games", "Matches", "count", "Matches played to a result."],
    ["possession", "On the ball", "time", "Total time holding the ball."],
  ];
  const STAT = Object.fromEntries(STATS.map((s) => [s[0], s]));

  /* ── small helpers ─────────────────────────────────────────────── */

  const str = (v) => (typeof v === "string" ? v : "");
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, "0");
  let uid = 0;

  // Build DOM. Strings always become text, never markup, because every
  // name in this data is typed by a player. `html` is for the constant
  // icon markup below and nothing else.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style") for (const p in v) { if (v[p] != null) el.style.setProperty(p, String(v[p])); }
        else if (k === "on") for (const ev in v) el.addEventListener(ev, v[ev]);
        else if (k === "html") el.innerHTML = v;
        else if (k === "state") el._state = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const c of kids) {
      if (c == null || c === false || c === "") continue;
      if (Array.isArray(c)) append(el, c);
      else el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }
  const vh = (text) => h("span", { class: "visually-hidden" }, text);

  /* pixel icons: constant markup, one unit per pixel */
  const ICONS = {
    ball: ["0 0 8 8", "M2 0h4v1h1v1h1v4H7v1H6v1H2V7H1V6H0V2h1V1h1z", "M3 2h2v1h1v2H5v1H3V5H2V3h1z"],
    boot: ["0 0 8 8", "M2 0h3v3H2zM2 3h4v1H2zM2 4h6v1H2zM0 5h8v2H0zM1 7h1v1H1zM3 7h1v1H3zM5 7h1v1H5z"],
    star: ["0 0 9 9", "M4 0h1v2H4zM3 2h3v1H3zM0 3h9v1H0zM1 4h7v1H1zM2 5h5v1H2zM2 6h2v1H2zM5 6h2v1H5zM1 7h2v1H1zM6 7h2v1H6zM1 8h1v1H1zM7 8h1v1H7z"],
    glove: ["0 0 8 8", "M1 0h1v2H1zM3 0h1v2H3zM5 0h1v2H5zM7 1h1v1H7zM1 2h7v1H1zM0 3h8v2H0zM1 5h7v1H1zM2 6h5v2H2z"],
    cross: ["0 0 10 10", "M0 0h2v2H0zM8 0h2v2H8zM2 2h2v2H2zM6 2h2v2H6zM4 4h2v2H4zM2 6h2v2H2zM6 6h2v2H6zM0 8h2v2H0zM8 8h2v2H8z"],
    check: ["0 0 9 7", "M8 0h1v1H8zM7 1h2v1H7zM6 2h2v1H6zM0 3h1v1H0zM5 3h2v1H5zM0 4h2v1H0zM4 4h2v1H4zM1 5h4v1H1zM2 6h2v1H2z"],
    arrow: ["0 0 7 7", "M3 0h1v1H3zM4 1h1v1H4zM5 2h1v1H5zM0 3h7v1H0zM5 4h1v1H5zM4 5h1v1H4zM3 6h1v1H3z"],
    flag: ["0 0 8 8", "M1 0h1v8H1zM2 0h6v1H2zM2 1h5v1H2zM2 2h6v1H2zM2 3h5v1H2z"],
    trophy: ["0 0 9 8", "M1 0h7v1H1zM0 1h1v2H0zM8 1h1v2H8zM1 3h1v1H1zM7 3h1v1H7zM2 1h5v3H2zM3 4h3v1H3zM4 5h1v1H4zM2 7h5v1H2zM3 6h3v1H3z"],
    search: ["0 0 9 9", "M2 0h3v1H2zM1 1h1v1H1zM5 1h1v1H5zM0 2h1v3H0zM6 2h1v3H6zM1 5h1v1H1zM5 5h1v1H5zM2 6h3v1H2zM6 6h1v1H6zM7 7h1v1H7zM8 8h1v1H8z"],
    tri: ["0 0 10 17", "M0 0h2v2h2v2h2v2h2v2h2v1h-2v2H6v2H4v2H2v2H0z"],
    copy: ["0 0 16 16", "M5 1h10v10h-2V3H5zM1 5h10v10H1zM3 7v6h6V7z"],
    dot: ["0 0 6 6", "M1 0h4v1h1v4H5v1H1V5H0V1h1z"],
    pencil: ["0 0 8 8", "M6 0h1v1h1v1H7v1H6v1H5v1H4v1H3v1H2v1H0V6h1V5h1V4h1V3h1V2h1V1h1z"],
    pause: ["0 0 6 7", "M0 0h2v7H0zM4 0h2v7H4z"],
  };
  function icon(name, cls) {
    const d = ICONS[name];
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", d[0]);
    svg.setAttribute("class", "px mh-i mh-i-" + name + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    for (let i = 1; i < d.length; i++) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d[i]);
      if (i > 1) p.setAttribute("class", "mh-i-cut");
      if (name === "copy") p.setAttribute("fill-rule", "evenodd");
      svg.appendChild(p);
    }
    return svg;
  }

  /* ── colours: team colours come from the game (one of Minecraft's 16
     chat colours), so pick readable text for them and lift the darkest
     ones (black, dark blue) enough to show up on this dark page ── */

  function hex(c, fallback) { return typeof c === "string" && HEX_RE.test(c) ? c.toLowerCase() : fallback; }
  function lum(c) {
    const n = parseInt(c.slice(1), 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function mix(c, d, t) {
    const a = parseInt(c.slice(1), 16), b = parseInt(d.slice(1), 16);
    const m = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
    return "#" + [16, 8, 0].map((sh) => pad2(m(sh).toString(16))).join("");
  }
  const onColor = (c) => (lum(c) > 0.18 ? "#0b1210" : "#ffffff");
  const vivid = (c) => (lum(c) < 0.045 ? mix(c, "#ffffff", 0.42) : c);
  function sideVars(s) {
    return { "--c": s.color, "--cv": vivid(s.color), "--on": onColor(s.color) };
  }

  // one side of a record, a list row or a live board, however it came
  function sideOf(o, key) {
    const s = obj(obj(o).teams)[key];
    const t = obj(s);
    const club = t.club && typeof t.club === "object" ? t.club : null;
    return {
      key,
      name: str(t.name).trim() || (key === "RED" ? "Red" : "Blue"),
      color: hex(t.color, key === "RED" ? "#ff5555" : "#55ffff"),
      crest: crestHex(t.crest || (club && club.crest)),
      club,
      players: arr(t.players),
      stats: t.stats && typeof t.stats === "object" ? t.stats : null,
    };
  }
  const crestHex = (v) => (typeof v === "string" && CREST_RE.test(v) ? v : "");
  const nameOf = (who) => {
    const n = str(obj(who).name).trim();
    return n || str(obj(who).uuid).slice(0, 8) || "Unknown player";
  };

  /* ── time ──────────────────────────────────────────────────────── */

  const F = {
    time: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }),
    day: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }),
    dayYear: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }),
    full: new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    date: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }),
  };
  let skew = 0; // server clock minus ours, from /live's `now`
  const serverNow = () => Date.now() + skew;

  function dayLabel(ms) {
    const d = new Date(ms), now = new Date(serverNow());
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 864e5);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.getFullYear() === now.getFullYear() ? F.day.format(d) : F.dayYear.format(d);
  }
  function ago(ms) {
    const s = Math.max(0, (serverNow() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) { const n = Math.floor(s / 3600); return n + (n === 1 ? " hour ago" : " hours ago"); }
    const n = Math.floor(s / 86400);
    if (n < 30) return n + (n === 1 ? " day ago" : " days ago");
    return "on " + F.date.format(new Date(ms));
  }
  // seconds as m:ss, or h:mm:ss past an hour
  function clockOf(sec) {
    sec = Math.max(0, Math.round(num(sec)));
    const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h_ ? h_ + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }
  function minutesText(sec) {
    sec = Math.round(num(sec));
    if (sec < 60) return sec + " s";
    const m = Math.floor(sec / 60);
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + pad2(m % 60) + " min";
  }

  /* ── the API ───────────────────────────────────────────────────── */

  // Base URL of the proxy. On localhost you can point the page anywhere
  // with ?api=http://localhost:25543 for testing; that override is
  // ignored on the real site so nobody can dress other data up as ours.
  const API = (function () {
    let base = str(CFG.matchesApi).trim();
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
      // an https page can't read an http API: that needs the proxy
      if (location.protocol === "https:" && u.protocol === "http:") {
        console.warn("[matches] matchesApi must be an https:// address on an https:// site:", base);
        return "";
      }
      return u.href.replace(/\/+$/, "");
    } catch { return ""; }
  })();

  class ApiError extends Error {
    constructor(kind, status) { super(kind); this.kind = kind; this.status = status || 0; }
  }

  const memo = new Map(); // url -> { t, data }
  let staleSeen = false;

  function noteCache(res) {
    const c = (res.headers.get("X-MCS-Cache") || "").toUpperCase();
    if (c === "STALE") staleSeen = true;
  }

  // GET a JSON route. `ttl` is how long a copy stays good in memory
  // (0 = always ask). Retries the API's two "try again" states: 503 busy
  // or loading, and a 200 whose body says "loading": true.
  async function get(path, params, ttl) {
    const url = new URL(API + "/api/v1" + path);
    if (params) {
      for (const k in params) {
        const v = params[k];
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const key = url.href;
    const hit = memo.get(key);
    if (ttl && hit && Date.now() - hit.t < ttl) return hit.data;

    for (let attempt = 0; ; attempt++) {
      let res, body = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      try {
        // no custom headers: anything beyond Accept would need a CORS
        // preflight, which the game server doesn't answer
        res = await fetch(key, { headers: { Accept: "application/json" }, signal: ctl.signal });
        body = await res.json().catch(() => null);
      } catch {
        clearTimeout(timer);
        if (hit) { staleSeen = true; return hit.data; }
        throw new ApiError("offline");
      }
      clearTimeout(timer);
      noteCache(res);

      if (res.status === 503 && attempt < 3) { await sleep(2000); continue; }
      if (res.status === 404) throw new ApiError("notfound", 404);
      if (!res.ok) {
        if (hit) { staleSeen = true; return hit.data; }
        throw new ApiError(res.status === 503 ? (body && body.loading ? "loading" : "busy") : "server", res.status);
      }
      if (!body || typeof body !== "object") throw new ApiError("server", res.status);
      if (body.loading === true) {
        if (attempt < 4) { await sleep(2000); continue; }
        throw new ApiError("loading");
      }
      if (ttl) {
        memo.set(key, { t: Date.now(), data: body });
        if (memo.size > 250) memo.delete(memo.keys().next().value);
      }
      return body;
    }
  }

  // lists and counts change when a match ends; records never do
  function forgetLists() {
    for (const k of [...memo.keys()]) {
      if (!/\/api\/v1\/matches\/\d{8}-/.test(k)) memo.delete(k);
    }
  }

  let metaPromise = null;
  function getMeta(fresh) {
    if (fresh || !metaPromise) {
      metaPromise = get("/meta", null, 30000).catch((e) => { metaPromise = null; throw e; });
    }
    return metaPromise;
  }

  /* ── pictures of people and clubs ──────────────────────────────── */

  function initialTile(name, cls) {
    const ch = (str(name).match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    return h("span", { class: "mh-ava mh-ava-x " + (cls || ""), "aria-hidden": "true" }, ch);
  }
  // Heads by UUID, never by name (a name can belong to someone else
  // later). mc-heads first, minotar if that fails, then an initial.
  function avatar(uuid, name, size, cls) {
    if (!UUID_RE.test(str(uuid))) return initialTile(name, cls);
    const img = h("img", {
      class: "mh-ava " + (cls || ""), alt: "", width: size, height: size, loading: "lazy", decoding: "async",
      src: `https://mc-heads.net/avatar/${uuid}/${size * 2}`,
    });
    img.addEventListener("error", function once() {
      img.removeEventListener("error", once);
      img.addEventListener("error", () => img.replaceWith(initialTile(name, cls)), { once: true });
      img.src = `https://minotar.net/helm/${uuid.replace(/-/g, "")}/${size * 2}`;
    });
    return img;
  }

  // A club crest from the game's resource pack, or a pixel shield in the
  // side's colour with its initial. Crests can vanish from the pack at
  // any time, so the shield is always the fallback.
  function shield(side, size) {
    const letter = (side.name.match(/[A-Za-z0-9]/) || [side.key[0]])[0].toUpperCase();
    const wrap = h("span", { class: "mh-crest mh-crest-" + (size || "md"), style: sideVars(side), "aria-hidden": "true" });
    wrap.innerHTML =
      '<svg class="px" viewBox="0 0 12 14"><path class="mh-shield-edge" d="M0 0h12v8h-1v2h-1v1H9v1H8v1H7v1H5v-1H4v-1H3v-1H2v-1H1V8H0z"/>' +
      '<path class="mh-shield-fill" d="M1 1h10v7h-1v2H9v1H8v1H7v1H5v-1H4v-1H3v-1H2V8H1z"/><path class="mh-shield-shine" d="M1 1h10v2H1z"/></svg>';
    wrap.appendChild(h("b", null, letter));
    if (side.crest && API) {
      const img = h("img", { class: "mh-crest-img", alt: "", loading: "lazy", decoding: "async", src: `${API}/crest/${side.crest}.png` });
      img.addEventListener("load", () => wrap.classList.add("has-img"));
      img.addEventListener("error", () => img.remove());
      wrap.appendChild(img);
    }
    return wrap;
  }

  function clubChip(club) {
    if (!club || !str(club.name)) return null;
    const c = hex(club.color, "#aaaaaa");
    const side = { key: "RED", name: club.name, color: c, crest: crestHex(club.crest) };
    return h("span", { class: "mh-club", style: sideVars(side) }, shield(side, "xs"), h("span", null, club.name));
  }

  function ratingBadge(r, big) {
    r = num(r);
    const tier = r >= 8 ? "top" : r >= 7 ? "good" : r >= 6 ? "ok" : "low";
    return h("span", { class: "mh-rating is-" + tier + (big ? " is-big" : ""), title: "Match rating" }, r.toFixed(1));
  }

  function resultBadge(res) {
    const t = { W: "Win", D: "Draw", L: "Loss" }[res];
    if (!t) return null;
    return h("span", { class: "mh-wdl is-" + res.toLowerCase(), title: t }, res, vh(" (" + t + ")"));
  }

  const modeName = (m) => MODES[m] || (str(m) ? str(m).charAt(0) + str(m).slice(1).toLowerCase() : "Match");
  function modeTag(mode, knockout) {
    return h("span", { class: "mh-tag is-" + str(mode).toLowerCase() }, knockout && mode === "MATCH" ? "Knockout" : modeName(mode));
  }

  const OUTCOME = { STOPPED: "Stopped", ABANDONED: "Abandoned", INTERRUPTED: "Interrupted" };

  // the short status under a score: FT, AET, Pens...
  function statusShort(o) {
    if (o.outcome !== "COMPLETED") return OUTCOME[o.outcome] || str(o.outcome) || "Unfinished";
    const by = obj(o.result).decidedBy;
    if (by === "EXTRA_TIME") return "AET";
    if (by === "SHOOTOUT") return "Pens";
    if (by === "COIN_FLIP") return "Coin flip";
    if (by === "REFEREE") return "Ref's call";
    return o.mode === "MATCH" ? "FT" : "Final";
  }

  const pensShown = (so) => so && num(so.RED) + num(so.BLUE) > 0;

  /* ── live region, titles, clipboard ────────────────────────────── */

  const status = h("div", { class: "visually-hidden", role: "status" });
  document.body.appendChild(status);
  function announce(msg) {
    status.textContent = "";
    setTimeout(() => (status.textContent = msg), 60);
  }
  const setTitle = (t) => (document.title = (t ? t + " — " : "") + "MCS");

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const prev = document.activeElement;
      const t = h("textarea", { readonly: true, style: { position: "fixed", top: "0", opacity: "0" } });
      t.value = text;
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      t.remove();
      if (prev && prev.focus) prev.focus({ preventScroll: true });
      return ok;
    }
  }

  // buttons made after load can't use site.js's data-open-connect wiring,
  // so they press the footer's "How to join" link instead
  function openConnect() {
    const a = $("footer [data-open-connect]");
    if (a) a.click();
  }

  /* ── routing ───────────────────────────────────────────────────── */

  const modeParam = (v) => { v = str(v).toUpperCase(); return MODES[v] ? v : ""; };
  const pageParam = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 1e6 ? n : 1; };

  function parseRoute(search) {
    const q = new URLSearchParams(search);
    if (q.has("m")) return { view: "match", id: str(q.get("m")).trim() };
    if (q.has("p")) return { view: "player", uuid: str(q.get("p")).trim().toLowerCase(), mode: modeParam(q.get("mode")), page: pageParam(q.get("page")) };
    const tab = q.get("tab");
    if (tab === "leaders") {
      const stat = str(q.get("stat")).toLowerCase();
      const lim = parseInt(q.get("limit"), 10);
      return { view: "leaders", stat: STAT[stat] ? stat : "goals", mode: modeParam(q.get("mode")), limit: lim === 50 || lim === 100 ? lim : 25 };
    }
    if (tab === "players") return { view: "players", q: str(q.get("q")).trim().slice(0, 16) };
    const field = str(q.get("field")).trim();
    return {
      view: "list",
      mode: modeParam(q.get("mode")),
      field: /^[a-z0-9_]{1,40}$/.test(field) ? field : "",
      results: q.get("results") === "1",
      page: pageParam(q.get("page")),
    };
  }

  function href(r) {
    const q = new URLSearchParams();
    switch (r.view) {
      case "match": q.set("m", r.id); break;
      case "player":
        q.set("p", r.uuid);
        if (r.mode) q.set("mode", r.mode);
        if (r.page > 1) q.set("page", r.page);
        break;
      case "leaders":
        q.set("tab", "leaders");
        if (r.stat && r.stat !== "goals") q.set("stat", r.stat);
        if (r.mode) q.set("mode", r.mode);
        if (r.limit && r.limit !== 25) q.set("limit", r.limit);
        break;
      case "players":
        q.set("tab", "players");
        if (r.q) q.set("q", r.q);
        break;
      default:
        if (r.mode) q.set("mode", r.mode);
        if (r.field) q.set("field", r.field);
        if (r.results) q.set("results", "1");
        if (r.page > 1) q.set("page", r.page);
    }
    const s = q.toString();
    return "./" + (s ? "?" + s : "");
  }
  const toMatch = (id, number) => h("a", { href: href({ view: "match", id }), "data-go": true, state: number ? { number } : null });
  const toPlayer = (uuid) => href({ view: "player", uuid });

  function go(url, opts) {
    opts = opts || {};
    const u = new URL(url, location.href);
    const next = u.pathname + u.search;
    if (opts.replace) history.replaceState(opts.state || null, "", next);
    else history.pushState(opts.state || null, "", next);
    render({ nav: true, keep: opts.keep });
  }

  const samePage = (u) => u.origin === location.origin &&
    u.pathname.replace(/index\.html$/, "") === location.pathname.replace(/index\.html$/, "");

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-go]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const u = new URL(a.getAttribute("href"), location.href);
    if (!samePage(u)) return;
    e.preventDefault();
    go(u.href, { state: a._state, keep: a.hasAttribute("data-keep") });
  });

  window.addEventListener("popstate", () => render({ nav: true, pop: true }));
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  /* ── the page frame ────────────────────────────────────────────── */

  const S = { route: null, token: 0, lastList: "./", firstRender: true };

  function setChrome(r) {
    const index = r.view === "list" || r.view === "leaders" || r.view === "players";
    head.hidden = !index;
    tabs.hidden = !index || !API;
    counters.hidden = !index || !API || !counters.children.length;
    $$("a", tabs).forEach((a) => {
      if (a.dataset.tab === r.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (r.view === "list") liveStart();
    else liveStop();
  }

  function swap(nodes, quiet) {
    view.replaceChildren(...nodes.filter(Boolean));
    view.removeAttribute("aria-busy");
    view.classList.remove("is-loading");
    // stagger the top-level blocks in, but only on a real change of view:
    // a new filter or page shouldn't make everything bounce again
    if (!quiet) {
      [...view.children].forEach((el, i) => {
        el.classList.add("mh-in");
        el.style.setProperty("--i", Math.min(i, 8));
      });
    }
    staleNote.hidden = !staleSeen;
  }

  function skeleton(kind) {
    const bar = (w) => h("i", { class: "mh-sk", style: { "--w": w } });
    if (kind === "match" || kind === "player") {
      return [
        h("div", { class: "mh-sk-hero" }, bar("30%"), bar("55%"), bar("40%")),
        h("div", { class: "mh-sk-grid" }, h("div", { class: "mh-sk-card" }, bar("60%"), bar("80%"), bar("70%")), h("div", { class: "mh-sk-card" }, bar("70%"), bar("50%"), bar("65%"))),
      ];
    }
    return [h("div", { class: "mh-sk-list" }, [0, 1, 2, 3, 4, 5].map((i) =>
      h("div", { class: "mh-sk-row", style: { "--i": i } }, bar("14%"), bar("58%"), bar("16%"))))];
  }

  async function render(opts) {
    opts = opts || {};
    const r = parseRoute(location.search);
    const prev = S.route;
    S.route = r;
    const token = ++S.token;
    staleSeen = false;

    // /?p=ABC-... is accepted, and quietly put into its lower-case form
    if (r.view === "player" && new URLSearchParams(location.search).get("p") !== r.uuid) {
      history.replaceState(history.state, "", location.pathname + href(r).replace(/^\.\//, ""));
    }
    if (r.view === "list") S.lastList = href(r);

    setChrome(r);

    const same = prev && prev.view === r.view && prev.id === r.id && prev.uuid === r.uuid;
    const focusKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focus;

    if (!API) {
      setTitle("Match History");
      swap(unconfigured());
      return;
    }

    view.setAttribute("aria-busy", "true");
    if (same && view.children.length) view.classList.add("is-loading");
    else view.replaceChildren(...skeleton(r.view));

    if (opts.nav && !same) window.scrollTo(0, 0);
    else if (opts.nav && same && !opts.keep) {
      const top = (tabs.hidden ? view : tabs).getBoundingClientRect().top;
      if (top < 0) window.scrollTo({ top: window.scrollY + top - 110, behavior: reduceMotion ? "auto" : "smooth" });
    }

    try {
      const nodes = await VIEWS[r.view](r, token);
      if (token !== S.token || !nodes) return;
      swap(nodes, same);
    } catch (e) {
      if (token !== S.token) return;
      console.warn("[matches]", e);
      swap(problem(e, r));
    }

    if (token !== S.token) return;
    // keyboard users keep their place: refocus the control they used, or
    // land on the new view's heading after a real page change
    const again = focusKey && $(`[data-focus="${CSS.escape(focusKey)}"]`, main);
    if (again) again.focus({ preventScroll: true });
    else if (opts.nav && !same) {
      const hd = $("h1, h2", view);
      if (hd) { hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); }
    }
    if (opts.nav && !S.firstRender) announce(document.title.replace(/ — MCS$/, ""));
    S.firstRender = false;
  }

  /* ── states: not set up, offline, empty ────────────────────────── */

  function note(kind, title, text, actions) {
    return h("div", { class: "mh-note is-" + kind },
      h("div", { class: "mh-note-board", "aria-hidden": "true" },
        h("span", null, kind === "off" ? "–" : "0"), h("i", null, ":"), h("span", null, kind === "off" ? "–" : "0")),
      h("h2", null, title),
      h("p", null, text),
      actions && actions.length ? h("div", { class: "mh-note-actions" }, actions) : null);
  }
  const arrowBtn = (label, attrs) => h(attrs.href ? "a" : "button", Object.assign({ class: "btn" }, attrs.href ? {} : { type: "button" }, attrs),
    label, icon("tri", "arrow"));

  function unconfigured() {
    return [note("off", "Match history is almost here",
      "Every match on MCS is being recorded. Results, match reports and player pages will show up here very soon.",
      [arrowBtn("Join the server", { on: { click: openConnect } }),
        h("a", { class: "btn btn-dark", href: "../rules/" }, "Read the rules")])];
  }

  function problem(e, r) {
    const kind = e && e.kind;
    if (kind === "notfound") {
      if (r.view === "match") {
        setTitle("Match not found");
        return [note("off", "We couldn't find that match",
          "It may have been a practice match, or the link is wrong. Every real match is in the list.",
          [arrowBtn("All matches", { href: S.lastList, "data-go": true })])];
      }
      setTitle("Player not found");
      return [note("off", "No matches for this player yet",
        "Their page appears after their first match. Try searching for them by name.",
        [arrowBtn("Find a player", { href: href({ view: "players" }), "data-go": true })])];
    }
    setTitle("Match History");
    const retry = h("button", { class: "btn", type: "button", on: { click: () => render() } }, "Try again", icon("tri", "arrow"));
    const tok = S.token;
    // it's usually a restart: try again on our own while they wait
    setTimeout(() => { if (tok === S.token && !document.hidden) render(); }, kind === "loading" ? 4000 : 20000);
    if (kind === "loading") {
      return [note("wait", "The match server is warming up",
        "It's reading its match history after a restart. This page will load by itself in a moment.", [retry])];
    }
    return [note("off", "The match server isn't answering",
      "It might be restarting. This page keeps trying, or you can try again now.", [retry])];
  }

  /* ── pieces shared by the lists ────────────────────────────────── */

  function segmented(label, items, current, hrefOf, key) {
    return h("div", { class: "mh-seg", role: "group", "aria-label": label },
      items.map(([v, text]) => h("a", {
        href: hrefOf(v), "data-go": true, "data-focus": key + ":" + (v || "all"),
        "aria-current": v === current ? "true" : null,
      }, text)));
  }

  // the pixel pager: arrows, a window of pixel dots, and "Page x of y"
  function pager(page, pages, hrefOf, label) {
    if (pages <= 1) return null;
    const dots = [];
    const start = Math.max(1, Math.min(page - 3, pages - 6));
    const end = Math.min(pages, start + 6);
    for (let p = start; p <= end; p++) {
      dots.push(h("a", {
        class: "mh-pg-dot", href: hrefOf(p), "data-go": true, "data-focus": "pg:" + p,
        "aria-label": "Page " + p, "aria-current": p === page ? "page" : null,
      }, h("i")));
    }
    const arrowLink = (p, dir, text) => p < 1 || p > pages
      ? h("span", { class: "mh-pg-arrow is-" + dir, "aria-hidden": "true" }, icon("tri"))
      : h("a", { class: "mh-pg-arrow is-" + dir, href: hrefOf(p), "data-go": true, "data-focus": "pg:" + dir, "aria-label": text }, icon("tri"));
    return h("nav", { class: "mh-pager", "aria-label": label || "Pages" },
      arrowLink(page - 1, "prev", "Previous page"),
      h("div", { class: "mh-pg-dots" }, dots),
      arrowLink(page + 1, "next", "Next page"),
      h("span", { class: "mh-pg-count" }, "Page " + page + " of " + pages));
  }

  function sectionHead(title, sub, extra) {
    return h("div", { class: "mh-sec-head" },
      h("div", null, h("h2", { class: "mh-sec-title" }, title), sub ? h("p", { class: "mh-sec-sub" }, sub) : null),
      extra || null);
  }

  /* ── view: the match list ──────────────────────────────────────── */

  async function viewList(r, token) {
    const params = { page: r.page, size: 20, mode: r.mode, field: r.field, results: r.results ? 1 : "" };
    const [meta, list] = await Promise.all([getMeta().catch(() => null), get("/matches", params, 15000)]);
    if (token !== S.token) return null;
    if (meta) renderCounters(meta);
    setTitle(r.page > 1 ? `Matches, page ${r.page}` : "Match History");

    const filtered = !!(r.mode || r.field || r.results);
    const out = [filters(r, meta)];
    const items = arr(list.items);

    if (!items.length) {
      if (num(list.total) === 0 && !filtered) {
        out.push(note("wait", "No matches yet",
          "The first whistle hasn't gone. Get on a pitch and yours could be the first match in the history books.",
          [arrowBtn("Join the server", { on: { click: openConnect } })]));
      } else if (num(list.total) === 0) {
        out.push(note("off", "Nothing matches those filters", "Try a different mode or pitch.",
          [arrowBtn("Show every match", { href: href({ view: "list" }), "data-go": true })]));
      } else {
        out.push(note("off", "That page is past the end", `There are ${list.pages} pages of matches.`,
          [arrowBtn("Go to the last page", { href: href(Object.assign({}, r, { page: list.pages })), "data-go": true })]));
      }
      return out;
    }

    out.push(h("ol", { class: "mh-list", "aria-label": "Matches, newest first" }, items.map(matchRow)));
    out.push(pager(num(list.page), num(list.pages), (p) => href(Object.assign({}, r, { page: p })), "Match pages"));
    return out;
  }

  function filters(r, meta) {
    const set = (patch) => href(Object.assign({}, r, patch, { page: 1 }));
    const fields = arr(meta && meta.fields);
    const sel = h("select", { class: "mh-select", id: "mh-field", "data-focus": "field" },
      h("option", { value: "" }, "All pitches"),
      fields.map((f) => h("option", { value: str(f.id), selected: f.id === r.field }, str(f.name) || str(f.id))),
      r.field && !fields.some((f) => f.id === r.field) ? h("option", { value: r.field, selected: true }, r.field) : null);
    sel.addEventListener("change", () => go(set({ field: sel.value })));

    const box = h("input", { type: "checkbox", id: "mh-results", "data-focus": "results", checked: r.results });
    box.addEventListener("change", () => go(set({ results: box.checked })));

    return h("div", { class: "mh-filters" },
      segmented("Mode", [["", "All"], ["MATCH", "Match"], ["SCRIM", "Scrim"], ["QUICK", "Quick"]], r.mode,
        (v) => set({ mode: v }), "mode"),
      h("div", { class: "mh-filter-more" },
        fields.length > 1 || r.field ? h("label", { class: "mh-select-wrap" }, vh("Pitch"), sel) : null,
        h("label", { class: "mh-toggle", for: "mh-results" }, box, h("span", { class: "mh-toggle-box", "aria-hidden": "true" }), "Results only"),
        r.mode || r.field || r.results ? h("a", { class: "mh-clear", href: href({ view: "list" }), "data-go": true }, "Clear") : null));
  }

  const justFinished = new Set();

  function sideCell(side, where, winner, loser) {
    return h("div", { class: "mh-side is-" + where + (winner ? " is-winner" : "") + (loser ? " is-loser" : ""), style: sideVars(side) },
      shield(side, "md"),
      h("span", { class: "mh-side-name" }, side.name));
  }

  function matchRow(m, i) {
    const red = sideOf(m, "RED"), blue = sideOf(m, "BLUE");
    const res = obj(m.result);
    const done = m.outcome === "COMPLETED";
    const win = done && !res.draw ? res.winner : null;
    const sc = obj(m.score);
    const so = m.shootout;

    const a = toMatch(m.id, m.number);
    a.className = "mh-row" + (justFinished.has(m.id) ? " is-new" : "") + (done ? "" : " is-void");
    a.style.setProperty("--i", Math.min(i, 12));

    append(a, [
      h("div", { class: "mh-row-when" },
        h("b", null, dayLabel(num(m.startedAt))), " ",
        h("span", null, F.time.format(new Date(num(m.startedAt))))),
      h("div", { class: "mh-row-board" },
        sideCell(red, "home", win === "RED", win === "BLUE"),
        h("div", { class: "mh-score" },
          h("span", { class: "mh-score-n is-a" + (win === "RED" ? " is-win" : "") }, num(sc.RED)),
          h("span", { class: "mh-score-dash", "aria-hidden": "true" }, "–"),
          vh(" to "),
          h("span", { class: "mh-score-n is-b" + (win === "BLUE" ? " is-win" : "") }, num(sc.BLUE)),
          h("small", { class: "mh-score-note" }, statusShort(m),
            pensShown(so) ? " " + num(so.RED) + "–" + num(so.BLUE) : "")),
        sideCell(blue, "away", win === "BLUE", win === "RED")),
      h("div", { class: "mh-row-meta" },
        modeTag(m.mode, m.knockout),
        h("span", { class: "mh-row-pitch" }, str(m.fieldName) || str(m.fieldId) || "Unknown pitch")),
      h("div", { class: "mh-row-mvp" },
        m.mvp && UUID_RE.test(str(m.mvp.uuid))
          ? [icon("star", "mh-mvp-star"), avatar(m.mvp.uuid, nameOf(m.mvp), 20), h("span", null, vh("MVP: "), nameOf(m.mvp))]
          : h("span", { class: "mh-dim" }, num(m.players) + (num(m.players) === 1 ? " player" : " players"))),
      h("span", { class: "mh-row-go", "aria-hidden": "true" }, icon("tri")),
    ]);
    return h("li", null, a);
  }

  /* ── counters above the list ───────────────────────────────────── */

  function renderCounters(meta) {
    if (!meta || meta.loading) return;
    const items = [
      [num(meta.matches), num(meta.matches) === 1 ? "Match played" : "Matches played"],
      [num(meta.players), num(meta.players) === 1 ? "Player" : "Players"],
      [arr(meta.fields).length, arr(meta.fields).length === 1 ? "Pitch" : "Pitches"],
    ];
    const fresh = !counters.children.length;
    counters.replaceChildren(...items.map(([n, label], i) => {
      const b = h("b", null, fresh && !reduceMotion ? "0" : n.toLocaleString());
      if (fresh && !reduceMotion) countUp(b, n, 120 * i);
      return h("li", null, b, h("span", null, label));
    }));
    if (meta.first) counters.appendChild(h("li", { class: "is-since" }, h("span", null, "Recording since"), h("b", null, F.date.format(new Date(meta.first)))));
    counters.hidden = !(S.route && (S.route.view === "list" || S.route.view === "leaders" || S.route.view === "players"));
  }
  function countUp(el, to, delay) {
    const t0 = performance.now() + delay, dur = 900;
    const step = (t) => {
      const p = Math.min(1, Math.max(0, (t - t0) / dur));
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── live now: polls /live every 5 s while you can see it ──────── */

  const Live = { on: false, timer: 0, fails: 0, prev: new Map(), tick: 0, busy: false };
  const safeField = (id) => str(id).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);

  function liveStart() {
    if (!API || Live.on) return;
    Live.on = true;
    livePoll();
  }
  function liveStop() {
    Live.on = false;
    clearTimeout(Live.timer);
    clearInterval(Live.tick);
    liveBox.hidden = true;
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Live.on) livePoll();
  });

  async function livePoll() {
    clearTimeout(Live.timer);
    if (!Live.on || Live.busy) return;
    if (document.hidden) return; // visibilitychange restarts it
    Live.busy = true;
    try {
      const d = await get("/live", null, 0);
      Live.fails = 0;
      if (typeof d.now === "number") skew = d.now - Date.now();
      showLive(arr(d.live));
    } catch {
      Live.fails++;
    } finally {
      Live.busy = false;
      if (Live.on) Live.timer = setTimeout(livePoll, Live.fails ? Math.min(60000, 5000 * Math.pow(2, Live.fails)) : 5000);
    }
  }

  function showLive(list) {
    const seen = new Map();
    list.forEach((L) => seen.set(str(L.fieldId) + "|" + num(L.startedAt), L));
    // an entry that disappeared has just finished (or was called off)
    for (const [k, L] of Live.prev) if (!seen.has(k)) followToRecord(L, 0);
    Live.prev = seen;

    if (!Live.on) return;
    liveBox.hidden = !list.length;
    liveList.replaceChildren(...list.map(liveCard));
    clearInterval(Live.tick);
    // the match clock runs between polls
    Live.tick = setInterval(() => {
      $$("[data-clock]", liveList).forEach((el) => {
        const m = /^(\d+):(\d\d)$/.exec(el.textContent);
        if (m) el.textContent = clockOf(+m[1] * 60 + +m[2] + 1);
      });
    }, 1000);
  }

  function liveCard(L) {
    const red = sideOf(L, "RED"), blue = sideOf(L, "BLUE");
    const sc = obj(L.score);
    const phase = str(L.phase);
    const label = { WARMUP: "Kicking off soon", BREAK: "Break", SHOOTOUT: "Penalties" }[phase];
    const heads = (s) => h("span", { class: "mh-live-heads" },
      s.players.slice(0, 5).map((p) => avatar(p.uuid, nameOf(p), 18)),
      s.players.length > 5 ? h("em", null, "+" + (s.players.length - 5)) : null);
    return h("li", { class: "mh-live-card", style: { "--red": vivid(red.color), "--blue": vivid(blue.color) } },
      h("div", { class: "mh-live-top" },
        h("span", null, str(L.fieldName) || str(L.fieldId)),
        modeTag(L.mode, false)),
      h("div", { class: "mh-live-board" },
        h("span", { class: "mh-live-side", style: sideVars(red) }, shield(red, "sm"), h("span", null, red.name)),
        h("span", { class: "mh-live-score" }, num(sc.RED), h("i", { "aria-hidden": "true" }, "–"), vh(" to "), num(sc.BLUE)),
        h("span", { class: "mh-live-side is-away", style: sideVars(blue) }, h("span", null, blue.name), shield(blue, "sm"))),
      h("div", { class: "mh-live-foot" },
        heads(red),
        h("span", { class: "mh-live-clock" + (phase === "PLAYING" ? " is-running" : "") },
          label ? label : h("span", { "data-clock": phase === "PLAYING" ? "" : null }, str(L.clock) || "0:00"),
          phase === "SHOOTOUT" && L.shootout ? " " + num(L.shootout.RED) + "–" + num(L.shootout.BLUE) : ""),
        heads(blue)));
  }

  // Doc 4.19: the live board has no match id, so find the finished record
  // by pitch and start time. Never "the newest match on that pitch": a
  // match called off in its countdown leaves no record at all.
  async function followToRecord(L, attempt) {
    await sleep(attempt ? 10000 : 1500);
    try {
      const d = await get("/matches", { field: safeField(L.fieldId), size: 5 }, 0);
      const m = arr(d.items).find((x) => x.startedAt === L.startedAt);
      if (!m) { if (attempt < 3) followToRecord(L, attempt + 1); return; }
      justFinished.add(m.id);
      forgetLists();
      getMeta(true).then(renderCounters).catch(() => {});
      const red = sideOf(m, "RED"), blue = sideOf(m, "BLUE");
      announce(`Full time on ${str(m.fieldName) || "a pitch"}: ${red.name} ${num(m.score.RED)}, ${blue.name} ${num(m.score.BLUE)}`);
      if (S.route && S.route.view === "list" && S.route.page === 1) render({ keep: true });
    } catch {}
  }

  /* ── view: match report ────────────────────────────────────────── */

  async function viewMatch(r, token) {
    if (!ID_RE.test(r.id)) throw new ApiError("notfound");
    const rec = await get("/matches/" + encodeURIComponent(r.id), null, 3600000);
    if (token !== S.token) return null;
    if (!rec.teams || !rec.score) throw new ApiError("server");
    if (rec.schema > 1) console.warn("[matches] record schema " + rec.schema + " is newer than this page knows");
    return report(rec, obj(history.state).number);
  }

  function report(rec, number) {
    const red = sideOf(rec, "RED"), blue = sideOf(rec, "BLUE");
    const sides = { RED: red, BLUE: blue };
    const people = new Map(arr(rec.players).map((p) => [p.uuid, p]));
    const who = (uuid) => (uuid && people.has(uuid) ? nameOf(people.get(uuid)) : uuid ? "someone who's left" : "");
    const events = arr(rec.events);
    const res = obj(rec.result);
    const done = rec.outcome === "COMPLETED";
    const win = done && !res.draw ? res.winner : null;
    const sc = obj(rec.score);
    const test = rec.source === "test" || arr(rec.flags).includes("TEST");
    const so = rec.shootout && typeof rec.shootout === "object" ? rec.shootout : null;
    const kicked = so && arr(so.kicks).length > 0;

    setTitle(`${red.name} ${num(sc.RED)}–${num(sc.BLUE)} ${blue.name}`);

    // goal scorers under each side, as on a broadcast
    const scorers = { RED: [], BLUE: [] };
    events.forEach((e) => {
      if ((e.type !== "GOAL" && e.type !== "AWARDED_GOAL") || e.disallowed || !scorers[e.team]) return;
      const label = e.type === "AWARDED_GOAL" ? "Awarded" : e.ownGoal ? who(e.player) + " (OG)" : who(e.player) || "Goal";
      scorers[e.team].push([label, evClock(e, rec)]);
    });
    const scorerList = (key) => {
      const grouped = new Map();
      scorers[key].forEach(([n, c]) => grouped.set(n, (grouped.get(n) || []).concat(c)));
      return grouped.size
        ? h("ul", { class: "mh-scorers" }, [...grouped].map(([n, cs]) => h("li", null, icon("ball"), h("b", null, n), " ", cs.join(", "))))
        : null;
    };

    const hero = h("section", { class: "mh-hero", "aria-labelledby": "mh-hero-title", style: { "--red": vivid(red.color), "--blue": vivid(blue.color) } },
      h("div", { class: "mh-hero-top" },
        h("a", { class: "mh-back", href: S.lastList, "data-go": true }, icon("tri"), "Match history"),
        h("span", { class: "mh-hero-when" }, F.full.format(new Date(num(rec.startedAt))))),
      h("h1", { class: "mh-hero-title visually-hidden", id: "mh-hero-title" },
        `${red.name} ${num(sc.RED)}, ${blue.name} ${num(sc.BLUE)}`),
      h("div", { class: "mh-hero-board" },
        heroSide(red, win === "RED", win && win !== "RED", scorerList("RED")),
        h("div", { class: "mh-hero-mid" },
          h("div", { class: "mh-hero-score", "aria-hidden": "true" },
            h("span", { class: win === "RED" ? "is-win" : "" }, num(sc.RED)),
            h("i", null, "–"),
            h("span", { class: win === "BLUE" ? "is-win" : "" }, num(sc.BLUE))),
          kicked ? h("p", { class: "mh-hero-pens" }, num(so.score.RED) + "–" + num(so.score.BLUE) + " on penalties") : null,
          h("p", { class: "mh-hero-result" + (done ? "" : " is-void") }, resultLine(rec, sides))),
        heroSide(blue, win === "BLUE", win && win !== "BLUE", scorerList("BLUE"))),
      h("ul", { class: "mh-hero-chips" },
        h("li", null, modeTag(rec.mode, rec.knockout)),
        h("li", null, str(obj(rec.field).name) || "Unknown pitch"),
        h("li", null, rulesLine(rec)),
        number ? h("li", null, "Match #" + number) : null));

    const notes = flagNotes(rec, test);
    const out = [hero];
    if (notes.length) out.push(h("div", { class: "mh-callouts" }, notes));

    // timeline beside the stats on wide screens; the stats stay in view
    // while a long timeline scrolls past. Momentum wants the full width.
    out.push(h("div", { class: "mh-report-grid" },
      timelineCard(rec, events, sides, who),
      h("div", { class: "mh-report-side" }, statsCard(rec, red, blue))));
    const flow = flowCard(rec, events, red, blue);
    if (flow) out.push(flow);

    if (so) out.push(shootoutCard(so, sides, who));
    out.push(lineupsCard(rec, red, blue, events));
    const shots = shotMapCard(rec, events, sides, who);
    out.push(shots ? h("div", { class: "mh-report-grid is-even" }, shots, infoCard(rec, sides)) : infoCard(rec, sides));
    return out;
  }

  function heroSide(side, winner, loser, scorers) {
    return h("div", { class: "mh-hero-side" + (winner ? " is-winner" : "") + (loser ? " is-loser" : ""), style: sideVars(side) },
      h("div", { class: "mh-hero-crest" }, shield(side, "xl")),
      h("p", { class: "mh-hero-name" }, side.name),
      winner ? h("span", { class: "mh-winner" }, icon("trophy"), "Winner") : null,
      // a fixture side is usually named after its club: no need to say it twice
      side.club && str(side.club.name).trim().toLowerCase() !== side.name.toLowerCase() ? clubChip(side.club) : null,
      scorers);
  }

  function resultLine(rec, sides) {
    const res = obj(rec.result);
    if (rec.outcome !== "COMPLETED") return { STOPPED: "Stopped by the referee", ABANDONED: "Abandoned", INTERRUPTED: "Interrupted" }[rec.outcome] || "Unfinished";
    if (res.draw) return rec.mode === "MATCH" ? "Full time · Draw" : "Draw";
    const n = res.winner && sides[res.winner] ? sides[res.winner].name : "";
    return {
      EXTRA_TIME: `${n} win after extra time`,
      SHOOTOUT: `${n} win on penalties`,
      COIN_FLIP: `${n} win on a coin flip`,
      REFEREE: `${n} win on the referee's call`,
    }[res.decidedBy] || (rec.mode === "MATCH" ? `Full time · ${n} win` : `${n} win`);
  }

  function rulesLine(rec) {
    const r = obj(rec.rules);
    if (rec.mode === "MATCH") {
      const halves = num(r.halves), mins = num(r.halfMinutes);
      // a referee can send any match to penalties; only a real knockout
      // had extra time on the cards at kick-off
      const ko = r.extraTime ? " · extra time + penalties" : rec.knockout ? " · penalties" : "";
      return (halves && mins ? `${halves} × ${mins} min` : "Timed halves") + ko;
    }
    const lim = num(r.goalLimit);
    return lim > 0 ? `First to ${lim}` : "No goal limit";
  }

  function flagNotes(rec, test) {
    const say = [];
    const res = obj(rec.result);
    if (test) say.push("This was a practice shootout, not a real match. It isn't listed and doesn't count.");
    if (rec.outcome === "STOPPED") say.push("A referee stopped this match before the end, so it has no result and doesn't count toward anyone's stats.");
    if (rec.outcome === "ABANDONED") say.push("Everyone left the pitch, so this match was abandoned. It doesn't count toward stats.");
    if (rec.outcome === "INTERRUPTED") say.push("The server restarted during this match. This report was saved from its last checkpoint, so the final minute may be missing, and it doesn't count toward stats.");
    const FLAGS = {
      SCORE_EDITED: "A referee changed the score by hand during this match.",
      REFEREE_WIN: "The referee declared the winner" + (res.winner ? ", which can differ from who scored more." : "."),
      COIN_FLIP: "Level after everything, so a coin flip decided it.",
      RULES_CHANGED: "The rules were changed partway through this match.",
      SHOOTOUT_FORCED: "A referee sent this match straight to penalties.",
    };
    arr(rec.flags).forEach((f) => {
      if (f === "TEST") return;
      say.push(FLAGS[f] || "Flagged: " + str(f).toLowerCase().replace(/_/g, " ") + ".");
    });
    return say.map((t) => h("p", { class: "callout mh-callout" }, t));
  }

  /* the timeline */

  function evClock(e, rec) {
    // a referee can act during the countdown: negative t, half 0
    if (num(e.t) < 0 || num(e.half) === 0) return "Pre";
    const c = str(e.clock) || clockOf(e.t);
    return (e.et ? "ET " : "") + c.replace(/^-/, "");
  }

  function ordinal(n) { return ["", "first", "second", "third", "fourth"][n] || n + "th"; }
  function halfName(e) {
    if (e.et) return num(e.half) === 1 ? "extra time" : "extra time, second half";
    return ordinal(num(e.half)) + " half";
  }

  const LEAVE = { quit: "disconnected", left: "left the match", spectate: "went to spectate", removed: "was taken off by the referee" };
  const KICK = { SCORED: "scored", SAVED: "saved", MISSED: "missed", SKIPPED: "skipped" };
  const KEY_TYPES = new Set(["GOAL", "AWARDED_GOAL", "DISALLOWED", "NO_GOAL", "SET_PIECE", "HALF_END", "EXTRA_TIME", "SHOOTOUT", "PENALTY", "FULL_TIME", "SCORE_EDIT", "KICKOFF"]);

  function timelineCard(rec, events, sides, who) {
    const rows = [];
    const scoreText = (s) => s ? num(s.RED) + "–" + num(s.BLUE) : "";
    const tname = (k) => (sides[k] ? sides[k].name : "");
    let pens = { RED: 0, BLUE: 0 };
    let kickoffs = 0, kickNo = 0;

    events.forEach((e, i) => {
      const next = events[i + 1];
      const k = e.team;
      let side = sides[k] ? k : "";
      let kind = "info", text = [], ic = null, key = KEY_TYPES.has(e.type);

      switch (e.type) {
        case "KICKOFF":
          kickoffs++;
          side = "";
          kind = "mark";
          if (kickoffs === 1) text = [sides[k] ? tname(k) + " kick off" : rec.mode === "SCRIM" ? "Kick-off: the lob" : "Kick-off"];
          else text = [rec.mode === "MATCH" ? cap(halfName(e)) : "Play restarts", sides[k] ? " · " + tname(k) + " kick off" : ""];
          break;
        case "GOAL":
          kind = "goal"; ic = "ball";
          text = e.ownGoal
            ? [h("b", null, "Own goal"), e.player ? [" by ", pLink(e.player, who)] : null]
            : [h("b", null, "Goal! "), pLink(e.player, who) || "Unknown scorer",
              e.assist ? h("span", { class: "mh-ev-sub" }, "Assist: ", pLink(e.assist, who)) : null];
          if (e.from && typeof e.from.dist === "number") text.push(h("span", { class: "mh-ev-sub" }, "From " + num(e.from.dist).toFixed(0) + " blocks out"));
          if (e.disallowed) { kind += " is-disallowed"; text.push(h("span", { class: "mh-ev-tag" }, "Disallowed")); }
          else text.push(h("span", { class: "mh-ev-score" }, scoreText(e.score)));
          break;
        case "AWARDED_GOAL":
          kind = "goal"; ic = "ball";
          text = [h("b", null, "Goal awarded"), " by the referee"];
          if (e.disallowed) { kind += " is-disallowed"; text.push(h("span", { class: "mh-ev-tag" }, "Disallowed")); }
          else text.push(h("span", { class: "mh-ev-score" }, scoreText(e.score)));
          break;
        case "DISALLOWED":
          kind = "bad"; ic = "cross";
          text = [h("b", null, "Goal disallowed"), e.player ? [" (", pLink(e.player, who), ")"] : null, h("span", { class: "mh-ev-score" }, scoreText(e.score))];
          break;
        case "NO_GOAL":
          kind = "bad"; ic = "flag";
          text = [h("b", null, "No goal"), e.player ? [" for ", pLink(e.player, who)] : null,
            str(e.reason) ? h("span", { class: "mh-ev-sub" }, cap(str(e.reason))) : null];
          break;
        case "SET_PIECE":
          kind = "set"; ic = "flag";
          text = [h("b", null, e.reason === "PENALTY" ? "Penalty" : "Free kick"), " to " + tname(k),
            e.player ? h("span", { class: "mh-ev-sub" }, "Self-pass by ", pLink(e.player, who)) : null];
          break;
        case "PENALTY": {
          kind = "pen is-" + str(e.result).toLowerCase();
          ic = e.result === "SCORED" ? "check" : e.result === "SKIPPED" ? "pause" : "cross";
          if (e.result === "SCORED" && pens[k] != null) pens[k]++;
          const verb = { SCORED: "scored", MISSED: "missed", SAVED: "had it saved" }[e.result];
          text = [
            e.result === "SKIPPED" ? [h("b", null, "Turn lost"), " for " + tname(k)]
              : [e.player ? pLink(e.player, who) : h("span", null, tname(k)), " ", h("b", null, verb || str(e.result).toLowerCase())],
            e.keeper && e.result === "SAVED" ? h("span", { class: "mh-ev-sub" }, "Saved by ", pLink(e.keeper, who)) : null,
            e.result === "SKIPPED" ? h("span", { class: "mh-ev-sub" }, e.player ? [pLink(e.player, who), " had left"] : "No one left to take it") : null,
            h("span", { class: "mh-ev-score" }, pens.RED + "–" + pens.BLUE)];
          break;
        }
        case "HALF_END": {
          // the last half's end is always followed by full time, extra
          // time or the shootout, which say it better
          if (next && (next.type === "FULL_TIME" || next.type === "EXTRA_TIME" || next.type === "SHOOTOUT")) return;
          side = ""; kind = "mark";
          text = [e.et ? "Extra-time half time"
            : num(e.half) === 1 && num(obj(rec.rules).halves) === 2 ? "Half time" : "End of the " + halfName(e),
            " · ", scoreText(e.score)];
          break;
        }
        case "EXTRA_TIME":
          side = ""; kind = "mark";
          text = ["Level at " + scoreText(e.score) + ", so extra time"];
          break;
        case "SHOOTOUT":
          side = ""; kind = "mark";
          pens = { RED: 0, BLUE: 0 };
          text = ["Penalty shootout"];
          break;
        case "JOIN":
          kind = "move"; ic = "arrow";
          text = [pLink(e.player, who), " came on for " + tname(k)];
          break;
        case "LEAVE":
          kind = "move is-out"; ic = "arrow";
          text = [pLink(e.player, who), " " + (LEAVE[e.reason] || "left")];
          break;
        case "SWITCH":
          kind = "move"; ic = "arrow";
          text = [pLink(e.player, who), " switched to " + tname(k)];
          break;
        case "SCORE_EDIT": {
          kind = "set"; ic = "pencil";
          const d = num(e.delta);
          text = [h("b", null, "Score changed"), " by the referee",
            d ? h("span", { class: "mh-ev-sub" }, (d > 0 ? "+" : "−") + Math.abs(d) + (Math.abs(d) === 1 ? " point" : " points") + " for " + tname(k)) : null,
            h("span", { class: "mh-ev-score" }, scoreText(e.score))];
          break;
        }
        case "FREEZE":
          side = ""; kind = "mark is-small"; text = ["Play frozen by the referee"]; break;
        case "UNFREEZE":
          side = ""; kind = "mark is-small"; text = ["Play resumed"]; break;
        case "FULL_TIME":
          side = ""; kind = "mark is-end";
          text = [{ COMPLETED: "Full time", STOPPED: "Match stopped", ABANDONED: "Match abandoned", INTERRUPTED: "Match interrupted" }[rec.outcome] || "The end",
            " · ", scoreText(e.score)];
          key = true;
          break;
        default:
          // a type this page doesn't know yet (doc section 9): show it plainly
          side = side || ""; kind = "info";
          text = [cap(str(e.type).toLowerCase().replace(/_/g, " "))];
      }

      // shootout kicks all share the final clock, so number them instead
      const clock = e.type === "PENALTY" ? "P" + ++kickNo : evClock(e, rec);
      rows.push({ key, el: h("li", { class: "mh-ev is-" + (side ? side.toLowerCase() : "mid") + " kind-" + kind, style: side ? sideVars(sides[side]) : null },
        h("span", { class: "mh-ev-clock", title: e.type === "PENALTY" ? "Shootout kick " + kickNo : null }, clock),
        h("div", { class: "mh-ev-body" }, ic ? h("span", { class: "mh-ev-ic" }, icon(ic)) : null, h("div", { class: "mh-ev-text" }, text))) });
    });

    const hidden = rows.filter((r) => !r.key).length;
    const list = h("ol", { class: "mh-timeline" + (hidden ? " is-key" : "") }, rows.map((r) => { if (!r.key) r.el.classList.add("is-minor"); return r.el; }));
    let toggle = null;
    if (hidden && rows.length > 10) {
      toggle = h("button", { class: "mh-link-btn", type: "button", "aria-pressed": "false" }, `Show everything (${hidden} more)`);
      toggle.addEventListener("click", () => {
        const all = list.classList.toggle("is-key") === false;
        toggle.setAttribute("aria-pressed", String(all));
        toggle.textContent = all ? "Key moments only" : `Show everything (${hidden} more)`;
      });
    } else list.classList.remove("is-key");

    return h("section", { class: "mh-card mh-timeline-card", "aria-labelledby": "mh-tl" },
      sectionHead(h("span", { id: "mh-tl" }, "Timeline"), null, toggle),
      rows.length ? list : h("p", { class: "mh-dim" }, "Nothing was recorded for this match."));
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function pLink(uuid, who) {
    if (!uuid) return null;
    const n = who(uuid);
    return UUID_RE.test(uuid) ? h("a", { class: "mh-plink", href: toPlayer(uuid), "data-go": true }, n) : h("span", null, n);
  }

  /* team stats, side by side */

  function statsCard(rec, red, blue) {
    const a = obj(red.stats), b = obj(blue.stats);
    const pa = num(a.possessionSeconds), pb = num(b.possessionSeconds);
    const share = pa + pb ? Math.round((pa / (pa + pb)) * 100) : 50;
    // the first four always show; the rest only when either side has one
    const rows = [
      ["Shots on target", "shotsOnTarget"],
      ["Attempts", "shots", "Every time a player released the ball, apart from completed passes"],
      ["Passes", "passes"], ["Tackles", "tackles"], ["Steals", "steals"], ["Interceptions", "interceptions"],
      ["Saves", "saves"], ["Corners", "corners"], ["Free kicks", "freeKicks"], ["Penalties", "penalties", "Penalties awarded during play"],
      ["Pass-ins", "passIns"], ["Goal kicks", "goalKicks"], ["Own goals", "ownGoals"],
    ].filter(([, k], i) => i < 4 || num(a[k]) || num(b[k]));
    const same = red.color === blue.color;
    return h("section", { class: "mh-card mh-stats" + (same ? " is-same" : ""), "aria-labelledby": "mh-st", style: { "--red": vivid(red.color), "--blue": vivid(blue.color) } },
      sectionHead(h("span", { id: "mh-st" }, "Team stats")),
      h("div", { class: "mh-poss" },
        h("div", { class: "mh-poss-head" }, h("b", null, pa + pb ? share + "%" : "–"), h("span", null, "Possession"), h("b", null, pa + pb ? 100 - share + "%" : "–")),
        h("div", { class: "mh-poss-bar", role: "img", "aria-label": pa + pb ? `Possession: ${red.name} ${share}%, ${blue.name} ${100 - share}%` : "No possession recorded" },
          h("i", { class: "is-red", style: { "--w": share + "%" } }), h("i", { class: "is-blue", style: { "--w": 100 - share + "%" } }))),
      h("table", { class: "mh-st-table" },
        h("caption", { class: "visually-hidden" }, `Team stats, ${red.name} against ${blue.name}`),
        h("thead", { class: "visually-hidden" }, h("tr", null, h("th", { scope: "col" }, red.name), h("th", { scope: "col" }, "Stat"), h("th", { scope: "col" }, blue.name))),
        h("tbody", null, rows.map(([label, k, tip]) => {
          const x = num(a[k]), y = num(b[k]), m = Math.max(x, y) || 1;
          return h("tr", null,
            h("td", { class: "mh-st-a" + (x > y ? " is-more" : "") }, h("span", null, x), h("i", { style: { "--w": (x / m) * 100 + "%" } })),
            h("th", { scope: "row", title: tip || null }, label),
            h("td", { class: "mh-st-b" + (y > x ? " is-more" : "") }, h("i", { style: { "--w": (y / m) * 100 + "%" } }), h("span", null, y)));
        }))));
  }

  /* possession flow: who had the ball, 30 seconds at a time */

  function flowCard(rec, events, red, blue) {
    const f = obj(rec.flow), t = obj(f.teams);
    const A = arr(t.RED).map(num), B = arr(t.BLUE).map(num);
    const n = Math.max(A.length, B.length);
    if (!n) return null;
    const bucket = num(f.bucketSeconds) || 30;
    const cols = [];
    let aheadR = 0, aheadB = 0;
    for (let i = 0; i < n; i++) {
      const a = A[i] || 0, b = B[i] || 0;
      if (a > b) aheadR++; else if (b > a) aheadB++;
      cols.push(h("span", { class: "mh-flow-col" },
        h("i", { class: "is-red", style: { "--v": Math.min(1, a / bucket) } }),
        h("i", { class: "is-blue", style: { "--v": Math.min(1, b / bucket) } })));
    }
    const goals = events.filter((e) => (e.type === "GOAL" || e.type === "AWARDED_GOAL") && !e.disallowed && (e.team === "RED" || e.team === "BLUE"))
      .map((e) => h("span", { class: "mh-flow-goal is-" + e.team.toLowerCase(), style: { "--x": Math.min(1, Math.max(0, num(e.t) / bucket / n)) }, title: "Goal, " + evClock(e, rec) }, icon("ball")));
    const mins = (n * bucket) / 60;
    const step = mins > 40 ? 10 : mins > 16 ? 5 : mins > 6 ? 2 : 1;
    const ticks = [];
    for (let m = 0; m <= mins; m += step) ticks.push(h("span", { style: { "--x": m / mins } }, m + "'"));

    return h("section", { class: "mh-card mh-flow-card", "aria-labelledby": "mh-fl", style: { "--red": vivid(red.color), "--blue": vivid(blue.color), "--n": n } },
      sectionHead(h("span", { id: "mh-fl" }, "Momentum"), "Who had the ball, 30 seconds at a time. Breaks show as gaps."),
      h("div", { class: "mh-flow-legend" },
        h("span", { class: "is-red" }, h("i"), red.name), h("span", { class: "is-blue" }, h("i"), blue.name)),
      h("div", { class: "mh-flow", role: "img", "aria-label": `Possession over time: ${red.name} had more of the ball in ${aheadR} of ${n} spells, ${blue.name} in ${aheadB}.` },
        h("div", { class: "mh-flow-plot" }, cols, goals),
        mins >= 1 ? h("div", { class: "mh-flow-axis", "aria-hidden": "true" }, ticks) : null));
  }

  /* the shootout */

  function shootoutCard(so, sides, who) {
    const kicks = arr(so.kicks);
    const row = (key) => {
      const side = sides[key];
      const mine = kicks.filter((k) => k.team === key);
      return h("div", { class: "mh-so-row", style: sideVars(side) },
        h("span", { class: "mh-so-name" }, shield(side, "sm"), side.name),
        h("ol", { class: "mh-so-kicks" }, mine.map((k, i) => h("li", {
          class: "is-" + str(k.result).toLowerCase(),
          title: (k.taker ? who(k.taker) : "No taker") + ": " + (KICK[k.result] || str(k.result).toLowerCase()),
        }, icon(k.result === "SCORED" ? "check" : k.result === "SKIPPED" ? "pause" : "cross"),
          vh(`Kick ${i + 1}, ${k.taker ? who(k.taker) : "no taker"}, ${KICK[k.result] || k.result}`)))),
        h("b", { class: "mh-so-total" }, num(obj(so.score)[key])));
    };
    return h("section", { class: "mh-card mh-so", "aria-labelledby": "mh-so" },
      sectionHead(h("span", { id: "mh-so" }, "Penalty shootout"),
        kicks.length ? `${num(obj(so.score).RED)}–${num(obj(so.score).BLUE)} on penalties` : "It was called off before the first kick."),
      kicks.length ? [row("RED"), row("BLUE")] : null);
  }

  /* line-ups */

  function lineupsCard(rec, red, blue, events) {
    const players = arr(rec.players);
    const leaveReason = new Map();
    events.forEach((e) => { if (e.type === "LEAVE" && e.player) leaveReason.set(e.player, e.reason); });
    const parties = new Map();
    players.forEach((p) => { if (p.party) parties.set(p.party, (parties.get(p.party) || []).concat(p)); });

    const col = (side) => {
      const mine = players.filter((p) => p.team === side.key);
      return h("div", { class: "mh-lu-col", style: sideVars(side) },
        h("h3", { class: "mh-lu-head" }, shield(side, "sm"), h("span", null, side.name), h("small", null, mine.length + (mine.length === 1 ? " player" : " players"))),
        mine.length ? h("ul", { class: "mh-lu-list" }, mine.map((p) => lineupRow(rec, p, side, leaveReason, parties)))
          : h("p", { class: "mh-dim" }, "Nobody finished on this side."));
    };
    return h("section", { class: "mh-card mh-lineups", "aria-labelledby": "mh-lu" },
      sectionHead(h("span", { id: "mh-lu" }, "Line-ups"), "Everyone who played, on the side they finished on. Open a player for their numbers."),
      h("div", { class: "mh-lu-cols" }, col(red), col(blue)));
  }

  function lineupRow(rec, p, side, leaveReason, parties) {
    const s = obj(p.stats);
    const pid = "mh-lu-" + ++uid;
    const pos = str(p.position) || arr(p.positions).slice(-1)[0] || "";
    const badges = [];
    if (num(s.goals)) badges.push(h("span", { class: "mh-b is-goal", title: s.goals + (s.goals === 1 ? " goal" : " goals") }, icon("ball"), s.goals > 1 ? s.goals : null, vh(" goals")));
    if (num(s.assists)) badges.push(h("span", { class: "mh-b is-assist", title: s.assists + (s.assists === 1 ? " assist" : " assists") }, icon("boot"), s.assists > 1 ? s.assists : null, vh(" assists")));
    if (num(s.ownGoals)) badges.push(h("span", { class: "mh-b is-og", title: "Own goal" }, "OG", s.ownGoals > 1 ? "×" + s.ownGoals : null));
    if (p.cleanSheet) badges.push(h("span", { class: "mh-b is-cs", title: "Clean sheet" }, icon("glove"), vh(" clean sheet")));
    if (p.mvp) badges.push(h("span", { class: "mh-b is-mvp", title: "Player of the match" }, icon("star"), "MVP"));

    const notes = [];
    if (num(p.joinedAt) > 0) notes.push("On at " + clockOf(p.joinedAt));
    if (!p.present && p.leftAt != null) notes.push((leaveReason.get(p.uuid) === "quit" ? "Disconnected at " : "Left at ") + clockOf(p.leftAt));
    const others = [...new Set(arr(p.teams))].filter((t) => t !== p.team);
    if (others.length) notes.push("Also played for " + others.map((t) => sideOf(rec, t).name).join(", "));
    const mates = p.party ? (parties.get(p.party) || []).filter((q) => q.uuid !== p.uuid) : [];
    if (mates.length) notes.push("Queued with " + mates.map(nameOf).join(", "));

    const btn = h("button", { class: "mh-lu-more", type: "button", "aria-expanded": "false", "aria-controls": pid },
      vh("Stats for " + nameOf(p)));
    const detail = h("div", { class: "mh-lu-detail", id: pid, hidden: true },
      h("dl", { class: "mh-mini" },
        [["Attempts", s.shots], ["On target", s.shotsOnTarget], ["Passes", s.passes], ["Saves", s.saves],
          ["Tackles", s.tackles], ["Steals", s.steals], ["Interceptions", s.interceptions],
          ["On the ball", clockOf(s.possessionSeconds)], ["Time played", clockOf(p.secondsPlayed)]]
          .concat(num(s.pkScored) + num(s.pkMissed) + num(s.pkSaved) ? [["Pens scored", s.pkScored], ["Pens missed", s.pkMissed], ["Pens saved", s.pkSaved]] : [])
          .map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, typeof v === "string" ? v : num(v))))),
      arr(p.positions).length > 1 ? h("p", { class: "mh-dim" }, "Positions: " + arr(p.positions).map((x) => POSITIONS[x] || x).join(" → ")) : null,
      UUID_RE.test(str(p.uuid)) ? h("a", { class: "more", href: toPlayer(p.uuid), "data-go": true }, "Player page ", icon("tri")) : null);
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
    });

    return h("li", { class: "mh-lu-row" + (p.present === false ? " is-gone" : "") },
      h("div", { class: "mh-lu-main" },
        avatar(p.uuid, nameOf(p), 32),
        h("div", { class: "mh-lu-who" },
          UUID_RE.test(str(p.uuid)) ? h("a", { class: "mh-lu-name", href: toPlayer(p.uuid), "data-go": true }, nameOf(p)) : h("span", { class: "mh-lu-name" }, nameOf(p)),
          notes.length ? h("small", null, notes.join(" · ")) : null),
        pos ? h("span", { class: "mh-pos", title: POSITIONS[pos] || pos }, pos) : null,
        h("span", { class: "mh-lu-badges" }, badges),
        ratingBadge(p.rating),
        btn),
      detail);
  }

  /* where the goals came from */

  function shotMapCard(rec, events, sides, who) {
    const shots = events.filter((e) => e.type === "GOAL" && !e.disallowed && e.from && typeof e.from.dist === "number" && sides[e.team]);
    if (!shots.length) return null;
    const fw = num(obj(rec.field).width), fl = num(obj(rec.field).length);
    // plot on half a pitch, goal at the top: x = across, y = out
    const halfW = fw > 0 ? fw / 2 : Math.max(12, ...shots.map((e) => Math.abs(num(e.from.side)) + 4));
    const depth = fl > 0 ? fl / 2 : Math.max(20, ...shots.map((e) => num(e.from.dist) + 6));
    const W = 200, H = Math.round((W * depth) / (halfW * 2));
    const X = (side) => W / 2 + (num(side) / halfW) * (W / 2);
    const Y = (dist) => (num(dist) / depth) * H;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "mh-shotmap");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Where the ${shots.length} goal${shots.length === 1 ? "" : "s"} were scored from`);
    // box and goal are drawn to scale only when the pitch size is known
    const boxW = Math.min(W, (20 / halfW) * (W / 2)), boxD = Math.min(H, (8 / depth) * H);
    svg.innerHTML =
      `<rect class="mh-sm-grass" x="0" y="0" width="${W}" height="${H}"/>` +
      `<rect class="mh-sm-line" x="${(W - boxW) / 2}" y="0" width="${boxW}" height="${boxD}"/>` +
      `<path class="mh-sm-line" d="M${W / 2 - 22} ${H} a22 22 0 0 1 44 0"/>` +
      `<rect class="mh-sm-goal" x="${W / 2 - 12}" y="0" width="24" height="3"/>`;
    shots.forEach((e) => {
      const g = document.createElementNS(ns, "g");
      const x = Math.round(Math.min(W - 4, Math.max(4, X(e.from.side)))), y = Math.round(Math.min(H - 4, Math.max(4, Y(e.from.dist))));
      g.setAttribute("transform", `translate(${x - 4} ${y - 4})`);
      g.setAttribute("class", "mh-sm-shot is-" + e.team.toLowerCase());
      g.innerHTML = `<path d="${ICONS.ball[1]}"/><path class="mh-i-cut" d="${ICONS.ball[2]}"/>`;
      const t = document.createElementNS(ns, "title");
      t.textContent = `${e.ownGoal ? "Own goal by " : ""}${who(e.player) || "Goal"}, ${num(e.from.dist).toFixed(0)} blocks out (${sides[e.team].name})`;
      g.appendChild(t);
      svg.appendChild(g);
    });
    const red = sides.RED, blue = sides.BLUE;
    return h("section", { class: "mh-card mh-shots", "aria-labelledby": "mh-sm", style: { "--red": vivid(red.color), "--blue": vivid(blue.color) } },
      sectionHead(h("span", { id: "mh-sm" }, "Where the goals came from"), "Each goal, drawn from the net it went into."),
      h("div", { class: "mh-shotmap-wrap" }, svg),
      h("ul", { class: "mh-shot-list" }, shots.map((e) => h("li", { class: "is-" + e.team.toLowerCase() },
        h("i", { "aria-hidden": "true" }), h("b", null, e.ownGoal ? who(e.player) + " (OG)" : who(e.player) || "Goal"),
        " " + num(e.from.dist).toFixed(0) + " blocks, " + evClock(e, rec)))));
  }

  /* the small print */

  function infoCard(rec, sides) {
    const f = obj(rec.field), r = obj(rec.rules);
    const src = {
      queue: "The pitch's ready zone", referee: "A referee", menu: "The referee menu", fixture: "A club fixture", test: "A practice shootout",
    }[rec.source] || "Unknown";
    const played = arr(rec.halves).reduce((t, x) => t + num(x.seconds), 0);
    const rows = [
      ["Pitch", [str(f.name) || str(f.id), num(f.length) && num(f.width) ? h("small", null, ` ${Math.round(f.length)} × ${Math.round(f.width)} blocks`) : null]],
      ["Mode", modeName(rec.mode) + (rec.knockout ? " (knockout)" : "")],
      ["Rules", [rulesLine(rec), num(r.scorePerGoal) > 1 ? ` · goals worth ${r.scorePerGoal} points` : ""]],
      ["Started by", rec.startedBy && UUID_RE.test(str(rec.startedBy.uuid))
        ? [h("a", { class: "mh-plink", href: toPlayer(rec.startedBy.uuid), "data-go": true }, nameOf(rec.startedBy)), rec.source === "referee" || rec.source === "menu" ? " (referee)" : ""]
        : src],
      ["Kick-off", num(rec.kickoffAt) ? F.time.format(new Date(rec.kickoffAt)) : "–"],
      ["Final whistle", num(rec.endedAt) ? F.time.format(new Date(rec.endedAt)) : "–"],
      ["Length", minutesText(rec.durationSeconds) + (played ? ` (${clockOf(played)} of play)` : "")],
    ];
    const link = new URL(href({ view: "match", id: rec.id }), location.href).href;
    const btn = h("button", { class: "chip mh-copy", type: "button" }, icon("copy"), h("span", null, "Copy link"));
    btn.addEventListener("click", async () => {
      if (await copy(link)) {
        btn.lastChild.textContent = "Copied!";
        announce("Link copied");
        setTimeout(() => (btn.lastChild.textContent = "Copy link"), 1500);
      }
    });
    return h("section", { class: "mh-card mh-info", "aria-labelledby": "mh-in" },
      sectionHead(h("span", { id: "mh-in" }, "Match info")),
      h("dl", { class: "mh-info-list" }, rows.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v)))),
      h("div", { class: "mh-info-foot" }, h("code", null, str(rec.id)), btn));
  }

  /* ── view: player ──────────────────────────────────────────────── */

  async function viewPlayer(r, token) {
    if (!UUID_RE.test(r.uuid)) throw new ApiError("notfound");
    const d = await get("/players/" + r.uuid, { page: r.page, size: 20 }, 30000);
    if (token !== S.token) return null;
    const me = obj(d.player);
    const byMode = obj(d.byMode);
    const all = d.totals && typeof d.totals === "object" ? d.totals : null;
    const t = r.mode ? byMode[r.mode] || null : all;
    const name = nameOf(me.name ? me : all || me);
    const games = obj(d.games);
    setTitle(name);

    const club = (all && all.club) || null;
    const form = arr(all && all.form);
    const modes = [["", "All"]].concat(["MATCH", "SCRIM", "QUICK"].filter((m) => byMode[m]).map((m) => [m, modeName(m)]));

    const body = h("img", {
      class: "mh-pl-body", alt: "", loading: "eager", decoding: "async",
      src: `https://mc-heads.net/body/${r.uuid}/240`,
    });
    body.addEventListener("error", () => body.replaceWith(avatar(r.uuid, name, 120, "mh-pl-ava")), { once: true });

    const hero = h("section", { class: "mh-pl-hero", "aria-labelledby": "mh-pl-name" },
      h("div", { class: "mh-hero-top" },
        h("a", { class: "mh-back", href: S.lastList, "data-go": true }, icon("tri"), "Match history")),
      h("div", { class: "mh-pl-grid" },
        h("div", { class: "mh-pl-render" }, body),
        h("div", { class: "mh-pl-text" },
          h("p", { class: "mh-eyebrow" }, "Player"),
          h("h1", { class: "mh-pl-name", id: "mh-pl-name" }, name),
          h("div", { class: "mh-pl-tags" },
            clubChip(club),
            all ? h("span", { class: "mh-dim" }, "Last played " + ago(num(all.lastPlayed))) : null),
          form.length ? h("div", { class: "mh-form", "aria-label": "Form, most recent first" },
            h("span", { class: "mh-form-label", "aria-hidden": "true" }, "Form"),
            form.map((x) => resultBadge(x))) : null,
          t ? headline(t) : null)));

    const out = [hero];

    if (modes.length > 2 || r.mode) {
      out.push(segmented("Mode", modes, r.mode, (v) => href({ view: "player", uuid: r.uuid, mode: v }), "pmode"));
    }
    if (t) out.push(totalsGrid(t));
    else if (all || r.mode) out.push(h("p", { class: "mh-card mh-dim" }, `No finished ${r.mode ? modeName(r.mode).toLowerCase() + " " : ""}matches yet.`));
    else out.push(h("p", { class: "callout mh-callout" }, "None of their matches reached a result yet (stopped, abandoned or interrupted matches don't count), so there are no totals to show."));

    const items = arr(games.items);
    out.push(h("section", { class: "mh-card mh-pl-games", "aria-labelledby": "mh-pg" },
      sectionHead(h("span", { id: "mh-pg" }, "Matches"), num(games.total) + (num(games.total) === 1 ? " match, newest first" : " matches, newest first")),
      items.length ? h("ol", { class: "mh-pg-list" }, items.map(gameRow)) : h("p", { class: "mh-dim" }, "Nothing on this page."),
      pager(num(games.page), num(games.pages), (p) => href({ view: "player", uuid: r.uuid, mode: r.mode, page: p }), "Match pages")));
    return out;
  }

  function headline(t) {
    const g = num(t.games);
    const tiles = [
      ["Matches", g],
      ["Win rate", g ? Math.round((num(t.wins) / g) * 100) + "%" : "–"],
      ["Goals", num(t.goals)],
      ["Assists", num(t.assists)],
      ["MVPs", num(t.mvps)],
    ];
    return h("ul", { class: "mh-pl-head" },
      tiles.map(([k, v]) => h("li", null, h("b", null, v), h("span", { class: "mh-pl-k" }, k))),
      h("li", { class: "is-rating" }, ratingBadge(t.rating, true), h("span", { class: "mh-pl-k" }, "Avg rating")));
  }

  function totalsGrid(t) {
    const g = num(t.games) || 1;
    const per = (v) => (num(v) / g).toFixed(2).replace(/\.?0+$/, "") || "0";
    const w = num(t.wins), d = num(t.draws), l = num(t.losses), tot = w + d + l || 1;
    const group = (title, rows) => h("div", { class: "mh-tot" },
      h("h3", null, title),
      h("dl", { class: "mh-mini" }, rows.filter(Boolean).map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v)))));
    const positions = Object.entries(obj(t.positions));
    const most = Math.max(1, ...positions.map(([, n]) => num(n)));
    const pk = num(t.pkScored) + num(t.pkMissed) + num(t.pkSaved);

    return h("section", { class: "mh-card mh-totals", "aria-labelledby": "mh-tt" },
      sectionHead(h("span", { id: "mh-tt" }, "Career"), "From matches that reached a result."),
      h("div", { class: "mh-wdl-bar", role: "img", "aria-label": `${w} won, ${d} drawn, ${l} lost` },
        h("i", { class: "is-w", style: { "--w": (w / tot) * 100 + "%" } }),
        h("i", { class: "is-d", style: { "--w": (d / tot) * 100 + "%" } }),
        h("i", { class: "is-l", style: { "--w": (l / tot) * 100 + "%" } })),
      h("p", { class: "mh-wdl-key", "aria-hidden": "true" },
        h("span", { class: "is-w" }, w + " W"), h("span", { class: "is-d" }, d + " D"), h("span", { class: "is-l" }, l + " L")),
      h("div", { class: "mh-tot-grid" },
        group("Scoring", [["Goals", num(t.goals)], ["Assists", num(t.assists)], ["Goals + assists per match", per(num(t.goals) + num(t.assists))], ["On target", num(t.shotsOnTarget)], num(t.ownGoals) ? ["Own goals", num(t.ownGoals)] : null]),
        group("Defending", [["Tackles", num(t.tackles)], ["Steals", num(t.steals)], ["Interceptions", num(t.interceptions)], ["Saves", num(t.saves)], ["Clean sheets", num(t.cleanSheets)]]),
        group("On the ball", [["Passes", num(t.passes)], ["Time on the ball", clockOf(t.possessionSeconds)], ["Time played", minutesText(t.secondsPlayed)], ["Player of the match", num(t.mvps)]]),
        pk ? group("Shootouts", [["Scored", num(t.pkScored)], ["Missed", num(t.pkMissed)], ["Saved", num(t.pkSaved)]]) : null,
        positions.length ? h("div", { class: "mh-tot" },
          h("h3", null, "Positions"),
          h("ul", { class: "mh-posbars" }, positions.map(([p, n]) => h("li", null,
            h("span", { class: "mh-pos", title: POSITIONS[p] || p }, p),
            h("span", { class: "mh-posbar" }, h("i", { style: { "--w": (num(n) / most) * 100 + "%" } })),
            h("b", null, num(n)), vh(" matches as " + (POSITIONS[p] || p)))))) : null));
  }

  function gameRow(g, i) {
    const done = g.outcome === "COMPLETED";
    const us = { key: "RED", name: str(g.teamName) || "Their side", color: hex(g.teamColor, "#aaaaaa") };
    const them = { key: "BLUE", name: str(g.opponentName) || "Opponents", color: hex(g.opponentColor, "#aaaaaa") };
    const sc = arr(g.score), so = arr(g.shootout);
    const a = toMatch(g.id, g.number);
    a.className = "mh-grow" + (done ? "" : " is-void");
    append(a, [
      h("span", { class: "mh-grow-when" }, h("b", null, dayLabel(num(g.startedAt))), h("span", null, modeName(g.mode))),
      done && g.result ? resultBadge(g.result) : h("span", { class: "mh-tag is-void" }, OUTCOME[g.outcome] || "Unfinished"),
      h("span", { class: "mh-grow-teams" },
        h("span", { class: "mh-dotname", style: sideVars(us) }, h("i"), us.name),
        h("b", { class: "mh-grow-score" }, num(sc[0]) + "–" + num(sc[1]), so.length === 2 && num(so[0]) + num(so[1]) > 0 ? h("small", null, ` (${num(so[0])}–${num(so[1])} pens)`) : null),
        h("span", { class: "mh-dotname", style: sideVars(them) }, h("i"), them.name)),
      h("span", { class: "mh-grow-me" },
        g.position ? h("span", { class: "mh-pos", title: POSITIONS[g.position] || g.position }, g.position) : null,
        num(g.goals) ? h("span", { class: "mh-b is-goal", title: g.goals + " goals" }, icon("ball"), g.goals > 1 ? g.goals : null, vh(" goals")) : null,
        num(g.assists) ? h("span", { class: "mh-b is-assist", title: g.assists + " assists" }, icon("boot"), g.assists > 1 ? g.assists : null, vh(" assists")) : null,
        g.cleanSheet ? h("span", { class: "mh-b is-cs", title: "Clean sheet" }, icon("glove"), vh(" clean sheet")) : null,
        g.mvp ? h("span", { class: "mh-b is-mvp", title: "Player of the match" }, icon("star"), vh(" MVP")) : null,
        ratingBadge(g.rating)),
    ]);
    return h("li", { style: { "--i": Math.min(i, 12) } }, a);
  }

  /* ── view: leaderboards ────────────────────────────────────────── */

  function fmtStat(stat, v) {
    v = num(v);
    if (stat === "winrate") return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "") + "%";
    if (stat === "rating") return v.toFixed(1);
    if (stat === "possession") return clockOf(v);
    return Math.round(v).toLocaleString();
  }

  async function viewLeaders(r, token) {
    const [meta, d] = await Promise.all([
      getMeta().catch(() => null),
      get("/leaders", { stat: r.stat, mode: r.mode, limit: r.limit }, 30000),
    ]);
    if (token !== S.token) return null;
    if (meta) renderCounters(meta);
    const def = STAT[r.stat];
    setTitle(def[1] + " leaderboard");
    // the server echoes the stat it actually used; anything else is a
    // board it doesn't know, which we'd rather show as empty than wrong
    const items = str(d.stat) === r.stat ? arr(d.items) : [];
    const min = num(d.min) || 1;

    const picker = h("div", { class: "mh-statpick", role: "group", "aria-label": "Stat" },
      STATS.map(([k, label]) => h("a", {
        href: href({ view: "leaders", stat: k, mode: r.mode }), "data-go": true, "data-focus": "stat:" + k,
        "aria-current": k === r.stat ? "true" : null,
      }, label)));

    const out = [
      h("div", { class: "mh-filters" },
        segmented("Mode", [["", "All"], ["MATCH", "Match"], ["SCRIM", "Scrim"], ["QUICK", "Quick"]], r.mode,
          (v) => href({ view: "leaders", stat: r.stat, mode: v }), "lmode")),
      picker,
    ];

    const sub = def[3] + (min > 1 ? ` At least ${min} matches to qualify.` : "") + " Only matches that reached a result count.";
    if (!items.length) {
      out.push(note("wait", "No one on this board yet", sub, []));
      return out;
    }

    const podium = items.slice(0, 3);
    const rest = items.slice(3);
    out.push(h("section", { class: "mh-board", "aria-labelledby": "mh-lb" },
      h("h2", { class: "mh-sec-title", id: "mh-lb" }, def[1], r.mode ? h("span", { class: "mh-dim" }, " · " + modeName(r.mode)) : null),
      h("p", { class: "mh-sec-sub" }, sub),
      h("ol", { class: "mh-podium", style: { "--n": podium.length } }, podium.map((x, i) => h("li", { class: "is-" + (i + 1) },
        h("a", { href: toPlayer(x.uuid), "data-go": true },
          h("span", { class: "mh-podium-rank" }, num(x.rank)),
          avatar(x.uuid, nameOf(x), 64),
          h("b", { class: "mh-podium-name" }, nameOf(x)),
          x.club ? clubChip(x.club) : null,
          h("span", { class: "mh-podium-val" }, fmtStat(r.stat, x.value)),
          h("small", null, num(x.games) + (num(x.games) === 1 ? " match" : " matches")))))),
      rest.length ? h("table", { class: "mh-lb-table" },
        h("caption", { class: "visually-hidden" }, def[1] + " leaderboard, from 4th place"),
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "#"), h("th", { scope: "col" }, "Player"), h("th", { scope: "col" }, def[1]), h("th", { scope: "col" }, "Matches"))),
        h("tbody", null, rest.map((x) => h("tr", null,
          h("td", { class: "mh-lb-rank" }, num(x.rank)),
          h("td", null, h("a", { class: "mh-lb-who", href: toPlayer(x.uuid), "data-go": true }, avatar(x.uuid, nameOf(x), 28), h("span", null, nameOf(x))),
            x.club ? clubChip(x.club) : null),
          h("td", { class: "mh-lb-val" }, fmtStat(r.stat, x.value)),
          h("td", { class: "mh-lb-games" }, num(x.games)))))) : null,
      items.length >= r.limit && r.limit < 100
        ? h("div", { class: "mh-more" }, h("a", { class: "btn btn-dark", href: href(Object.assign({}, r, { limit: r.limit === 25 ? 50 : 100 })), "data-go": true, "data-keep": true, "data-focus": "lb-more" }, "Show more"))
        : null));
    return out;
  }

  /* ── view: players ─────────────────────────────────────────────── */

  async function viewPlayers(r, token) {
    const [meta, d] = await Promise.all([
      getMeta().catch(() => null),
      get("/leaders", { stat: "games", limit: 30 }, 60000).catch(() => null),
    ]);
    if (token !== S.token) return null;
    if (meta) renderCounters(meta);
    setTitle("Players");
    const box = searchBox(true, r.q);
    const regulars = d && str(d.stat) === "games" ? arr(d.items) : [];
    return [
      h("section", { class: "mh-card mh-find", "aria-labelledby": "mh-fp" },
        h("h2", { class: "mh-sec-title", id: "mh-fp" }, "Find a player"),
        h("p", { class: "mh-sec-sub" }, "Search by Minecraft name. Old names work too."),
        box),
      regulars.length ? h("section", { class: "mh-regulars", "aria-labelledby": "mh-rg" },
        h("h2", { class: "mh-sec-title", id: "mh-rg" }, "Regulars"),
        h("p", { class: "mh-sec-sub" }, "The most matches played to a result."),
        h("ul", { class: "mh-reg-grid" }, regulars.map((x, i) => h("li", { style: { "--i": Math.min(i, 16) } },
          h("a", { href: toPlayer(x.uuid), "data-go": true },
            avatar(x.uuid, nameOf(x), 40),
            h("b", null, nameOf(x)),
            h("small", null, num(x.games) + (num(x.games) === 1 ? " match" : " matches"))))))) : null,
    ];
  }

  /* ── player search: a combobox in the page head, a plain list on
     the Players tab ─────────────────────────────────────────────── */

  function searchBox(inline, initial) {
    const id = "mh-q" + ++uid;
    const input = h("input", {
      type: "search", id, class: "mh-sinput", placeholder: "Find a player", autocomplete: "off",
      autocapitalize: "off", spellcheck: "false", maxlength: "16", enterkeyhint: "search",
    });
    input.value = initial || "";
    const list = h("ul", { id: id + "-list", class: "mh-sresults" + (inline ? " is-inline" : ""), role: inline ? null : "listbox", "aria-label": "Players" });
    const msg = h("p", { class: "mh-smsg", role: "status" });
    const wrap = h("div", { class: "mh-sbox" + (inline ? " is-inline" : "") },
      h("label", { class: "visually-hidden", for: id }, "Find a player by name"),
      h("span", { class: "mh-sicon", "aria-hidden": "true" }, icon("search")),
      input, list, msg);

    if (!inline) {
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-expanded", "false");
      input.setAttribute("aria-controls", list.id);
      list.hidden = true;
    }

    let timer = 0, seq = 0, active = -1, results = [];
    const open = (on) => {
      if (inline) return;
      list.hidden = !on;
      input.setAttribute("aria-expanded", String(on));
      if (!on) { active = -1; input.removeAttribute("aria-activedescendant"); }
    };
    const pick = (i) => {
      const it = results[i];
      if (!it) return;
      open(false);
      go(toPlayer(it.uuid));
    };
    const highlight = (i) => {
      active = i;
      $$("[role=option]", list).forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
      if (i >= 0 && list.children[i]) input.setAttribute("aria-activedescendant", list.children[i].id);
      else input.removeAttribute("aria-activedescendant");
    };

    async function run() {
      const q = input.value.trim();
      const my = ++seq;
      msg.textContent = "";
      if (!q) { results = []; list.replaceChildren(); open(false); return; }
      if (!NAME_RE.test(q)) {
        results = []; list.replaceChildren(); open(false);
        msg.textContent = "Minecraft names are letters, numbers and _ only.";
        return;
      }
      try {
        const d = await get("/players", { q }, 30000);
        if (my !== seq) return;
        results = arr(d.items).filter((x) => UUID_RE.test(str(x.uuid)));
        list.replaceChildren(...results.map((x, i) => inline
          ? h("li", null, h("a", { href: toPlayer(x.uuid), "data-go": true }, avatar(x.uuid, nameOf(x), 28), h("span", null, nameOf(x))))
          : h("li", { id: id + "-o" + i, role: "option", "aria-selected": "false",
            on: { pointerdown: (e) => { e.preventDefault(); pick(i); } } }, avatar(x.uuid, nameOf(x), 24), h("span", null, nameOf(x)))));
        highlight(-1);
        open(results.length > 0);
        msg.textContent = results.length ? (inline ? "" : results.length + (results.length === 1 ? " player found" : " players found")) : `Nobody called "${q}" has played yet.`;
      } catch {
        if (my === seq) msg.textContent = "Search isn't working right now.";
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, 220);
      if (inline) {
        // keep the address shareable without filling the back button
        history.replaceState(history.state, "", href({ view: "players", q: input.value.trim().slice(0, 16) }));
      }
    });
    input.addEventListener("keydown", (e) => {
      if (inline) return;
      if (e.key === "ArrowDown" && results.length) { e.preventDefault(); open(true); highlight((active + 1) % results.length); }
      else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); highlight(active <= 0 ? results.length - 1 : active - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (active >= 0) pick(active);
        else if (results.length === 1) pick(0);
        else if (input.value.trim()) go(href({ view: "players", q: input.value.trim() }));
      } else if (e.key === "Escape") { if (!list.hidden) { e.stopPropagation(); open(false); } }
    });
    input.addEventListener("blur", () => setTimeout(() => open(false), 120));
    input.addEventListener("focus", () => { if (results.length) open(true); });
    if (initial) run();
    return wrap;
  }

  const VIEWS = { list: viewList, match: viewMatch, player: viewPlayer, leaders: viewLeaders, players: viewPlayers };

  /* ── start ─────────────────────────────────────────────────────── */

  $$("a", tabs).forEach((a) => a.setAttribute("data-go", ""));
  if (API) {
    searchSlot.appendChild(searchBox(false, ""));
    searchSlot.hidden = false;
  }
  render();
})();
