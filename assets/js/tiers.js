/* ==================================================================
   MCS — the tier list (/tiers/)

   Reads the tier list's data (data.js, which declares TIER_DATA: tiers
   1 to 7, each with a colour and its High and Low players in order) and
   draws it the way the old tier list did: seven columns side by side,
   High over Low, one row per player. Search lights up the matches and
   dims the rest, so the board keeps its shape; High / Low hides the
   other band. A row opens that player's card; ?p=<name> opens it from a
   link. Where the data lives is site.config.js's tierData (the old tier
   list site until the admin dashboard takes it over).
   ================================================================== */

(function () {
  "use strict";

  const CFG = window.MCS || {};
  const root = document.querySelector("[data-tl]");
  if (!root) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const board = $("[data-tl-board]");
  const status = $("[data-tl-status]");
  const search = $("[data-tl-search]");
  const dlg = $("[data-tl-card]");
  const meta = $("[data-tl-meta]");

  const SRC = String(CFG.tierData || "https://tiers.mcsoccer.net/data.js");
  // this file's own URL finds the badges, whatever page loaded it
  const IMG = (() => {
    const me = document.currentScript && document.currentScript.src;
    try { return new URL("../img/tiers/", me || location.href).href; } catch { return "/assets/img/tiers/"; }
  })();
  const NAME = /^[A-Za-z0-9_]{1,16}$/;
  const ORD = ["1st", "2nd", "3rd"];
  const ord = (n) => ORD[n - 1] || n + "th";

  const badge = (tier, band) =>
    tier >= 1 && tier <= 7 ? `${IMG}${band === "low" ? "lt" : "ht"}${tier}.png` : `${IMG}no-tier.png`;
  const bandWord = (band) => (band === "low" ? "Low" : "High");
  const short = (tier, band) => (band === "low" ? "LT" : "HT") + tier;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  }

  /* a head, from mc-heads.net, or minotar.net if that fails */
  function head(name, size, px) {
    const img = el("img", { src: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`, width: px, height: px, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { img.src = `https://minotar.net/helm/${encodeURIComponent(name)}/${size}`; }, { once: true });
    return img;
  }

  const say = (text) => { if (status) status.textContent = text; };

  /* ── load ─────────────────────────────────────────────────────── */

  let players = [];

  function load() {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => {
      // data.js declares a global `const TIER_DATA`: reachable by name, not on window
      let data = null;
      try { data = typeof TIER_DATA !== "undefined" ? TIER_DATA : null; } catch {}
      if (!data || !Array.isArray(data.tiers) || !data.tiers.length) return fail();
      render(data);
    };
    s.onerror = fail;
    document.head.appendChild(s);
  }

  function fail() {
    board.removeAttribute("aria-busy");
    board.replaceChildren(el("div", { class: "tl-state" },
      el("h2", null, "The tier list couldn't be reached"),
      el("p", null, "Check your connection, then try again."),
      el("button", { class: "btn", type: "button", "data-tl-retry": true }, "Try again")));
    $("[data-tl-retry]", board).addEventListener("click", () => location.reload());
    say("The tier list couldn't be reached.");
  }

  /* ── draw: one column per tier ────────────────────────────────── */

  let cols = null;

  function render(data) {
    players = [];
    const tiers = data.tiers
      .filter((t) => t && Number.isFinite(Number(t.tier)))
      .slice()
      .sort((a, b) => Number(a.tier) - Number(b.tier));

    const columns = tiers.map((t, i) => {
      const tier = Number(t.tier);
      const color = /^#[0-9a-f]{3,8}$/i.test(String(t.color || "")) ? t.color : null;
      let count = 0;
      const bands = ["high", "low"].map((band) => {
        const names = (Array.isArray(t[band]) ? t[band] : []).map(String).filter((n) => n.trim());
        count += names.length;
        const rows = names.map((name, k) => {
          const p = { name, tier, band, pos: k + 1, of: names.length, color };
          players.push(p);
          p.row = el("button", { class: "tl-row", type: "button", "data-p": players.length - 1, title: name, "aria-label": `${name}, ${bandWord(band)} Tier ${tier}` },
            head(name, 64, 32), el("span", null, name));
          return el("li", null, p.row);
        });
        return el("section", { class: `tl-band is-${band}`, "aria-label": `${bandWord(band)} Tier ${tier}` },
          el("h3", { class: "tl-band-tag" }, el("img", { src: badge(tier, band), width: 22, height: 22, alt: "" }), short(tier, band)),
          rows.length ? el("ul", { class: "tl-rows" }, rows) : el("p", { class: "tl-none" }, "—"));
      });
      return el("section", { class: "tl-col", style: `--i:${i}${color ? `;--tc:${color}` : ""}`, "data-tier": tier, "aria-labelledby": `tl-t${tier}` },
        el("header", { class: "tl-col-head" },
          el("img", { src: badge(tier, "high"), width: 33, height: 33, alt: "" }),
          el("h2", { id: `tl-t${tier}` }, `Tier ${tier}`),
          el("small", null, String(count))),
        el("div", { class: "tl-col-body" }, bands));
    });

    cols = el("div", { class: "tl-cols", style: `--n:${tiers.length}` }, columns);
    board.replaceChildren(cols);
    board.removeAttribute("aria-busy");

    if (meta) {
      $("[data-tl-count]", meta).textContent = players.length;
      $("[data-tl-tiers]", meta).textContent = tiers.length;
      const up = data.meta && data.meta.updated;
      const upWrap = $("[data-tl-updated-wrap]", meta);
      if (up && upWrap) {
        const d = new Date(String(up) + "T12:00:00");
        $("[data-tl-updated]", meta).textContent = isNaN(d) ? String(up) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
        upWrap.hidden = false;
      }
      meta.hidden = false;
    }
    say(`${players.length} players in ${tiers.length} tiers.`);

    // ?q= fills the search, ?p= opens a card
    const q = new URLSearchParams(location.search);
    if (q.get("q") && search) { search.value = q.get("q").slice(0, 16); filter(true); }
    const want = (q.get("p") || "").toLowerCase();
    const hit = want && players.find((p) => p.name.toLowerCase() === want);
    if (hit) open(hit, false);
  }

  /* ── search and High / Low ────────────────────────────────────── */

  let band = "all";
  let emptyNote = null;

  function filter(reveal) {
    if (!cols) return;
    const q = (search ? search.value : "").trim().toLowerCase();
    board.dataset.band = band;
    board.classList.toggle("is-searching", !!q);
    let hits = 0;
    let first = null;
    for (const p of players) {
      const inBand = band === "all" || band === p.band;
      const hit = !!q && inBand && p.name.toLowerCase().includes(q);
      p.row.classList.toggle("is-hit", hit);
      if (hit) { hits++; if (!first) first = p.row; }
    }
    // on a narrow screen the matching column may be off to the side
    if (first && reveal !== false) first.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });

    if (emptyNote) { emptyNote.remove(); emptyNote = null; }
    if (q && !hits) {
      const name = search.value.trim();
      emptyNote = el("div", { class: "tl-state" },
        el("h2", null, `Nobody called "${name}" is on the tier list`),
        el("p", null, "They might not be tested yet. ",
          NAME.test(name) ? el("a", { href: `../matches/?tab=players&q=${encodeURIComponent(name)}` }, "Find them in match history") : null));
      board.prepend(emptyNote);
    }
    if (players.length) say(q ? (hits === 1 ? "1 player found." : `${hits} players found.`) : band === "all" ? `${players.length} players in all.` : `${bandWord(band)} tiers only.`);
  }

  if (search) {
    search.addEventListener("input", () => filter(true));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && search.value) { search.value = ""; filter(false); e.stopPropagation(); }
      // Enter opens the first match
      if (e.key === "Enter") {
        const first = players.find((p) => p.row.classList.contains("is-hit"));
        if (first) { e.preventDefault(); open(first, true); }
      }
    });
    // "/" jumps to the search, as on the old tier list
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (dlg && dlg.open) return;
      e.preventDefault();
      search.focus();
      search.select();
    });
  }

  $$("[data-tl-band]").forEach((b) => b.addEventListener("click", () => {
    band = b.dataset.tlBand;
    $$("[data-tl-band]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    filter(false);
  }));

  /* ── a player's card ──────────────────────────────────────────── */

  let opener = null;

  function open(p, fromClick) {
    if (!dlg) return;
    opener = fromClick ? document.activeElement : null;
    if (p.color) dlg.style.setProperty("--tc", p.color); else dlg.style.removeProperty("--tc");
    const body = $("[data-tl-body]", dlg);
    body.src = `https://mc-heads.net/body/${encodeURIComponent(p.name)}/224`;
    body.onerror = () => { body.onerror = null; body.src = `https://minotar.net/armor/body/${encodeURIComponent(p.name)}/224`; };
    $("[data-tl-badge]", dlg).src = badge(p.tier, p.band);
    $("[data-tl-tier]", dlg).textContent = `${bandWord(p.band)} Tier ${p.tier}`;
    $("[data-tl-name]", dlg).textContent = p.name;
    $("[data-tl-place]", dlg).textContent = p.of > 1 ? `${ord(p.pos)} of ${p.of} in ${short(p.tier, p.band)}` : `The only ${short(p.tier, p.band)}`;
    $("[data-tl-stats]", dlg).href = `../matches/?tab=players&q=${encodeURIComponent(p.name)}`;
    $("[data-tl-namemc]", dlg).href = `https://namemc.com/profile/${encodeURIComponent(p.name)}`;
    if (!dlg.open) dlg.showModal();
    try {
      const u = new URL(location.href);
      u.searchParams.set("p", p.name);
      history.replaceState(history.state, "", u);
    } catch {}
  }

  function closed() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete("p");
      history.replaceState(history.state, "", u);
    } catch {}
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  board.addEventListener("click", (e) => {
    const b = e.target.closest(".tl-row");
    if (b) open(players[Number(b.dataset.p)], true);
  });
  if (dlg) {
    dlg.addEventListener("close", closed);
    $("[data-tl-close]", dlg).addEventListener("click", () => dlg.close());
    // a click on the backdrop (the dialog itself, outside its box) closes it
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }

  load();
})();
