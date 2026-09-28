/* ==================================================================
   MCS — the cup (/cup/)

   Reads the tournament API (soccer/docs/tournaments.md) through the
   same HTTPS proxy as match history (`matchesApi` in site.config.js):
     ./              the open cup, or the last one for 48 h ("Last cup")
     ./?id=cup-...   one cup, from the past cups list
   404.html sends /cup/<id> here as ./?id=<id>.

   The bracket comes from each match's round and index alone (doc,
   "Drawing the bracket"): match r{R}m{i} is fed by r{R-1}m{2i-1} into
   side a and r{R-1}m{2i} into side b, so 0-based index j of round R is
   fed by indexes 2j and 2j+1 of round R-1. Two-sided when there is room
   (top half of round 1 on the left, bottom half on the right, the final
   in the middle, like the boards in game), one-sided on phones.
   ================================================================== */

(function () {
  "use strict";

  const main = document.querySelector("[data-cup]");
  if (!main) return;

  const CFG = window.MCS || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = $("[data-cup-view]");
  const staleNote = $("[data-cup-stale]");

  /* ── what the data looks like ──────────────────────────────────── */

  const CUP_RE = /^cup-\d{8}-\d{6}$/;
  const MATCH_RE = /^\d{8}-\d{6}-[a-z0-9_]{1,40}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const STATES = ["SIGNUP", "RUNNING", "FINISHED", "CANCELLED"];
  const M_STATES = ["WAITING", "READY", "LIVE", "DONE"];
  const T_STATUS = ["IN", "OUT", "WITHDRAWN", "CHAMPION"];

  // round names as the doc spells them, short for tiles and chips, and
  // one match of them for screen readers ("Semifinal 1")
  const SHORT = { "Final": "Final", "Semifinals": "SF", "Quarterfinals": "QF", "Round of 16": "R16", "Round of 32": "R32" };
  const ONE = { "Semifinals": "Semifinal", "Quarterfinals": "Quarterfinal" };
  const roundNameFor = (n) => ({ 1: "Final", 2: "Semifinals", 4: "Quarterfinals" })[n] || "Round of " + n * 2;

  /* ── small helpers ─────────────────────────────────────────────── */

  const str = (v) => (typeof v === "string" ? v : "");
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, "0");
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  // Build DOM. Strings always become text, never markup: every team and
  // player name here was typed by a player. `html` is only ever given the
  // constant pixel art below.
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

  /* pixel icons: constant markup, one unit per pixel (as matches.js) */
  const ICONS = {
    tri: ["0 0 10 17", "M0 0h2v2h2v2h2v2h2v2h2v1h-2v2H6v2H4v2H2v2H0z"],
    trophy: ["0 0 9 8", "M1 0h7v1H1zM0 1h1v2H0zM8 1h1v2H8zM1 3h1v1H1zM7 3h1v1H7zM2 1h5v3H2zM3 4h3v1H3zM4 5h1v1H4zM2 7h5v1H2zM3 6h3v1H3z"],
    ball: ["0 0 8 8", "M2 0h4v1h1v1h1v4H7v1H6v1H2V7H1V6H0V2h1V1h1z", "M3 2h2v1h1v2H5v1H3V5H2V3h1z"],
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
      svg.appendChild(p);
    }
    return svg;
  }

  // The cup itself: a 16x16 pixel trophy in the site's lime ramp. Lit for
  // a live or finished cup, unlit (greys) on the empty and error notes.
  const TROPHY =
    '<svg class="px cup-trophy-svg" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path class="tr-lo" d="M1 2h2v1H1zM1 3h1v2H1zM2 5h1v1H2zM13 2h2v1h-2zM14 3h1v2h-1zM13 5h1v1h-1zM11 2h2v4h-2zM10 6h2v1h-2zM9 7h2v1H9zM6 8h4v1H6zM7 9h2v1H7z"/>' +
    '<path class="tr-mid" d="M3 2h8v4H3zM4 6h6v1H4zM5 7h4v1H5zM7 10h2v1H7zM5 11h6v1H5z"/>' +
    '<path class="tr-hi" d="M3 1h10v1H3zM4 2h1v5H4zM5 7h1v1H5zM5 11h1v1H5zM7 3h1v1H7z"/>' +
    '<path class="tr-base" d="M4 12h8v2H4zM3 14h10v1H3z"/>' +
    '<path class="tr-plate" d="M6 12h4v1H6z"/></svg>';
  const trophy = (cls) => h("span", { class: "cup-trophy" + (cls ? " " + cls : ""), "aria-hidden": "true", html: TROPHY });

  /* ── colours: each team has one of 16 bracket colours from the game.
     Pick readable text for it, and lift dark ones so bars and shields
     still show on this dark page (the same maths as matches.js) ── */

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
  // dark text where it reads better than white (4.5:1 either way at the switch)
  const onColor = (c) => (lum(c) > 0.18 ? "#0b1210" : "#ffffff");
  const CARD_L = lum("#0b1310");
  const vividMemo = new Map();
  function vivid(c) {
    if (vividMemo.has(c)) return vividMemo.get(c);
    let t = lum(c) < 0.045 ? 0.42 : 0, o = mix(c, "#ffffff", t);
    while ((lum(o) + 0.05) / (CARD_L + 0.05) < 3 && t < 1) o = mix(c, "#ffffff", (t += 0.05));
    vividMemo.set(c, o);
    return o;
  }
  function teamVars(t) {
    return {
      "--c": t.color,
      "--cv": vivid(t.color),
      "--ce": lum(t.color) < 0.045 ? vivid(t.color) : mix(t.color, "#000000", 0.55),
      "--on": onColor(t.color),
    };
  }

  /* ── time ──────────────────────────────────────────────────────── */

  const F = {
    time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }),
    day: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }),
    dayYear: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }),
  };
  function dayStart(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); }
  // "today 7:25 PM", "yesterday 7:25 PM", "Sat, Sep 27", "Sep 27, 2025"
  function when(ms) {
    if (!ms) return "";
    const d = new Date(ms), now = new Date();
    const diff = Math.round((dayStart(now) - dayStart(d)) / 864e5);
    if (diff === 0) return "today " + F.time.format(d);
    if (diff === 1) return "yesterday " + F.time.format(d);
    return d.getFullYear() === now.getFullYear() ? F.day.format(d) : F.dayYear.format(d);
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ── the API ───────────────────────────────────────────────────── */

  // matchesApi, or on localhost ?api=http://localhost:PORT (kept for the
  // tab). The override is ignored on the real site so nobody can dress
  // other data up as ours.
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
      if (location.protocol === "https:" && u.protocol === "http:") {
        console.warn("[cup] matchesApi must be an https:// address on an https:// site:", base);
        return "";
      }
      return u.href.replace(/\/+$/, "");
    } catch { return ""; }
  })();

  class ApiError extends Error {
    constructor(kind, status) { super(kind); this.kind = kind; this.status = status || 0; }
  }

  // GET a JSON route: { body, stale }. Retries the API's "try again"
  // answers a couple of times: 503 busy, or a 200 that says loading.
  async function get(path) {
    const url = API + "/api/v1" + path;
    for (let attempt = 0; ; attempt++) {
      let res, body = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      try {
        // no custom headers: they would need a CORS preflight
        res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
        body = await res.json().catch(() => null);
      } catch {
        clearTimeout(timer);
        throw new ApiError("offline");
      }
      clearTimeout(timer);
      if (res.status === 503 && attempt < 2) { await sleep(2000); continue; }
      if (res.status === 404) throw new ApiError("notfound", 404);
      if (!res.ok || !body || typeof body !== "object") throw new ApiError("server", res.status);
      if (body.loading === true) {
        if (attempt < 2) { await sleep(2000); continue; }
        throw new ApiError("loading");
      }
      return { body, stale: (res.headers.get("X-MCS-Cache") || "").toUpperCase() === "STALE" };
    }
  }

  // site.js already asked for /current to set up the nav link: use that
  // answer for the first draw rather than asking twice
  async function fromSite() {
    const s = window.__mcsCup;
    window.__mcsCup = null;
    if (!s || s.base !== API || !s.answer) return null;
    const res = await s.answer;
    if (!res) return null;
    if (res.status === 404) throw new ApiError("notfound", 404);
    if (res.status === 200 && res.body && typeof res.body === "object" && res.body.loading !== true) {
      return { body: res.body, stale: res.cache === "STALE" };
    }
    return null;
  }

  /* ── pictures: heads and pixel shields ─────────────────────────── */

  function initialTile(name, cls) {
    const ch = (str(name).match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    return h("span", { class: "mh-ava mh-ava-x " + (cls || ""), "aria-hidden": "true" }, ch);
  }
  // heads by UUID (a name can belong to someone else later): mc-heads,
  // then minotar, then an initial
  function avatar(uuid, name, size, cls) {
    if (!UUID_RE.test(str(uuid))) return initialTile(name, cls);
    const img = h("img", {
      class: "mh-ava " + (cls || ""), alt: "", width: size, height: size, loading: "lazy",
      src: `https://mc-heads.net/avatar/${uuid}/${size * 2}`,
    });
    img.addEventListener("error", function once() {
      img.removeEventListener("error", once);
      img.addEventListener("error", () => img.replaceWith(initialTile(name, cls)), { once: true });
      img.src = `https://minotar.net/helm/${uuid.replace(/-/g, "")}/${size * 2}`;
    });
    return img;
  }

  // the site's pixel shield in the team's colour, with its seed (or its
  // initial before the draw) in readable text
  function shield(t, size, text) {
    const label = text != null ? String(text) : (t.name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    const wrap = h("span", { class: "mh-crest mh-crest-" + (size || "md"), style: teamVars(t), "aria-hidden": "true" });
    wrap.innerHTML =
      '<svg class="px" viewBox="0 0 12 14"><path class="mh-shield-edge" d="M0 0h12v8h-1v2h-1v1H9v1H8v1H7v1H5v-1H4v-1H3v-1H2v-1H1V8H0z"/>' +
      '<path class="mh-shield-fill" d="M1 1h10v7h-1v2H9v1H8v1H7v1H5v-1H4v-1H3v-1H2V8H1z"/><path class="mh-shield-shine" d="M1 1h10v2H1z"/></svg>';
    wrap.appendChild(h("b", null, label));
    return wrap;
  }

  const playerHref = (uuid) => "../matches/?p=" + encodeURIComponent(uuid);

  /* ── the model ─────────────────────────────────────────────────── */

  function pair(o) {
    return o && typeof o === "object" && typeof o.a === "number" && typeof o.b === "number" ? { a: o.a, b: o.b } : null;
  }

  function norm(raw) {
    const t = obj(raw);
    const teams = arr(t.teams).map((x, i) => {
      x = obj(x);
      return {
        id: str(x.id) || "team-" + i,
        name: str(x.name).trim() || "Team " + (i + 1),
        color: hex(x.color, "#8d99ae"),
        seed: num(x.seed) >= 1 ? Math.round(num(x.seed)) : 0,
        status: T_STATUS.includes(x.status) ? x.status : "IN",
        members: arr(x.members).map((m) => ({ uuid: str(obj(m).uuid).toLowerCase(), name: str(obj(m).name).trim() || "Unknown player" })),
      };
    });
    const rounds = arr(t.rounds).map((r) => {
      r = obj(r);
      const R = Math.round(num(r.round));
      return {
        round: R,
        name: str(r.name).trim(),
        matches: arr(r.matches).map((m) => {
          m = obj(m);
          return {
            id: str(m.id),
            round: Math.round(num(m.round)) || R,
            index: Math.round(num(m.index)),
            a: str(m.a),
            b: str(m.b),
            state: M_STATES.includes(m.state) ? m.state : "WAITING",
            bye: m.bye === true,
            score: pair(m.score),
            shootout: pair(m.shootout),
            winner: str(m.winner),
            decidedBy: str(m.decidedBy),
            pitch: str(m.pitch).trim(),
            matchId: MATCH_RE.test(str(m.matchId)) ? m.matchId : "",
          };
        }),
      };
    }).filter((r) => r.round >= 1).sort((a, b) => a.round - b.round);
    const rules = obj(t.rules);
    return {
      id: str(t.id),
      name: str(t.name).trim() || "MCS Cup",
      state: STATES.includes(t.state) ? t.state : rounds.length ? "RUNNING" : "SIGNUP",
      teamSize: Math.round(num(t.teamSize)),
      teamCount: Math.round(num(t.teamCount)) || teams.length,
      maxTeams: Math.round(num(t.maxTeams)),
      createdAt: num(t.createdAt),
      startedAt: num(t.startedAt),
      finishedAt: num(t.finishedAt),
      version: num(t.version),
      rules: { halves: Math.round(num(rules.halves)), halfMinutes: num(rules.halfMinutes), extraTime: rules.extraTime === true },
      teams,
      byId: new Map(teams.map((x) => [x.id, x])),
      rounds,
      champion: str(t.champion),
      runnerUp: str(t.runnerUp),
    };
  }

  const allMatches = (T) => T.rounds.flatMap((r) => r.matches);
  const anyLive = (T) => !!T && allMatches(T).some((m) => m.state === "LIVE");
  const teamName = (T, id) => { const t = id && T.byId.get(id); return t ? t.name : "TBD"; };

  // grid[R-1] = { round, name, matches[j] } for a bracket of k rounds,
  // where round R holds 2^(k-R) matches, placed by their own index
  function gridOf(T) {
    if (!T.rounds.length) return null;
    const k = Math.max(...T.rounds.map((r) => r.round));
    if (k < 1 || k > 6) return null;
    const grid = [];
    for (let R = 1; R <= k; R++) {
      const n = 2 ** (k - R);
      const r = T.rounds.find((x) => x.round === R);
      const matches = Array(n).fill(null);
      T.rounds.forEach((x) => x.matches.forEach((m) => {
        if (m.round === R && m.index >= 0 && m.index < n && !matches[m.index]) matches[m.index] = m;
      }));
      grid.push({ round: R, name: (r && r.name) || roundNameFor(n), matches });
    }
    return grid;
  }
  const codeOf = (col, j) => col.matches.length === 1 ? (SHORT[col.name] || col.name) : (SHORT[col.name] || "R" + col.round) + " " + (j + 1);
  const nameOf = (col, j) => col.matches.length === 1 ? col.name : ONE[col.name] ? ONE[col.name] + " " + (j + 1) : col.name + ", match " + (j + 1);
  const isLit = (m) => !!m && m.state === "DONE" && !!m.winner;

  // where the cup is at: the latest round being played, else the first
  // with a match to play, else the final
  function focusRound(grid) {
    for (let i = grid.length - 1; i >= 0; i--) if (grid[i].matches.some((m) => m && m.state === "LIVE")) return i;
    for (let i = 0; i < grid.length; i++) if (grid[i].matches.some((m) => m && m.state === "READY")) return i;
    for (let i = 0; i < grid.length; i++) if (grid[i].matches.some((m) => !m || m.state !== "DONE")) return i;
    return grid.length - 1;
  }

  /* ── live region ───────────────────────────────────────────────── */

  const status = h("div", { class: "visually-hidden", role: "status" });
  document.body.appendChild(status);
  function announce(msg) {
    status.textContent = "";
    setTimeout(() => (status.textContent = msg), 60);
  }
  const setTitle = (t) => (document.title = (t ? t + " — " : "") + "MCS");

  // buttons made after load can't use site.js's data-open-connect wiring,
  // so they press the footer's "How to join" link instead
  function openConnect() {
    const a = $("footer [data-open-connect]");
    if (a) a.click();
  }

  /* ── pieces ────────────────────────────────────────────────────── */

  const arrowBtn = (label, attrs) => h(attrs.href ? "a" : "button",
    Object.assign({ class: "btn" }, attrs.href ? {} : { type: "button" }, attrs), label, icon("tri", "arrow"));

  function sectionHead(title, id, sub, extra) {
    return h("div", { class: "mh-sec-head" },
      h("div", null, h("h2", { class: "mh-sec-title", id }, title), sub ? h("p", { class: "mh-sec-sub" }, sub) : null),
      extra || null);
  }

  function stateChip(T, last) {
    const playing = T.state === "RUNNING" && anyLive(T);
    const [cls, text] =
      T.state === "SIGNUP" ? ["is-open", T.maxTeams && T.teamCount >= T.maxTeams ? "Sign-ups full" : "Sign-ups open"]
        : T.state === "RUNNING" ? (playing ? ["is-live", "Live"] : ["is-on", "In progress"])
          : T.state === "FINISHED" ? ["is-done", last ? "Last cup" : "Finished"]
            : ["is-off", "Cancelled"];
    return h("span", { class: "cup-state " + cls },
      cls === "is-live" || cls === "is-open" ? h("i", { "aria-hidden": "true" }) : null, text);
  }

  function lengthText(r) {
    if (!r.halfMinutes) return "";
    const t = r.halves > 1 ? r.halves + " × " + r.halfMinutes + " min" : r.halfMinutes + " min";
    return t + (r.extraTime ? " + extra time" : "");
  }

  // the result of a played match, in words
  function resultWords(T, m) {
    const w = teamName(T, m.winner), l = teamName(T, m.winner === m.a ? m.b : m.a);
    const sc = m.score, ws = sc ? (m.winner === m.a ? sc.a : sc.b) : 0, ls = sc ? (m.winner === m.a ? sc.b : sc.a) : 0;
    if (m.decidedBy === "forfeit") return `${w} beat ${l} by forfeit`;
    if (m.decidedBy === "staff") return `${w} went through on a staff call`;
    if (m.decidedBy === "shootout" && m.shootout) {
      const so = m.shootout, wp = m.winner === m.a ? so.a : so.b, lp = m.winner === m.a ? so.b : so.a;
      return `${w} beat ${l} on penalties, ${ws} to ${ls}, ${wp} to ${lp} in the shootout`;
    }
    return sc ? `${w} beat ${l} ${ws} to ${ls}` : `${w} beat ${l}`;
  }

  /* ── the page head ─────────────────────────────────────────────── */

  function hero(T, opts) {
    const chips = [];
    if (T.teamSize) chips.push(T.teamSize + "v" + T.teamSize);
    // (at sign-ups the big count says how many teams are in)
    if (T.state !== "SIGNUP") chips.push(plural(T.teamCount || T.teams.length, "team", "teams"));
    const len = lengthText(T.rules);
    if (len) chips.push(len);
    const at = T.state === "SIGNUP" ? ["Opened ", T.createdAt]
      : T.state === "RUNNING" ? ["Started ", T.startedAt || T.createdAt]
        : T.state === "FINISHED" ? ["Finished ", T.finishedAt]
          : ["Called off ", T.finishedAt];
    if (at[1]) chips.push(at[0] + when(at[1]));

    const art = T.state === "SIGNUP" ? signupArt(T) : T.state === "FINISHED" ? null : h("div", { class: "cup-hero-art" + (T.state === "CANCELLED" ? " is-off" : "") }, trophy(T.state === "CANCELLED" ? "is-off" : ""));

    return h("header", { class: "cup-wrap cup-hero" + (T.state === "FINISHED" ? " is-slim" : "") },
      h("div", { class: "cup-hero-card" },
        h("div", { class: "cup-hero-text" },
          opts.back ? h("a", { class: "mh-back", href: "./", "data-focus": "back" }, icon("tri"), "Cup") : null,
          stateChip(T, opts.last),
          h("h1", { class: "cup-title" }, T.name),
          h("ul", { class: "mh-hero-chips cup-chips", "aria-label": "About this cup" }, chips.map((c) => h("li", null, c)))),
        art));
  }

  // sign-ups: how full it is, as a big count and a row of pixel shields,
  // one per spot, in the colours of the teams that took them
  function signupArt(T) {
    const max = Math.max(T.maxTeams, T.teams.length);
    return h("div", { class: "cup-hero-art is-count" },
      h("p", { class: "cup-count" },
        h("b", { class: "grad" }, T.teamCount, h("span", null, "/", max || "?")),
        h("span", { class: "cup-count-label" }, T.teamCount >= max && max ? "Full" : "Teams in")),
      max ? h("div", { class: "cup-meter", role: "img", "aria-label": `${T.teamCount} of ${max} spots taken` },
        Array.from({ length: max }, (_, i) => {
          const t = T.teams[i];
          return h("i", { class: t ? "" : "is-open", style: t ? { "--c": t.color } : null });
        })) : null);
  }

  /* ── now: live matches and what's next ─────────────────────────── */

  function nowPanel(T, grid) {
    const live = [], next = [];
    grid.forEach((col) => col.matches.forEach((m, j) => {
      if (m && m.state === "LIVE") live.push({ m, col, j });
      else if (m && m.state === "READY") next.push({ m, col, j });
    }));
    if (!live.length && !next.length) return null;
    // "Semifinals up next", or just "Up next" when it spans rounds
    const nextTitle = next.length && next.every((x) => x.col === next[0].col) ? next[0].col.name + " up next" : "Up next";
    return h("section", { class: "cup-wrap cup-now", "aria-label": live.length ? "Live now" : "Up next" },
      live.length ? h("div", { class: "cup-now-block" },
        h("h2", { class: "mh-live-title" }, h("span", { class: "mh-live-dot", "aria-hidden": "true" }), "Live now"),
        h("ul", { class: "mh-live-list cup-live-list" }, live.map((x) => liveCard(T, x)))) : null,
      next.length ? h("div", { class: "cup-now-block" },
        h("h2", { class: "cup-next-title" }, nextTitle),
        h("ul", { class: "cup-next" }, next.slice(0, 4).map((x) => nextRow(T, x)),
          next.length > 4 ? h("li", { class: "cup-next-more" }, `${next.length - 4} more ready to play in the bracket`) : null)) : null);
  }

  function liveCard(T, { m, col, j }) {
    const A = T.byId.get(m.a), B = T.byId.get(m.b);
    if (!A || !B) return null;
    const sc = m.score || { a: 0, b: 0 };
    const heads = (t) => h("span", { class: "mh-live-heads" },
      t.members.slice(0, 5).map((p) => avatar(p.uuid, p.name, 20)),
      t.members.length > 5 ? h("em", null, "+" + (t.members.length - 5)) : null);
    return h("li", { class: "mh-live-card cup-live-card" + (S.flash.has(m.id) ? " is-goal" : ""), style: { "--red": vivid(A.color), "--blue": vivid(B.color) } },
      h("div", { class: "mh-live-top" },
        h("span", null, nameOf(col, j)),
        m.pitch ? h("span", { class: "cup-live-pitch" }, m.pitch) : null),
      h("div", { class: "mh-live-board" },
        h("span", { class: "mh-live-side", "data-team": A.id }, shield(A, "md", A.seed || null), h("span", null, A.name)),
        h("span", { class: "mh-live-score" }, sc.a, h("i", { "aria-hidden": "true" }, "–"), vh(" to "), sc.b),
        h("span", { class: "mh-live-side is-away", "data-team": B.id }, h("span", null, B.name), shield(B, "md", B.seed || null))),
      h("div", { class: "mh-live-foot" },
        heads(A),
        h("span", { class: "cup-live-tag" }, h("i", { "aria-hidden": "true" }), "Live"),
        heads(B)));
  }

  function nextRow(T, { m, col, j }) {
    const A = T.byId.get(m.a), B = T.byId.get(m.b);
    if (!A || !B) return null;
    return h("li", null,
      h("span", { class: "cup-next-code" }, vh(nameOf(col, j) + ": "), h("span", { "aria-hidden": "true" }, codeOf(col, j))),
      h("span", { class: "cup-next-side", "data-team": A.id }, shield(A, "sm", A.seed || null), h("span", null, A.name)),
      h("span", { class: "cup-next-v" }, "v"),
      h("span", { class: "cup-next-side is-away", "data-team": B.id }, h("span", null, B.name), shield(B, "sm", B.seed || null)));
  }

  /* ── the champion ──────────────────────────────────────────────── */

  function championPanel(T, grid) {
    const fin = grid && grid[grid.length - 1].matches[0];
    const champ = T.byId.get(T.champion) || (fin && fin.winner && T.byId.get(fin.winner));
    if (!champ) return null;
    const ruId = T.runnerUp || (fin && (fin.winner === fin.a ? fin.b : fin.a));
    const ru = ruId && T.byId.get(ruId);

    let line = null;
    if (fin && fin.state === "DONE" && ru) {
      const sc = fin.score, won = fin.winner === fin.a;
      const score = sc ? (won ? sc.a + "–" + sc.b : sc.b + "–" + sc.a) : "";
      const pens = fin.shootout ? (won ? fin.shootout.a + "–" + fin.shootout.b : fin.shootout.b + "–" + fin.shootout.a) + " pens" : "";
      const how = fin.decidedBy === "forfeit" ? "by forfeit" : fin.decidedBy === "staff" ? "on a staff call" : score + (pens ? " (" + pens + ")" : "");
      line = h("p", { class: "cup-champ-final" },
        "Beat ", h("b", null, ru.name), " ", how, " in the final",
        fin.matchId ? [" ", h("a", { class: "more", href: "../matches/?m=" + encodeURIComponent(fin.matchId), "data-focus": "final-report" }, "Match report", icon("tri"))] : null);
    }

    // pixel sparkles in the champions' colour and the site's lime
    const sparks = h("div", { class: "cup-sparks", "aria-hidden": "true" },
      [[7, 20, 0], [14, 44, 1], [27, 9, 2], [84, 24, 1], [93, 48, 0], [72, 7, 2], [5, 70, 2], [95, 76, 1], [10, 92, 1], [90, 94, 0]]
        .map(([x, y, k], i) => h("i", { class: "k" + k, style: { left: x + "%", top: y + "%", "--d": (i * 0.37).toFixed(2) + "s" } })));

    return h("section", { class: "cup-wrap cup-champ", "aria-labelledby": "cup-champ-name" },
      h("div", { class: "cup-champ-card", style: teamVars(champ) },
        sparks,
        trophy("is-big"),
        h("p", { class: "cup-champ-label" }, icon("trophy"), "Champions"),
        h("h2", { class: "cup-champ-name", id: "cup-champ-name" }, shield(champ, "lg", champ.seed || null), h("span", null, champ.name)),
        h("ul", { class: "cup-champ-members", "aria-label": "Players" },
          champ.members.map((p) => h("li", null,
            h("a", { href: playerHref(p.uuid), "data-focus": "cp:" + p.uuid }, avatar(p.uuid, p.name, 40), h("span", null, p.name))))),
        line),
      ru ? h("div", { class: "cup-runner", style: teamVars(ru) },
        shield(ru, "md", ru.seed || null),
        h("div", { class: "cup-runner-who" }, h("span", { class: "cup-runner-label" }, "Runner-up"), h("b", null, ru.name)),
        h("span", { class: "cup-runner-heads" }, ru.members.map((p) => avatar(p.uuid, p.name, 24)))) : null);
  }

  /* ── the bracket ───────────────────────────────────────────────── */

  // The tile widths and wire gaps the layout is measured with, by number
  // of rounds; the CSS gets the same numbers through custom properties.
  // The board grows wider than the text column when it can use the room
  // (up to 1760 px), with the page gutter below (as in cup.css).
  const TILE_MIN = { 1: 250, 2: 220, 3: 184, 4: 150, 5: 164 };
  const TILE_MAX = { 1: 300, 2: 280, 3: 250, 4: 220, 5: 200 };
  const GAP_OF = { 1: 34, 2: 40, 3: 36, 4: 30, 5: 26 };
  const CARD_PAD = 28;
  const kOf = (k) => Math.min(5, Math.max(1, k));
  const boardWidth = (k, tile) => {
    if (k <= 1) return tile + 24;
    const cols = 2 * k - 1;
    return cols * tile + 24 + (cols - 1) * GAP_OF[kOf(k)]; // the final is 24 px wider
  };
  function pageWidth() { return document.documentElement.clientWidth || window.innerWidth; }
  const widePad = (w) => (w <= 1180 ? 12 : Math.min(40, Math.max(12, w * 0.025)));
  // "split": two-sided, wherever it fits and on any screen wide enough to
  // hold most of it (a 32-team board then scrolls a little in its frame).
  // "tree": one-sided, when all of that fits. "line": one-sided and
  // compact, one round per swipe (phones).
  function layoutFor(k) {
    const w = pageWidth();
    const avail = Math.min(w, 1760) - 2 * widePad(w) - 2 * CARD_PAD;
    const kk = kOf(k);
    if (k <= 1 || boardWidth(k, TILE_MIN[kk]) <= avail || w >= 1100) return "split";
    if (k * TILE_MIN[kk] + (k - 1) * GAP_OF[kk] <= avail) return "tree";
    return "line";
  }

  // `from`: on the one-sided board, where an undecided side comes from
  // ("QF 1 winner"), since no wire runs straight to it there
  function teamRow(T, m, side, from) {
    const id = m[side];
    const t = id && T.byId.get(id);
    const done = m.state === "DONE";
    if (!t) {
      const bye = done && m.bye && !id;
      return h("div", { class: "cup-t " + (bye ? "is-bye" : "is-tbd") },
        h("span", { class: "cup-seed", "aria-hidden": "true" }),
        h("span", { class: "cup-t-name" }, bye ? "Bye" : id ? "Unknown team" : from ? from + " winner" : "TBD"),
        h("span", { class: "cup-t-sc" }),
        vh(". "));
    }
    const win = done && m.winner === id;
    const lose = done && !!m.winner && m.winner !== id;
    let sc = null;
    if (m.score && (m.state === "LIVE" || done)) sc = String(m.score[side]);
    else if (done && !m.bye && (m.decidedBy === "forfeit" || m.decidedBy === "staff")) sc = win ? "W" : "–";
    // a winner the score can't show (level after penalties, or a staff
    // call against the score) gets a visible W as well as the lime block
    const other = side === "a" ? "b" : "a";
    const hiddenWin = win && !m.bye && sc !== "W" && !(m.score && m.score[side] > m.score[other]);
    return h("div", {
      class: "cup-t" + (win ? " is-win" : "") + (lose ? " is-lose" : "") + (t.status === "WITHDRAWN" ? " is-gone" : ""),
      "data-team": t.id, style: teamVars(t),
    },
      h("span", { class: "cup-seed", "aria-hidden": "true" }, t.seed || ""),
      h("span", { class: "cup-t-name", title: t.name }, t.seed ? vh("Seed " + t.seed + ", ") : null, t.name),
      h("span", { class: "cup-t-end" },
        hiddenWin ? h("b", { class: "cup-t-w", "aria-hidden": "true", title: "Winner" }, "W") : null,
        h("span", { class: "cup-t-sc" }, sc != null ? [vh(", "), h("span", { "aria-hidden": sc === "W" || sc === "–" ? "true" : null }, sc)] : null)),
      win ? vh(m.bye ? ", through with a bye" : ", won") : null,
      t.status === "WITHDRAWN" ? vh(", withdrawn") : null,
      vh(". "));
  }

  // the little state line at the top of each tile
  function headState(T, m) {
    // a called-off cup plays nothing more: no "Up next", no live marker
    if (T.state === "CANCELLED" && m.state !== "DONE") {
      return h("span", { class: "cup-m-state" }, m.state === "LIVE" ? "Stopped" : m.state === "WAITING" ? vh("Not played") : "Not played");
    }
    if (m.state === "LIVE") {
      return h("span", { class: "cup-m-state is-live" }, h("i", { class: "cup-dot", "aria-hidden": "true" }), "Live",
        m.pitch ? h("span", { class: "cup-m-pitch" }, vh(" on "), m.pitch) : null);
    }
    if (m.state === "READY") return h("span", { class: "cup-m-state is-ready" }, "Up next");
    if (m.state !== "DONE") return h("span", { class: "cup-m-state" }, vh("To be decided"));
    const by = m.decidedBy;
    const text = by === "bye" || m.bye ? "Bye"
      : by === "forfeit" ? "Forfeit"
        : by === "staff" ? "Staff call"
          : by === "shootout" && m.shootout ? m.shootout.a + "–" + m.shootout.b + " pens"
            : "FT";
    const said = text === "FT" ? "Full time" : /pens$/.test(text) ? `Penalties, ${m.shootout.a} to ${m.shootout.b}` : text;
    return h("span", { class: "cup-m-state is-done" },
      said === text ? text : [h("span", { "aria-hidden": "true" }, text), vh(said)],
      m.matchId ? icon("tri", "cup-m-go") : null);
  }

  function tile(T, col, m, j, isFinal, feeders) {
    const mm = m || { id: "", state: "WAITING", a: "", b: "", bye: false, score: null, shootout: null, winner: "", decidedBy: "", pitch: "", matchId: "" };
    const link = mm.state === "DONE" && mm.matchId;
    const shown = T.state === "CANCELLED" && mm.state !== "DONE" ? "waiting" : mm.state.toLowerCase();
    return h(link ? "a" : "div", {
      class: "cup-m is-" + shown + (isFinal ? " is-final" : "") + (mm.id && S.flash.has(mm.id) ? " is-goal" : ""),
      href: link ? "../matches/?m=" + encodeURIComponent(mm.matchId) : null,
      "data-focus": link ? "m:" + mm.id : null,
    },
      h("div", { class: "cup-m-head" },
        h("span", { class: "cup-m-code" }, vh(nameOf(col, j) + ". "), h("span", { "aria-hidden": "true" }, codeOf(col, j))),
        headState(T, mm),
        vh(". ")),
      teamRow(T, mm, "a", feeders && feeders[0]),
      teamRow(T, mm, "b", feeders && feeders[1]),
      link ? vh("Match report.") : null);
  }

  function bracketCard(T, grid, layout, intro) {
    const k = grid.length;
    const split = layout === "split" && k > 1;
    const compact = layout === "line";
    const final = grid[k - 1];
    const cols = [];
    if (split) {
      for (let R = 1; R < k; R++) {
        const c = grid[R - 1], half = c.matches.length / 2;
        cols.push({ c, side: "l", js: Array.from({ length: half }, (_, i) => i) });
      }
      cols.push({ c: final, side: "f", js: [0] });
      for (let R = k - 1; R >= 1; R--) {
        const c = grid[R - 1], half = c.matches.length / 2;
        cols.push({ c, side: "r", js: Array.from({ length: half }, (_, i) => half + i) });
      }
    } else {
      grid.forEach((c, i) => cols.push({ c, side: i === k - 1 ? "f" : "l", js: c.matches.map((_, j) => j) }));
    }

    const champ = T.state === "FINISHED" && isLit(final.matches[0]) ? T.byId.get(final.matches[0].winner) : null;
    const halves = { l: ", top half", r: ", bottom half" };

    const columns = cols.map((col, ci) => {
      const R = col.c.round;
      const hid = "cup-c" + ci;
      // the first draw fills in from round 1 inwards, the cup last
      const step = R - 1;
      const items = col.js.map((j) => {
        const m = col.c.matches[j];
        const cls = ["cup-slot"];
        if (col.side !== "f") {
          cls.push("has-out");
          // straight into the final from a one-match column of a two-sided board
          if (split && R === k - 1) cls.push("is-mid");
          else cls.push(j % 2 === 0 ? "is-top" : "is-bot");
          if (isLit(m)) cls.push("is-lit");
        }
        // the one-sided board is compact: a bracket joins each pair and
        // points on, instead of wires that line up with the next round
        if (compact && col.side !== "f" && j % 2 === 0 && (isLit(m) || isLit(col.c.matches[j + 1]))) cls.push("pair-lit");
        if (R > 1) {
          const prev = grid[R - 2].matches;
          const litA = isLit(prev[2 * j]), litB = isLit(prev[2 * j + 1]);
          if (col.side === "f" && split) {
            cls.push("in-l", "in-r");
            if (litA) cls.push("in-l-lit");
            if (litB) cls.push("in-r-lit");
          } else {
            cls.push("has-in");
            if (litA || litB) cls.push("in-lit");
          }
        }
        const isFinal = col.side === "f";
        const feeders = compact && R > 1 ? [codeOf(grid[R - 2], 2 * j), codeOf(grid[R - 2], 2 * j + 1)] : null;
        return h("li", { class: cls.join(" "), style: { "--step": step } },
          isFinal ? h("div", { class: "cup-crown" + (champ ? " is-won" : "") }, trophy(T.state === "CANCELLED" ? "is-off" : "")) : null,
          tile(T, col.c, m, j, isFinal, feeders),
          isFinal && champ ? h("p", { class: "cup-crown-line" }, h("span", { class: "mh-winner" }, icon("trophy"), "Champions"), h("b", null, champ.name)) : null);
      });
      const hasLive = T.state === "RUNNING" && col.js.some((j) => col.c.matches[j] && col.c.matches[j].state === "LIVE");
      return h("section", { class: "cup-col is-" + col.side + (hasLive ? " has-live" : ""), "aria-labelledby": hid, "data-col": ci, "data-round": R },
        h("h3", { class: "cup-col-h", id: hid }, col.c.name, split && col.side !== "f" ? vh(halves[col.side]) : null),
        h("ol", { class: "cup-list" }, items));
    });

    const kk = kOf(k), tmin = TILE_MIN[kk], tmax = TILE_MAX[kk], gap = GAP_OF[kk];
    const template = split
      ? `repeat(${k - 1}, minmax(${tmin}px, ${tmax}px)) minmax(${tmin + 24}px, ${tmax + 24}px) repeat(${k - 1}, minmax(${tmin}px, ${tmax}px))`
      : null;
    // how wide the board would like to be: every tile at its largest
    const need = split ? boardWidth(k, tmax) : 0;

    // rounds to jump between on the one-sided board
    const chips = compact && k > 1 ? h("div", { class: "cup-rchips", role: "group", "aria-label": "Jump to a round" },
      grid.map((c, i) => h("button", {
        type: "button", "data-focus": "rc:" + i, "data-go-col": i, "aria-label": c.name,
      }, SHORT[c.name] || c.name))) : null;

    const played = allMatches(T).filter((m) => m.state === "DONE" && !m.bye).length;
    const total = allMatches(T).filter((m) => !m.bye).length;
    const sub = T.state === "CANCELLED" ? "As it stood when the cup was called off."
      : played ? `${played} of ${total} matches played` : "Seeds are drawn at random. Top seeds get the byes.";

    return h("section", {
      class: "cup-wide", "aria-labelledby": "cup-br-title",
      style: { "--need": need ? need + 2 * CARD_PAD + "px" : null },
    },
      h("div", { class: "cup-br" + (split ? " is-split" : compact ? " is-line" : " is-tree") + (k >= 4 ? " is-dense" : "") + (intro && !reduceMotion ? " is-intro" : "") + (champ ? " has-champ" : "") },
        sectionHead("Bracket", "cup-br-title", sub, chips),
        h("div", { class: "cup-scroll", "data-cup-scroll": true },
          h("div", {
            class: "cup-cols " + (split ? "is-split" : compact ? "is-line" : "is-tree"),
            style: { "grid-template-columns": template, "--gap": gap + "px", "--tile-min": tmin + "px", "--tile-max": tmax + "px" },
          }, columns))));
  }

  // the bracket's own scroller: keyboard reachable when it scrolls, soft
  // edges on the side there is more, chips that follow the visible round
  function setupScroll(sc, keepX) {
    const fit = () => {
      const over = sc.scrollWidth - sc.clientWidth > 2;
      if (over) {
        sc.setAttribute("tabindex", "0");
        sc.setAttribute("role", "region");
        sc.setAttribute("aria-label", "Bracket, scrolls sideways");
        sc.dataset.focus = "scroll";
      } else {
        ["tabindex", "role", "aria-label", "data-focus"].forEach((a) => sc.removeAttribute(a));
      }
      sc.classList.toggle("can-l", over && sc.scrollLeft > 2);
      sc.classList.toggle("can-r", over && sc.scrollLeft < sc.scrollWidth - sc.clientWidth - 2);

      const chips = $$("[data-go-col]", sc.parentElement);
      if (chips.length) {
        const cols = $$(".cup-col", sc);
        const left = sc.getBoundingClientRect().left;
        let best = 0, dist = Infinity;
        cols.forEach((c, i) => { const d = Math.abs(c.getBoundingClientRect().left - left - 16); if (d < dist) { dist = d; best = i; } });
        chips.forEach((b, i) => b.setAttribute("aria-pressed", i === best ? "true" : "false"));
      }
    };
    if (keepX != null) sc.scrollLeft = keepX;
    else {
      const line = sc.querySelector(".cup-cols.is-line");
      if (line) {
        const grid = S.T && gridOf(S.T);
        const col = grid && sc.querySelector(`.cup-col[data-col="${focusRound(grid)}"]`);
        if (col) sc.scrollLeft = col.offsetLeft - sc.firstElementChild.offsetLeft;
      } else if (sc.scrollWidth > sc.clientWidth) {
        sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
      }
    }
    // the one-sided board is only as tall as the rounds on screen, so a
    // later round isn't followed by the empty height of round 1
    const fitHeight = () => {
      if (!sc.querySelector(".cup-cols.is-line")) { sc.style.height = ""; return; }
      const box = sc.getBoundingClientRect();
      let tall = 0;
      $$(".cup-col", sc).forEach((c) => {
        const r = c.getBoundingClientRect();
        if (r.right > box.left + 24 && r.left < box.right - 24) tall = Math.max(tall, c.offsetHeight);
      });
      if (tall) sc.style.height = tall + 16 + "px";
    };
    let raf = 0, settle = 0;
    sc.addEventListener("scroll", () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; fit(); });
      clearTimeout(settle);
      settle = setTimeout(fitHeight, 140);
    }, { passive: true });
    sc._fit = () => { fit(); fitHeight(); };
    fit();
    fitHeight();
  }

  view.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-go-col]");
    if (!b) return;
    const sc = $("[data-cup-scroll]", view);
    const col = sc && sc.querySelector(`.cup-col[data-col="${b.dataset.goCol}"]`);
    if (!col) return;
    sc.scrollTo({ left: col.offsetLeft - sc.firstElementChild.offsetLeft, behavior: reduceMotion ? "auto" : "smooth" });
    // on a tall board, bring the round's first match into view as well
    const first = col.querySelector(".cup-m");
    if (first && first.getBoundingClientRect().top > window.innerHeight) first.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  });

  /* ── teams ─────────────────────────────────────────────────────── */

  function teamCard(T, t) {
    const tag = t.status === "CHAMPION" ? h("span", { class: "mh-winner" }, icon("trophy"), "Champions")
      : t.status === "OUT" ? h("span", { class: "mh-tag is-void" }, "Out")
        : t.status === "WITHDRAWN" ? h("span", { class: "mh-tag is-void" }, "Withdrawn") : null;
    return h("li", { class: "cup-team is-" + t.status.toLowerCase(), style: teamVars(t), "data-team": t.id },
      h("div", { class: "cup-team-top" },
        shield(t, "md", t.seed || null),
        h("div", { class: "cup-team-id" },
          h("h3", { class: "cup-team-name" }, t.name),
          t.seed || tag ? h("div", { class: "cup-team-meta" }, t.seed ? h("small", null, "Seed " + t.seed) : null, tag) : null)),
      t.members.length
        ? h("ul", { class: "cup-members", "aria-label": t.name + " players" },
          t.members.map((p, i) => h("li", null,
            h("a", { href: playerHref(p.uuid), "data-focus": "p:" + t.id + ":" + p.uuid },
              avatar(p.uuid, p.name, 24), h("span", null, p.name)),
            i === 0 ? h("small", null, "Leader") : null)))
        : h("p", { class: "cup-members-none" }, "No players listed"));
  }

  function openSpot(T, i) {
    return h("li", { class: "cup-team is-open" },
      h("span", { class: "cup-open-shield", "aria-hidden": "true" }),
      h("span", { class: "cup-open-text" }, h("b", null, "Open spot"), h("small", null, T.teamSize ? "A party of " + T.teamSize : "")),
      vh(" " + (i + 1)));
  }

  function teamsCard(T) {
    // sign-up order before the draw, seed order after; a finished cup
    // lists its champions and runners-up first
    const rank = (t) => (t.id === T.champion ? -2 : t.id === T.runnerUp ? -1 : t.seed || 999);
    const list = T.state === "SIGNUP" ? T.teams.slice() : T.teams.slice().sort((a, b) => rank(a) - rank(b));
    const items = list.map((t) => teamCard(T, t));
    if (T.state === "SIGNUP") for (let i = list.length; i < T.maxTeams; i++) items.push(openSpot(T, i));
    const alive = T.teams.filter((t) => t.status === "IN").length;
    const sub = T.state === "SIGNUP"
      ? (T.maxTeams ? `${T.teamCount} of ${T.maxTeams} spots taken` : plural(T.teamCount, "team", "teams"))
      : T.state === "RUNNING" ? `${alive} of ${T.teams.length} still in`
        : plural(T.teams.length, "team", "teams");
    if (!items.length) return null;
    // on a phone a big cup's teams would run for screens: show the first
    // eight, and the rest on request (the button only shows on phones)
    const long = items.length > 8;
    const grid = h("ul", { class: "cup-team-grid" + (long ? " is-long" : "") + (S.teamsOpen ? " is-open" : ""), id: "cup-team-grid" }, items);
    const more = long ? h("button", {
      class: "btn btn-dark cup-teams-more", type: "button", "data-focus": "teams-more",
      "aria-expanded": S.teamsOpen ? "true" : "false", "aria-controls": "cup-team-grid",
      on: { click: (e) => {
        S.teamsOpen = !S.teamsOpen;
        grid.classList.toggle("is-open", S.teamsOpen);
        e.currentTarget.setAttribute("aria-expanded", S.teamsOpen ? "true" : "false");
        e.currentTarget.firstChild.textContent = S.teamsOpen ? "Show fewer" : `Show all ${items.length}`;
      } },
    }, S.teamsOpen ? "Show fewer" : `Show all ${items.length}`) : null;
    return h("section", { class: "cup-wrap cup-teams", "aria-labelledby": "cup-teams-title" },
      h("div", { class: "mh-card" },
        sectionHead(T.state === "SIGNUP" ? "Signed up" : "Teams", "cup-teams-title", sub),
        grid,
        more));
  }

  /* ── sign-ups: how to get in ───────────────────────────────────── */

  function joinPanel(T) {
    const full = T.maxTeams && T.teamCount >= T.maxTeams;
    const n = T.teamSize || "your team";
    return h("section", { class: "cup-wrap cup-join", "aria-labelledby": "cup-join-title" },
      h("div", { class: "cup-join-card" },
        h("div", null,
          h("h2", { class: "mh-sec-title", id: "cup-join-title" }, full ? "Sign-ups are full" : "How to join"),
          full ? h("p", { class: "mh-sec-sub" }, "Staff draw the bracket next. Watch it here.") : null),
        full ? h("span", { class: "cup-join-gap" }) : h("ol", { class: "steps cup-steps" },
          h("li", null, "Make a party of ", h("b", null, n), ", all online."),
          h("li", null, "Your party leader types ", h("code", null, "/cup"), " and picks ", h("b", null, "Sign up"), "."),
          h("li", null, "Staff draw the bracket and call each match to a pitch.")),
        h("div", { class: "cup-join-go" }, arrowBtn("Join the server", { on: { click: openConnect } }))));
  }

  /* ── other cups ────────────────────────────────────────────────── */

  function pastCard(list, exceptId, title) {
    const rows = arr(list).map(obj).filter((s) => CUP_RE.test(str(s.id)) && s.id !== exceptId);
    if (!rows.length) return null;
    return h("section", { class: "cup-wrap cup-past", "aria-labelledby": "cup-past-title" },
      sectionHead(title, "cup-past-title"),
      h("ul", { class: "cup-past-list" }, rows.map((s) => {
        const name = str(s.name).trim() || "MCS Cup";
        const ts = Math.round(num(s.teamSize));
        const meta = [plural(Math.round(num(s.teamCount)), "team", "teams"), ts ? ts + "v" + ts : ""].filter(Boolean).join(" · ");
        const ch = obj(s.champion);
        const champ = str(ch.name).trim() ? { name: str(ch.name).trim(), color: hex(ch.color, "#8d99ae") } : null;
        const at = num(s.startedAt) || num(s.createdAt);
        const d = at ? new Date(at) : null;
        const state = s.state === "FINISHED" && champ
          ? h("span", { class: "cup-past-won" }, h("span", { class: "cup-past-k" }, "Won by"),
            h("span", { class: "mh-dotname", style: { "--cv": vivid(champ.color) } }, h("i", { "aria-hidden": "true" }), h("span", { class: "mh-dotname-t" }, champ.name)))
          : s.state === "CANCELLED" ? h("span", { class: "mh-tag is-void" }, "Cancelled")
            : s.state === "RUNNING" ? h("span", { class: "mh-tag cup-tag-live" }, "Live")
              : s.state === "SIGNUP" ? h("span", { class: "mh-tag" }, "Sign-ups open")
                : h("span", { class: "mh-tag is-void" }, "Finished");
        return h("li", null, h("a", { class: "cup-past-row", href: "./?id=" + s.id, "data-focus": "c:" + s.id },
          h("span", { class: "cup-past-when" },
            h("b", null, d ? (d.getFullYear() === new Date().getFullYear() ? F.day.format(d) : F.dayYear.format(d)) : "")),
          h("span", { class: "cup-past-name" }, h("b", null, name), h("small", null, meta)),
          state,
          h("span", { class: "cup-past-go", "aria-hidden": "true" }, icon("tri"))));
      })));
  }

  /* ── notes: nothing on, not found, not answering ───────────────── */

  function note(kind, title, text, actions) {
    return h("section", { class: "cup-wrap cup-note-wrap" },
      h("div", { class: "mh-note cup-note is-" + kind },
        trophy("is-off"),
        h("h1", null, title),
        h("p", null, text),
        actions && actions.length ? h("div", { class: "mh-note-actions" }, actions) : null));
  }

  /* ── routing and state ─────────────────────────────────────────── */

  const q = new URLSearchParams(location.search);
  const routeId = q.has("id") ? str(q.get("id")).trim() : null;

  // kind: "cup" | "none" (no cup on now) | "missing" (unknown id) |
  //       "down" (no answer yet) | "setup" (no API configured)
  const S = {
    kind: "", T: null, live: false, stale: false, list: null, listKey: "",
    sig: "", layout: "", drawnLayout: "", timer: 0, lastPoll: 0, fails: 0, busy: false,
    first: true, hl: "", none404: false, teamsOpen: false,
    flash: new Set(), // matches that just had a goal: they flash once
  };

  function build(grid, layout) {
    const out = [];
    if (S.kind === "cup") {
      const T = S.T;
      const last = !routeId && T.state === "FINISHED" && !S.live;
      setTitle(T.name);
      out.push(hero(T, { back: !!routeId, last }));
      // both finalists removed: FINISHED with no champion (docs/tournaments.md)
      if (T.state === "FINISHED") {
        out.push(championPanel(T, grid)
          || h("p", { class: "callout mh-callout" }, "This cup ended with no winner: both finalists were removed."));
      }
      if (T.state === "CANCELLED") {
        out.push(h("div", { class: "cup-wrap" }, h("p", { class: "callout cup-called" },
          grid ? "Staff called this cup off. Here's how far it got." : "Staff called this cup off before the draw.")));
      }
      if (T.state === "RUNNING" && grid) out.push(nowPanel(T, grid));
      if (T.state === "SIGNUP") out.push(joinPanel(T));
      if (grid) out.push(bracketCard(T, grid, layout, S.first || S.drawnLayout !== layout));
      out.push(teamsCard(T));
      out.push(pastCard(S.list, T.id, routeId ? "More cups" : "Past cups"));
    } else if (S.kind === "setup") {
      setTitle("Cup");
      out.push(note("off", "The cup is almost here",
        "Cups are run in game by staff. The bracket and live scores will show up here.",
        [arrowBtn("Join the server", { on: { click: openConnect } })]));
    } else if (S.kind === "down") {
      setTitle("Cup");
      out.push(note("off", "The game server isn't answering",
        "It might be restarting. This page keeps trying, or you can try again now.",
        [arrowBtn("Try again", { "data-focus": "retry", on: { click: () => refresh(true) } })]));
    } else if (S.kind === "missing") {
      setTitle("Cup not found");
      out.push(note("off", "We couldn't find that cup",
        "The link may be wrong. Every cup is in the list below.",
        [arrowBtn("Back to the cup page", { href: "./", "data-focus": "back" })]));
      out.push(pastCard(S.list, "", "Past cups"));
    } else {
      setTitle("Cup");
      out.push(note("wait", "No cup right now",
        "Staff run cups in game. When the next one opens for sign-ups, it shows up here with the bracket and live scores.",
        [arrowBtn("Join the server", { on: { click: openConnect } }),
          h("a", { class: "btn btn-dark", href: "../rules/#modes", "data-focus": "rules" }, "Knockout rules")]));
      out.push(pastCard(S.list, "", "Past cups"));
    }
    return out.filter(Boolean);
  }

  function draw(force) {
    const grid = S.kind === "cup" ? gridOf(S.T) : null;
    const layout = grid ? layoutFor(grid.length) : "";
    const listSig = (S.list || []).map((x) => str(obj(x).id) + ":" + str(obj(x).state) + ":" + num(obj(x).version)).join(",");
    const sig = [S.kind, S.T ? S.T.id + ":" + S.T.version + ":" + S.T.state : "", S.live, layout, listSig].join("|");
    staleNote.hidden = !S.stale;
    if (!force && sig === S.sig) return;
    S.sig = sig;
    S.layout = layout;
    let nodes;
    try { nodes = build(grid, layout); } catch (e) {
      // data this page can't read must never leave a broken page
      console.error("[cup]", e);
      nodes = [note("off", "The cup couldn't be shown", "Something in its data didn't make sense to this page. It will try again shortly.",
        [arrowBtn("Try again", { "data-focus": "retry", on: { click: () => refresh(true) } })])];
    }
    swap(nodes);
    S.drawnLayout = layout;
  }

  // Replace the view, keeping the reader's place: keyboard focus goes back
  // to the same control, the bracket keeps its sideways scroll, and the
  // page doesn't jump.
  function swap(nodes) {
    const active = document.activeElement;
    const inView = !!active && active !== document.body && view.contains(active);
    const key = inView && active.dataset ? active.dataset.focus || "" : "";
    const sc = $("[data-cup-scroll]", view);
    const keepX = sc && S.drawnLayout === S.layout ? sc.scrollLeft : null;
    const y = window.scrollY;

    view.replaceChildren(...nodes);
    view.removeAttribute("aria-busy");
    if (S.first) {
      [...view.children].forEach((el, i) => {
        el.classList.add("mh-in");
        el.style.setProperty("--i", Math.min(i, 8));
      });
    }
    const sc2 = $("[data-cup-scroll]", view);
    if (sc2) setupScroll(sc2, keepX);

    if (key) {
      const el = view.querySelector(`[data-focus="${CSS.escape(key)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
    if (inView && (!document.activeElement || document.activeElement === document.body)) {
      const hd = $("h1, h2", view);
      if (hd) { hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); }
    }
    if (!S.first && Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
    applyHl();
    S.flash.clear();
    S.first = false;
  }

  // what changed since the last look, for screen readers: kick-offs,
  // goals, results and the champion. Nothing on a poll that changed nothing.
  function tellChanges(prev, next) {
    if (!prev || !next || prev.id !== next.id) return;
    const was = new Map(allMatches(prev).map((m) => [m.id, m]));
    const msgs = [];
    for (const m of allMatches(next)) {
      const p = was.get(m.id);
      if (!p || m.bye) continue;
      const A = teamName(next, m.a), B = teamName(next, m.b);
      if (m.state === "LIVE" && p.state !== "LIVE") msgs.push(`Kick-off: ${A} against ${B}${m.pitch ? " on " + m.pitch : ""}.`);
      else if (m.state === "LIVE" && m.score && p.score && (m.score.a !== p.score.a || m.score.b !== p.score.b)) {
        const upA = m.score.a > p.score.a, upB = m.score.b > p.score.b;
        const who = upA && !upB ? "Goal for " + A + ". " : upB && !upA ? "Goal for " + B + ". " : upA && upB ? "Goals. " : "Score changed. ";
        msgs.push(`${who}${A} ${m.score.a}, ${B} ${m.score.b}.`);
        S.flash.add(m.id);
      } else if (m.state === "DONE" && p.state !== "DONE" && m.winner) msgs.push(resultWords(next, m) + ".");
      // staff can change a result afterwards (RESULT_CHANGED)
      else if (m.state === "DONE" && p.state === "DONE" && m.winner && p.winner && m.winner !== p.winner) {
        msgs.push(`Result changed: ${teamName(next, m.winner)} go through instead of ${teamName(next, p.winner)}.`);
      }
    }
    if (next.state === "RUNNING" && prev.state === "SIGNUP") msgs.push("The bracket is drawn.");
    if (next.state === "FINISHED" && prev.state !== "FINISHED") {
      const c = next.byId.get(next.champion);
      if (c) msgs.push(`${c.name} won ${next.name}.`);
    }
    if (next.state === "CANCELLED" && prev.state !== "CANCELLED") msgs.push(`${next.name} was called off.`);
    if (msgs.length) announce(msgs.slice(0, 4).join(" "));
  }

  async function refresh(manual) {
    clearTimeout(S.timer);
    if (S.busy) return;
    if (!API) { S.kind = "setup"; draw(); return; }
    if (routeId !== null && !CUP_RE.test(routeId)) {
      S.kind = "missing";
      if (S.list === null) { try { S.list = arr(obj((await get("/tournaments")).body).items); } catch { S.list = []; } }
      draw();
      return;
    }
    S.busy = true;
    S.lastPoll = Date.now();
    if (manual) view.setAttribute("aria-busy", "true");
    try {
      let kind = "none", T = null, live = false, stale = false;
      S.none404 = false;
      try {
        let res = null;
        if (routeId) res = await get("/tournaments/" + routeId);
        else res = (S.first && await fromSite()) || await get("/tournaments/current");
        stale = res.stale;
        if (routeId) { T = norm(res.body); kind = "cup"; }
        else {
          live = res.body.live === true;
          const t = res.body.tournament;
          if (t && typeof t === "object" && !Array.isArray(t)) { T = norm(t); kind = "cup"; }
        }
        S.fails = 0;
      } catch (e) {
        if (e && e.kind === "notfound") { kind = routeId ? "missing" : "none"; S.none404 = !routeId; S.fails = 0; }
        else {
          S.fails++;
          // keep showing what we had, marked as possibly out of date
          if (S.T) { kind = S.kind; T = S.T; live = S.live; stale = true; } else kind = "down";
        }
      }

      // the list of cups: once, then again whenever the cup on show opens,
      // starts, ends or changes
      const listKey = kind + "|" + (T ? T.id + ":" + T.state : "");
      if (kind !== "down" && (S.list === null || S.listKey !== listKey)) {
        S.listKey = listKey;
        try { S.list = arr(obj((await get("/tournaments")).body).items); } catch { if (S.list === null) S.list = []; }
      }

      if (!S.first && T && S.T) tellChanges(S.T, T);
      S.kind = kind; S.T = T; S.live = live; S.stale = stale;
      draw();
    } finally {
      S.busy = false;
      view.removeAttribute("aria-busy");
      schedule();
    }
  }

  // every 5 s while a match is live, every 30 s otherwise, never while the
  // tab is hidden; a finished or cancelled cup by id never changes again
  function every() {
    if (!API || S.kind === "setup" || S.kind === "missing") return 0;
    if (S.fails) return Math.min(60000, 10000 * 2 ** Math.min(3, S.fails - 1));
    if (routeId && S.T && (S.T.state === "FINISHED" || S.T.state === "CANCELLED")) return 0;
    if (S.kind === "none" && S.none404) return 60000;
    return anyLive(S.T) ? 5000 : 30000;
  }
  function schedule() {
    clearTimeout(S.timer);
    const ms = every();
    if (!ms || document.hidden) return;
    S.timer = setTimeout(() => refresh(), Math.max(0, ms - (Date.now() - S.lastPoll)));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(S.timer);
    else schedule();
  });
  window.addEventListener("online", () => { if (S.fails) refresh(); });

  // a new width can call for the other board; the same one just refits
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const grid = S.kind === "cup" ? gridOf(S.T) : null;
      if (grid && layoutFor(grid.length) !== S.layout) draw(true);
      else { const sc = $("[data-cup-scroll]", view); if (sc && sc._fit) sc._fit(); }
    }, 150);
  });

  // point at a team and its path through the cup lights up (mouse only;
  // every row also says its team in words)
  function applyHl() {
    $$(".is-hl", view).forEach((x) => x.classList.remove("is-hl"));
    view.classList.toggle("has-hl", !!S.hl);
    if (S.hl) $$(`[data-team="${CSS.escape(S.hl)}"]`, view).forEach((x) => x.classList.add("is-hl"));
  }
  view.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest && e.target.closest("[data-team]");
    const id = el ? el.dataset.team : "";
    if (id !== S.hl) { S.hl = id; applyHl(); }
  });
  view.addEventListener("pointerleave", () => { if (S.hl) { S.hl = ""; applyHl(); } });

  refresh();
})();
