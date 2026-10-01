/* ==================================================================
   MCS — crate odds (/crates/)

   Reads GET /api/v1/crates (docs/wallet.md, the crates contract) through
   the same HTTPS proxy as match history (`matchesApi` in site.config.js).
   Public by rule: every crate, every item in it and its exact chance.

   Every number on the page is the game server's own. A chance is printed
   as the API's percent string ("12.50" becomes "12.50%"), never worked out
   or rounded here; its bar is that same string as a CSS width. Weights
   add up to exactly 10000 per crate on the server, which refuses to
   publish a crate that doesn't, so the strings are exact.

   No answer (a 404 before crates exist, an error, or no API set) never
   shows made-up odds: the page says they'll be listed before crates open.
   ================================================================== */

(function () {
  "use strict";

  const main = document.querySelector("[data-crates]");
  if (!main) return;

  const CFG = window.MCS || {};
  const $ = (s, r) => (r || document).querySelector(s);

  const view = $("[data-crates-view]");
  const body = $("[data-crates-body]");
  const rules = $("[data-crates-rules]");
  const dupesBox = $("[data-crates-dupes]");
  const pityBox = $("[data-crates-pity]");
  const soonNote = $("[data-crates-soon]");
  const staleNote = $("[data-crates-stale]");
  const jump = $("[data-crate-jump]");
  const rulesLink = $("[data-rules-link]");
  const statusEl = $("[data-crates-status]");
  const listTitle = $("#crates-title");

  /* ── what the data looks like ──────────────────────────────────── */

  // the in-game order and names (Rarity.java). tier drives the pips.
  const RARITY = {
    COMMON:    { label: "Common",    tier: 1 },
    UNCOMMON:  { label: "Uncommon",  tier: 2 },
    RARE:      { label: "Rare",      tier: 3 },
    EPIC:      { label: "Epic",      tier: 4 },
    LEGENDARY: { label: "Legendary", tier: 5 },
  };
  const ORDER = Object.keys(RARITY);
  const TYPES = { trail: "Trail", celebration: "Celebration", bow: "Bow skin", hat: "Hat", title: "Title" };
  // a chance as the game server writes it: "12.50", "0.25", "100.00"
  const PCT = /^(?:100(?:\.0{1,4})?|\d{1,2}(?:\.\d{1,4})?)$/;

  const str = (v) => (typeof v === "string" ? v : "");
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const count = (n) => Number(n).toLocaleString("en");

  // Build DOM. Strings always become text, never markup. `html` is only
  // ever given the constant pixel art below.
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

  /* the crate: 16x16 pixel art, oak with iron corners and a Sapphire clasp
     (the same drawing as the hero's) */
  const CRATE =
    '<svg class="px" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill="#140c06" d="M2 2h12v1H2zM1 3h1v11H1zM14 3h1v11h-1zM2 14h12v1H2zM2 7h12v1H2z"/>' +
    '<path fill="#c4843f" d="M2 3h12v1H2zM2 8h12v1H2z"/><path fill="#9a622b" d="M2 4h12v2H2zM2 9h12v4H2z"/>' +
    '<path fill="#4d2d11" d="M2 13h12v1H2z"/><path fill="#6e421b" d="M2 6h12v1H2zM5 4h1v2H5zM10 4h1v2h-1zM5 8h1v5H5zM10 8h1v5h-1z"/>' +
    '<path fill="#8e9c95" d="M2 3h2v2H2zM12 3h2v2h-2zM2 12h2v2H2zM12 12h2v2h-2z"/><path fill="#c9d4ce" d="M2 3h1v1H2zM12 3h1v1h-1zM2 12h1v1H2zM12 12h1v1h-1z"/>' +
    '<path fill="#56635c" d="M3 4h1v1H3zM13 4h1v1h-1zM3 13h1v1H3zM13 13h1v1h-1z"/><path fill="#2a3ca6" d="M7 5h2v1H7z"/>' +
    '<path fill="#e2f6ff" d="M7 6h1v1H7z"/><path fill="#72c6ff" d="M8 6h1v1H8zM7 7h1v1H7z"/><path fill="#2f7ceb" d="M8 7h1v1H8zM7 8h1v1H7z"/>' +
    '<path fill="#1b2a8f" d="M8 8h1v1H8zM7 9h2v1H7z"/></svg>';
  const crateArt = (cls) => h("span", { class: "cr-box" + (cls ? " " + cls : ""), "aria-hidden": "true", html: CRATE });

  // images live beside this script, whatever page loaded it
  const IMG = (() => {
    const me = document.currentScript && document.currentScript.src;
    try { return new URL("../img/store/", me || location.href).href; } catch { return "/assets/img/store/"; }
  })();

  /* ── the API ───────────────────────────────────────────────────── */

  // matchesApi, or on localhost ?api=http://localhost:PORT (kept for the
  // tab, shared with /matches/ and /cup/). Ignored on the real site, so
  // nobody can dress other numbers up as ours.
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
        console.warn("[crates] matchesApi must be an https:// address on an https:// site:", base);
        return "";
      }
      return u.href.replace(/[?#].*$/, "").replace(/\/+$/, "");
    } catch { return ""; }
  })();

  class ApiError extends Error {
    constructor(kind, status) { super(kind); this.kind = kind; this.status = status || 0; }
  }

  // GET /api/v1/crates: { body, stale }. Retries the API's "try again"
  // answers a couple of times: 503 busy, or a 200 that says loading.
  async function get() {
    const url = API + "/api/v1/crates";
    for (let attempt = 0; ; attempt++) {
      let res, data = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      try {
        // no custom headers: they would need a CORS preflight
        res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
        data = await res.json().catch(() => null);
      } catch {
        clearTimeout(timer);
        throw new ApiError("offline");
      }
      clearTimeout(timer);
      if (res.status === 503 && attempt < 2) { await sleep(2000); continue; }
      if (res.status === 404) throw new ApiError("notfound", 404);
      if (!res.ok || !data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("server", res.status);
      if (data.loading === true) {
        if (attempt < 2) { await sleep(2000); continue; }
        throw new ApiError("loading");
      }
      return { data, stale: (res.headers.get("X-MCS-Cache") || "").toUpperCase() === "STALE" };
    }
  }

  /* ── the model: only what the answer holds ─────────────────────── */

  function rarityOf(v) {
    const raw = str(v).trim();
    const k = raw.toUpperCase();
    if (RARITY[k]) return { key: k.toLowerCase(), label: RARITY[k].label, tier: RARITY[k].tier, rank: ORDER.indexOf(k) };
    // a rarity added after this page: its own name, drawn plain, listed last
    return raw ? { key: "", label: cap(raw.toLowerCase().replace(/[_-]+/g, " ")), tier: 0, rank: ORDER.length } : null;
  }

  function typeOf(v) {
    const t = str(v).trim().toLowerCase();
    if (!t) return "";
    return TYPES[t] || cap(t.replace(/[_-]+/g, " "));
  }

  // one item, or null when its chance can't be read exactly as sent
  function itemOf(x) {
    x = obj(x);
    const name = str(x.name).trim();
    const pct = str(x.percent).trim().replace(/%$/, "");
    if (!name || !PCT.test(pct)) return null;
    return { name, type: typeOf(x.type), rarity: rarityOf(x.rarity), pct };
  }

  function crateOf(x, i) {
    x = obj(x);
    const id = str(x.id).toLowerCase().replace(/[^a-z0-9_-]+/g, "") || String(i + 1);
    const raw = arr(x.items);
    const items = raw.map(itemOf);
    const ok = raw.length > 0 && items.every(Boolean);
    const name = str(x.name).trim() || cap(id.replace(/[_-]+/g, " ")) + " Crate";
    // common first, as the game lists rarities; the server's order within one
    const sorted = ok ? items.map((it, n) => ({ it, n }))
      .sort((a, b) => ((a.it.rarity ? a.it.rarity.rank : 99) - (b.it.rarity ? b.it.rarity.rank : 99)) || a.n - b.n)
      .map((o) => o.it) : [];
    // a short theme line under the name ("Petals, rainbows and light"), when the server has one
    const blurb = typeof x.blurb === "string" ? x.blurb.trim().slice(0, 120) : "";
    return { id, name, blurb, items: sorted, broken: !ok };
  }

  /* ── small pieces ──────────────────────────────────────────────── */

  // the rarity badge: its colour, five pips filled to its tier, its name.
  // Colour is never the only sign: the name is always written out.
  function rarityChip(r) {
    if (!r) return h("span", { class: "cr-rar is-plain" }, "Not listed");
    const pips = h("span", { class: "cr-pips", "aria-hidden": "true" });
    if (r.tier) for (let n = 1; n <= 5; n++) pips.append(h("i", { class: n <= r.tier ? "on" : null }));
    return h("span", { class: "cr-rar " + (r.key ? "r-" + r.key : "is-plain") }, r.tier ? pips : null, r.label);
  }

  function gemGlyph() {
    return h("img", { class: "cr-gem", src: IMG + "glyph.png", width: 18, height: 18, alt: "" });
  }

  function say(msg) {
    if (!statusEl) return;
    statusEl.textContent = "";
    // emptied first, so the same message twice is still read out
    setTimeout(() => { statusEl.textContent = msg; }, 60);
  }

  /* ── a crate ───────────────────────────────────────────────────── */

  function crateSection(c, i, priceLine) {
    const sid = "crate-" + c.id;
    const nid = sid + "-name";

    const head = h("header", { class: "cr-head" },
      crateArt(),
      h("div", { class: "cr-head-text" },
        h("h3", { class: "cr-name", id: nid }, c.name),
        c.blurb ? h("p", { class: "cr-blurb" }, c.blurb) : null,
        priceLine ? h("p", { class: "cr-price" }, gemGlyph(), priceLine) : null),
      c.broken ? null : h("p", { class: "cr-count" }, c.items.length === 1 ? "1 item" : c.items.length + " items"));

    const sec = h("section", { class: "cr-crate st-rise", id: sid, "aria-labelledby": nid, style: { "--i": i } }, head);

    if (c.broken) {
      sec.append(h("p", { class: "cr-broken" }, "This crate's odds couldn't be read right now, so none are shown. Check back soon."));
      return sec;
    }

    // a real table, with its roles spelled out: on phones the rows are
    // laid out as cards, and some browsers drop a table's meaning once
    // its display changes
    const cols = [["Item", "cr-c-name"], ["Type", "cr-c-type"], ["Rarity", "cr-c-rar"], ["Chance", "cr-c-pct"]];
    const table = h("table", { class: "cr-table", role: "table" },
      h("caption", { class: "visually-hidden" }, c.name + ": every item, its type, its rarity and its chance"),
      h("thead", { role: "rowgroup" },
        h("tr", { role: "row" }, cols.map(([t, cls]) => h("th", { scope: "col", role: "columnheader", class: cls }, t)))),
      h("tbody", { role: "rowgroup" }, c.items.map((it) =>
        h("tr", { role: "row", class: "cr-row" + (it.rarity && it.rarity.key ? " r-" + it.rarity.key : "") },
          h("th", { scope: "row", role: "rowheader", class: "cr-c-name" }, it.name),
          h("td", { role: "cell", class: "cr-c-type" }, it.type || "Not listed"),
          h("td", { role: "cell", class: "cr-c-rar" }, rarityChip(it.rarity)),
          h("td", { role: "cell", class: "cr-c-pct" },
            // the bar is the API's own string as a width: nothing computed
            h("span", { class: "cr-bar", "aria-hidden": "true" }, h("i", { style: { width: it.pct + "%" } })),
            h("b", null, it.pct + "%"))))));

    sec.append(h("div", { class: "cr-table-wrap" }, table));
    return sec;
  }

  /* ── duplicates and pity ───────────────────────────────────────── */

  function dupesTable(d, cur) {
    const src = obj(d.duplicates);
    const keys = ORDER.filter((k) => k in src).concat(Object.keys(src).filter((k) => !RARITY[k.toUpperCase()] && !ORDER.includes(k)));
    const rows = keys.filter((k) => Number.isInteger(src[k]) && src[k] >= 0);
    if (!rows.length) return h("p", { class: "cr-rules-none" }, "What duplicates give back couldn't be read right now.");
    return h("table", { class: "cr-dupes" },
      h("caption", { class: "visually-hidden" }, "Sapphires back for a duplicate, by rarity"),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Rarity"), h("th", { scope: "col" }, "You get back"))),
      h("tbody", null, rows.map((k) => {
        const r = rarityOf(k);
        return h("tr", { class: r && r.key ? "r-" + r.key : null },
          h("th", { scope: "row" }, rarityChip(r)),
          h("td", null, gemGlyph(), h("b", null, count(src[k])), " " + cur));
      })));
  }

  function pityBlock(d) {
    // the API leaves out null fields, so a missing pity means there is none
    const p = "pity" in d ? d.pity : null;
    let rule;
    if (p === null || p === undefined) {
      rule = [h("b", null, "None."), " Every opening uses the same odds."];
    } else {
      const o = obj(p);
      const r = rarityOf(o.guarantee);
      const n = Number.isInteger(o.within) && o.within > 0 ? o.within : 0;
      if (r && n) {
        const a = /^[aeiou]/i.test(r.label) ? "An " : "A ";
        rule = [h("b", null, a + r.label + " is guaranteed within " + count(n) + (n === 1 ? " opening." : " openings."))];
      } else {
        rule = [h("b", null, "A pity rule applies."), " See it in game with ", h("code", null, "/crates"), "."];
      }
    }
    return h("p", { class: "cr-pity-line" }, h("span", { class: "cr-pity-k" }, "Pity"), h("span", null, rule));
  }

  /* ── drawing ───────────────────────────────────────────────────── */

  let firstDraw = true;

  function render(d, stale, refocus) {
    const crates = arr(d.crates).map(crateOf);
    if (!crates.length) return renderOff(refocus);

    const price = Number.isInteger(d.price) && d.price > 0 ? d.price : 0;
    const cur = str(d.currency).trim() || "Sapphires";
    const priceLine = price ? count(price) + " " + cur + ", earned or bought" : "";

    view.replaceChildren(...crates.map((c, i) => crateSection(c, i, priceLine)));
    view.classList.add("is-ready");

    // duplicates and pity
    dupesBox.replaceChildren(dupesTable(d, cur));
    const pity = pityBlock(d);
    pityBox.replaceChildren();
    if (pity) pityBox.append(pity);
    pityBox.hidden = !pity;
    rules.hidden = false;
    if (rulesLink) rulesLink.hidden = false;
    body.classList.remove("is-solo");

    soonNote.hidden = d.enabled !== false;
    staleNote.hidden = !stale;

    // quick links to each crate, when there's more than one
    if (jump) {
      jump.replaceChildren(...(crates.length > 1 ? crates.map((c) =>
        h("a", { class: "cr-jump-chip", href: "#crate-" + c.id }, crateArt("is-sm"), c.name)) : []));
      jump.hidden = crates.length < 2;
    }

    say(crates.length === 1 ? "The odds for 1 crate are listed." : "The odds for " + crates.length + " crates are listed.");
    if (refocus) refocusOn(listTitle);

    // a link to one crate (#crate-storm) lands on it once it's drawn
    if (firstDraw && location.hash) {
      let t = null;
      try { t = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch {}
      if (t && main.contains(t)) requestAnimationFrame(() => t.scrollIntoView());
    }
    firstDraw = false;
  }

  function stateCard(kind, title, text, action) {
    return h("div", { class: "st-state cr-state is-" + kind },
      crateArt("cr-state-art"), h("h3", null, title), h("p", null, text), action || null);
  }

  function clearData() {
    rules.hidden = true;
    if (rulesLink) rulesLink.hidden = true;
    body.classList.add("is-solo");
    soonNote.hidden = true;
    staleNote.hidden = true;
    if (jump) { jump.hidden = true; jump.replaceChildren(); }
  }

  // no crates yet (404, an empty list, or no API set): no numbers at all
  function renderOff(refocus) {
    clearData();
    view.replaceChildren(stateCard("off", "Crates are on their way", "Crate odds will be listed here before crates open."));
    say("Crate odds will be listed here before crates open.");
    if (refocus) refocusOn(listTitle);
  }

  function renderError(refocus) {
    clearData();
    const again = h("button", { class: "btn btn-dark", type: "button" }, "Try again");
    again.insertAdjacentHTML("beforeend", '<svg class="arrow" viewBox="0 0 10 17" aria-hidden="true"><path d="M0 0h2v2h2v2h2v2h2v2h2v1h-2v2H6v2H4v2H2v2H0z"/></svg>');
    again.addEventListener("click", () => {
      // the button is about to go: hold focus on the heading meanwhile
      if (listTitle) listTitle.focus();
      say("Loading the crate odds.");
      view.replaceChildren(skeleton());
      load(true);
    });
    view.replaceChildren(stateCard("error", "The odds didn't load",
      "Crate odds will be listed here before crates open. If crates are open already, try again in a minute.", again));
    say("The odds didn't load.");
    if (refocus) refocusOn(again);
  }

  // after a retry, unless the visitor has moved on to something else
  function refocusOn(target) {
    const a = document.activeElement;
    if (target && (!a || a === document.body || a === listTitle)) target.focus();
  }

  function skeleton() {
    const s = h("div", { class: "cr-sk", "aria-hidden": "true" });
    s.innerHTML = '<div class="cr-sk-crate"><i></i><b style="--w:34%"></b><b style="--w:22%"></b><span>' +
      '<b style="--w:92%"></b><b style="--w:88%"></b><b style="--w:94%"></b><b style="--w:86%"></b></span></div>';
    return s;
  }

  async function load(refocus) {
    view.setAttribute("aria-busy", "true");
    try {
      if (!API) return renderOff(refocus);
      const { data, stale } = await get();
      render(data, stale, refocus);
    } catch (err) {
      if (err && err.kind === "notfound") renderOff(refocus);
      else {
        console.warn("[crates] the odds didn't load:", err && err.kind, err && err.status);
        renderError(refocus);
      }
    } finally {
      view.setAttribute("aria-busy", "false");
    }
  }

  load(false);
})();
