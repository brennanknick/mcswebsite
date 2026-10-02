/* ==================================================================
   MCS — the Sapphire store (/store/ and /store/thanks/)

   Talks to PayNow's Storefront API straight from the browser: no server,
   no API key (only the public store id). Three calls, per PayNow's docs:
     GET  /v1/store/products?tag=sapphires   the bundles, priced for this
                                             buyer (currency and tax)
     POST /v1/store/customer/auth            username -> customer token
     POST /v1/checkouts                      token -> PayNow checkout URL
   The token lives in one function's variables for one click, never in
   storage. A checkout is only created when someone presses the button.

   Loaded in <head> after site.config.js, so the page is marked on / off /
   not open before it paints; the rest waits for the DOM.
   ================================================================== */

(function () {
  "use strict";

  const CFG = window.MCS || {};
  const html = document.documentElement;
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
  const LOCAL = LOCAL_HOST.test(location.hostname);
  const API_DEFAULT = "https://api.paynow.gg/v1";
  // PayNow's public demo store: fine to read, never to buy from (a sign-in
  // or checkout there would create records in someone else's store)
  const DEMO_STORE = "435814599317528576";
  const NAME = /^[A-Za-z0-9_]{3,16}$/;

  /* ── config, and the localhost-only test overrides ─────────────────
     ?paynowApi=http://localhost:PORT, ?paynowStore=<id>, ?paynowTag=<slug>
     last for the tab (like ?api= on /matches/). "off" clears one. */

  function override(param, key) {
    if (!LOCAL) return "";
    let q = null;
    try { q = new URLSearchParams(location.search).get(param); } catch {}
    try {
      if (q !== null) {
        q = q.trim();
        if (q && q !== "off") sessionStorage.setItem(key, q);
        else sessionStorage.removeItem(key);
      }
      return sessionStorage.getItem(key) || "";
    } catch { return q && q !== "off" ? q : ""; }
  }

  const STORE_ID = (override("paynowStore", "pn-store") || String(CFG.paynowStoreId || "")).trim();
  const TAG = override("paynowTag", "pn-tag") || "sapphires";
  const API = (() => {
    const o = override("paynowApi", "pn-api");
    if (!o) return API_DEFAULT;
    try {
      const u = new URL(o);
      if (!/^https?:$/.test(u.protocol)) return API_DEFAULT;
      const b = u.href.replace(/[?#].*$/, "").replace(/\/+$/, "");
      return /\/v1$/.test(b) ? b : b + "/v1";
    } catch { return API_DEFAULT; }
  })();
  const IS_DEMO = STORE_ID === DEMO_STORE;

  html.dataset.store = STORE_ID ? "on" : "off";
  // warm up the connection only when there's a store to ask
  if (STORE_ID && document.currentScript && document.currentScript.dataset.page === "store") {
    try {
      const l = document.createElement("link");
      l.rel = "preconnect";
      l.href = new URL(API).origin;
      l.crossOrigin = "";
      document.head.appendChild(l);
    } catch {}
  }
  html.dataset.storeOpen = CFG.storeOpen === true ? "1" : "0";
  if (IS_DEMO) html.dataset.storeDemo = "1";

  /* ── the bundles we know. Prices never come from here: always from
     PayNow, which localises price and tax for each buyer. This only adds
     the card name and the honest base + bonus split. ── */

  const KNOWN = {
    "sapphires-300":     { name: "Top Up",       base: 300,   bonus: 0,    pile: 1 },
    "sapphires-500":     { name: "Pouch",        base: 500,   bonus: 0,    pile: 2 },
    "sapphires-1050":    { name: "Bag",          base: 1000,  bonus: 50,   pile: 3, popular: true },
    "sapphires-2200":    { name: "Chest",        base: 2000,  bonus: 200,  pile: 4 },
    "sapphires-3450":    { name: "Vault",        base: 3000,  bonus: 450,  pile: 5 },
    "sapphires-6000":    { name: "Treasury",     base: 5000,  bonus: 1000, pile: 6 },
    "sapphires-9500":    { name: "Hoard",        base: 7500,  bonus: 2000, pile: 8 },
    "sapphires-13000":   { name: "Crown Jewels", base: 10000, bonus: 3000, pile: 10 },
    "sapphires-starter": { name: "Starter Pack", base: 500,   bonus: 100,  pile: "starter", starter: true },
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  // one number format for the whole page, the page's own language: counts,
  // prices and "£5 off" never mix "1,050" with "9,99 $". The currency
  // code still picks the right symbol (£7.99, €7.99, CA$9.99).
  const LOCALE = (() => {
    const l = html.lang || "en";
    try { return Intl.NumberFormat.supportedLocalesOf(l).length ? l : "en"; } catch { return "en"; }
  })();
  const num = (n) => Number(n).toLocaleString(LOCALE);
  const IMG = (() => {
    // this file's own URL finds the images, whatever page loaded it
    const me = document.currentScript && document.currentScript.src;
    try { return new URL("../img/store/", me || location.href).href; } catch { return "/assets/img/store/"; }
  })();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const ARROW = '<svg class="arrow" viewBox="0 0 10 17" aria-hidden="true"><path d="M0 0h2v2h2v2h2v2h2v2h2v1h-2v2H6v2H4v2H2v2H0z"/></svg>';

  /* ── money: PayNow sends integer minor units and a lowercase code ── */

  function money(minor, cur) {
    const code = String(cur || "usd").toUpperCase();
    try {
      const f = new Intl.NumberFormat(LOCALE, { style: "currency", currency: code });
      const digits = f.resolvedOptions().maximumFractionDigits;
      return f.format(Number(minor) / 10 ** digits);
    } catch {
      return (Number(minor) / 100).toFixed(2) + " " + code;
    }
  }

  /* ── one call to PayNow ──────────────────────────────────────────── */

  async function pn(path, opts) {
    const { token, body, signal, timeout = 20000 } = opts || {};
    const fail = (kind) => Object.assign(new Error(kind), { kind });
    // closed before it started: nothing goes out
    if (signal && signal.aborted) throw fail("abort");
    const headers = { "x-paynow-store-id": STORE_ID, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Customer " + token;

    // The timer and the caller's cancel cover the whole reply, body included:
    // fetch() resolves on the headers, and a body can still stall after them.
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    if (signal) signal.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
    const why = () => (timedOut ? "timeout" : signal && signal.aborted ? "abort" : "network");

    try {
      let res;
      try {
        res = await fetch(API + path, {
          method: body ? "POST" : "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: ctl.signal,
          credentials: "omit",
        });
      } catch {
        // a CORS refusal and a dropped connection look the same from here
        throw fail(why());
      }
      let data = null;
      if (res.status !== 204) {
        try { data = await res.json(); }
        catch { if (ctl.signal.aborted) throw fail(why()); }
      }
      if (!res.ok) {
        const msg = data && typeof data.message === "string" ? data.message : String(res.status);
        throw Object.assign(new Error(msg), { kind: "http", status: res.status, data });
      }
      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", stop);
    }
  }

  /* ── the page ───────────────────────────────────────────────────── */

  document.addEventListener("DOMContentLoaded", () => {
    fillSupport();
    const box = $("[data-catalog]");
    if (box && STORE_ID) {
      loadCatalog(box);
      setupBuy();
    }
  });

  /* contact: the support email, or the Discord until there is one */
  function fillSupport() {
    const email = String(CFG.supportEmail || "").trim();
    const okEmail = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email);
    const invite = String(CFG.discordInvite || "").trim();
    $$("[data-support-line]").forEach((line) => {
      const cap = line.hasAttribute("data-cap");
      const a = el("a");
      let lead;
      if (okEmail) {
        lead = "email ";
        a.href = "mailto:" + email;
        a.textContent = email;
      } else {
        lead = "ask us on ";
        a.href = invite || (line.closest("[data-thanks]") ? "../../#discord" : "../#discord");
        a.textContent = "Discord";
        if (invite) { a.target = "_blank"; a.rel = "noopener"; }
      }
      if (cap) lead = lead[0].toUpperCase() + lead.slice(1);
      line.replaceChildren(document.createTextNode(lead), a);
    });
  }

  /* ── the catalog ─────────────────────────────────────────────────── */

  let products = [];
  // the store's own (base) currency, from GET /v1/store: the one a product's
  // `price` is in. Only used to tell whether a price already includes tax.
  let baseCurrency = "";

  // "Bundles loaded", or what went wrong, for screen readers. The region sits
  // outside the catalog box, which every render empties.
  function sayCatalog(msg) {
    const r = $("[data-catalog-status]");
    if (!r) return;
    r.textContent = "";
    // emptied first, so the same message twice in a row is still read out
    setTimeout(() => { r.textContent = msg; }, 60);
  }

  // refocus: true after "Try again", which removed the focused button; focus
  // then lands on the result. The first load never moves focus.
  async function loadCatalog(box, refocus) {
    box.setAttribute("aria-busy", "true");
    box.classList.remove("is-ready");
    const wait = $("[data-catalog-wait]", box);
    const waitTimer = setTimeout(() => { if (wait) wait.hidden = false; }, 4000);
    // alongside the bundles, never holding them up for long: if it's late,
    // this render makes no tax claim it can't back, and a later one can
    const storeInfo = baseCurrency ? null : pn("/store", { timeout: 8000 })
      .then((info) => {
        if (info && typeof info.creator_currency === "string") baseCurrency = info.creator_currency.toLowerCase();
      })
      .catch(() => {});
    try {
      const list = await pn("/store/products?tag=" + encodeURIComponent(TAG), { timeout: 15000 });
      if (storeInfo) await Promise.race([storeInfo, new Promise((r) => setTimeout(r, 2500))]);
      products = (Array.isArray(list) ? list : []).filter(usable);
      render(box, refocus);
    } catch (err) {
      if (LOCAL || err.status === 404) console.warn("MCS store: the catalog didn't load", err.kind, err.status || "", err.data || "");
      renderError(box, err, refocus);
    } finally {
      clearTimeout(waitTimer);
      box.setAttribute("aria-busy", "false");
    }
  }

  // only well-formed, visible products with a price
  function usable(p) {
    return p && typeof p === "object" && typeof p.id === "string" && p.id &&
      !p.hidden && p.pricing && Number.isFinite(p.pricing.price_final) && typeof p.currency === "string";
  }

  function order(a, b) {
    const sa = Number.isFinite(a.sort_order) ? a.sort_order : 1e9;
    const sb = Number.isFinite(b.sort_order) ? b.sort_order : 1e9;
    if (sa !== sb) return sa - sb;
    const pa = Number.isFinite(a.pricing.price_original) ? a.pricing.price_original : a.pricing.price_final;
    const pb = Number.isFinite(b.pricing.price_original) ? b.pricing.price_original : b.pricing.price_final;
    return pa - pb;
  }

  function render(box, refocus) {
    const list = products.slice().sort(order);
    box.replaceChildren();
    if (refocus) {
      sayCatalog(list.length ? "Bundles loaded." : "No bundles on sale right now.");
      refocusOn($("#bundles-title"));
    }
    if (!list.length) {
      box.append(stateCard("empty", "No bundles on sale right now",
        "Check back soon. The Discord hears first when something changes."));
      return;
    }
    const starter = list.find((p) => KNOWN[p.slug] && KNOWN[p.slug].starter);
    const rest = list.filter((p) => p !== starter);
    let i = 0;
    if (starter) box.append(starterCard(starter, i++));
    if (rest.length) {
      const grid = el("ul", "st-grid");
      grid.setAttribute("role", "list");
      rest.forEach((p) => grid.append(card(p, i++)));
      box.append(grid);
    }
    box.classList.add("is-ready");
  }

  /* Tax. PayNow sends its estimate for the buyer's country (vat_rate), but
     whether the price already carries it depends on the store's
     tax-inclusive setting, which the storefront API doesn't expose. So
     "Includes" only when the reply proves it, "Plus ... at checkout" only
     when it proves the opposite, and nothing otherwise: the payments
     section ("PayNow, which shows any tax before you pay") covers that case.
       1. a regional price says so itself (tax_inclusive);
       2. in the store's own currency, price_original (before any sale, after
          the tax adjustment) above the base price means tax was added;
       3. otherwise the owner's setting, taxInclusive in site.config.js. */
  function taxLine(p) {
    const pr = p.pricing;
    const rate = pr.vat_rate && typeof pr.vat_rate === "object" ? Number(pr.vat_rate.percentage) : 0;
    if (!(rate > 0) || !Number.isFinite(rate)) return "";
    const name = String(pr.vat_rate.vat_abbreviation || "").trim() || "VAT";
    const rp = pr.regional_pricing;
    let inc = null;
    if (rp && typeof rp === "object" && typeof rp.tax_inclusive === "boolean") inc = rp.tax_inclusive;
    else if (baseCurrency && String(p.currency).toLowerCase() === baseCurrency &&
      Number.isFinite(pr.price_original) && Number.isFinite(p.price)) inc = pr.price_original > p.price;
    else if (typeof CFG.taxInclusive === "boolean") inc = CFG.taxInclusive;
    if (inc === true) return "Includes " + rate + "% " + name;
    if (inc === false) return "Plus " + rate + "% " + name + " at checkout";
    return "";
  }

  // how many Sapphires a product we don't know holds: its slug, then its name
  function guessAmount(p) {
    const s = /^sapphires-(\d+)$/.exec(String(p.slug || ""));
    const n = Number(s ? s[1] : (String(p.name || "").replace(/,/g, "").match(/\d+/) || [])[0]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // its heap: the one of the biggest known bundle it reaches, so a pack
  // bigger than the ladder never looks like the smallest
  function guessPile(n) {
    let pile = 0;
    for (const k of Object.values(KNOWN)) {
      if (!k.starter && k.base + k.bonus <= n && k.pile > pile) pile = k.pile;
    }
    return pile || 1;
  }

  function describe(p) {
    const k = KNOWN[p.slug] || null;
    const pr = p.pricing;
    // struck through whenever PayNow's final price is under its original;
    // the tag only when there's a named sale behind it
    const cut = Number.isFinite(pr.price_original) && pr.price_original > pr.price_final;
    const sale = cut && pr.active_sale && typeof pr.active_sale === "object" ? pr.active_sale : null;
    let off = "";
    if (sale && sale.discount_type === "percent" && Number.isFinite(sale.discount_amount)) off = Math.round(sale.discount_amount / 10) + "% off";
    // an amount off: the gap the buyer actually sees between the two prices,
    // in their currency (the sale's own amount is in the store's currency)
    else if (sale && sale.discount_type === "amount") off = money(pr.price_original - pr.price_final, p.currency) + " off";
    else if (sale) off = "Sale";
    const guess = k ? 0 : guessAmount(p);
    // a name that's just an amount ("20,000 Sapphires", as the brief names
    // them) can be drawn like a known bundle's amount; any other name shows
    // as it is
    const nm = k ? null : /^\s*(\d[\d,]*)\s+Sapphires?\s*$/i.exec(String(p.name || ""));
    return {
      k,
      total: k ? k.base + k.bonus : 0,
      amount: k ? k.base + k.bonus : nm ? Number(nm[1].replace(/,/g, "")) || 0 : 0,
      label: k ? k.name : String(p.name || "Bundle"),
      price: money(pr.price_final, p.currency),
      was: cut ? money(pr.price_original, p.currency) : "",
      saleName: sale ? String(sale.name || "").trim() : "",
      off,
      vat: taxLine(p),
      // a product we don't know and can't size shows the single gem, not a heap
      // ?v: the pile art is loaded from here, not stamped in the HTML, so bump it when the art changes
      pile: IMG + (k ? "pile-" + k.pile : guess ? "pile-" + guessPile(guess) : "gem") + ".png?v=piles2",
      plain: !k && !guess,
      canBuy: !p.stock || p.stock.available_to_purchase !== false,
      gift: p.is_gifting_disabled !== true,
    };
  }

  function amountBlock(d, p) {
    const wrap = el("div", "st-amt-wrap");
    if (d.k) {
      const amt = el("p", "st-amt");
      amt.append(el("span", "st-grad", num(d.total)), el("span", "st-unit", " Sapphires"));
      wrap.append(amt);
      const bonus = el("p", "st-bonus");
      if (d.k.bonus) {
        bonus.append(el("span", "", num(d.k.base) + " + " + num(d.k.bonus) + " bonus"),
          el("span", "st-pct", "+" + Math.round((d.k.bonus / d.k.base) * 100) + "%"));
      } else {
        bonus.classList.add("is-none");
        bonus.textContent = "No bonus";
      }
      wrap.append(bonus);
    } else if (d.amount) {
      // a product we don't know, named for its amount: that name, drawn
      // like the others, with no bonus split
      const amt = el("p", "st-amt");
      amt.append(el("span", "st-grad", num(d.amount)), el("span", "st-unit", " Sapphires"));
      wrap.append(amt);
    } else {
      // a product we don't know: PayNow's own name, no bonus split
      wrap.append(el("p", "st-amt is-named", String(p.name || "Bundle")));
    }
    return wrap;
  }

  // the heap, or the single gem for a product we can't size
  function artImg(d) {
    const img = el("img");
    img.src = d.pile;
    img.alt = "";
    if (d.plain) {
      img.className = "is-gem";
      img.width = 16;
      img.height = 16;
    } else {
      img.width = 64;
      img.height = 40;
    }
    return img;
  }

  function priceBlock(d) {
    const box = el("div", "st-price");
    const row = el("span", "st-price-row");
    const now = el("b", "", d.price);
    row.append(now);
    if (d.was) {
      const s = el("s");
      s.append(el("span", "visually-hidden", "was "), d.was);
      row.append(s);
    }
    box.append(row);
    if (d.vat) box.append(el("small", "st-vat", d.vat));
    return box;
  }

  function buyButton(p, d, heading) {
    const b = el("button", "btn st-buy");
    b.type = "button";
    if (!d.canBuy) {
      b.disabled = true;
      b.classList.add("is-off");
      b.textContent = "Unavailable";
      return b;
    }
    b.innerHTML = "Buy" + ARROW;
    b.setAttribute("aria-label", "Buy " + heading + " for " + d.price);
    b.addEventListener("click", () => openBuy(p, d, b));
    return b;
  }

  function tags(d, extraFirst) {
    const t = el("div", "st-tags");
    if (extraFirst) t.append(extraFirst);
    if (d.k && d.k.popular) t.append(el("span", "st-tag is-pop", "Popular"));
    if (d.off) {
      // the sale's own name where there's room; phones show just "20% off"
      const s = el("span", "st-tag is-sale");
      if (d.saleName && d.saleName.length <= 16) s.append(el("span", "st-tag-name", d.saleName + " "));
      s.append(d.off);
      t.append(s);
    }
    return t.childNodes.length ? t : null;
  }

  function card(p, i) {
    const d = describe(p);
    const li = el("li", "st-card st-rise");
    li.style.setProperty("--i", i);
    if (d.k && d.k.popular) li.classList.add("is-pop");
    if (!d.canBuy) li.classList.add("is-off");
    const heading = d.k ? d.label + ", " + num(d.total) + " Sapphires" : d.label;
    const id = "b-" + String(p.slug || p.id).replace(/[^a-z0-9-]/gi, "");

    const t = tags(d);
    if (t) li.append(t);

    const art = el("div", "st-art");
    const img = artImg(d);
    img.loading = "lazy";
    art.append(img);

    const body = el("div", "st-card-body");
    // a product we don't know shows PayNow's name in the amount's place,
    // so its heading is only for screen readers
    const h = el("h3", d.k ? "st-name" : "visually-hidden", d.label);
    h.id = id;
    body.append(h, amountBlock(d, p));

    const foot = el("div", "st-foot");
    foot.append(priceBlock(d), buyButton(p, d, heading));

    li.setAttribute("aria-labelledby", id);
    li.append(art, body, foot);
    return li;
  }

  function starterCard(p, i) {
    const d = describe(p);
    const box = el("article", "st-starter st-rise");
    box.style.setProperty("--i", i);
    box.setAttribute("aria-labelledby", "b-starter");
    if (!d.canBuy) box.classList.add("is-off");

    const art = el("div", "st-art");
    art.append(artImg(d));

    const mid = el("div", "st-starter-text");
    const once = el("span", "st-tag is-once", "One per player");
    const t = tags(d, once);
    const h = el("h3", "st-starter-name", d.label);
    h.id = "b-starter";
    mid.append(t, h, amountBlock(d, p));

    const side = el("div", "st-starter-buy");
    side.append(priceBlock(d), buyButton(p, d, d.label + ", " + num(d.total) + " Sapphires"));
    box.append(art, mid, side);
    return box;
  }

  function stateCard(kind, title, text, action) {
    const box = el("div", "st-state is-" + kind);
    const gem = el("img", "st-state-gem");
    gem.src = IMG + "gem.png";
    gem.width = 16;
    gem.height = 16;
    gem.alt = "";
    box.append(gem, el("h3", "", title), el("p", "", text));
    if (action) box.append(action);
    return box;
  }

  function renderError(box, err, refocus) {
    let text = "PayNow didn't answer. Check your connection and try again.";
    if (err.kind === "timeout") text = "PayNow is taking too long to answer. Try again in a minute.";
    else if (err.status === 404) text = "The store couldn't be found right now. Try again in a little while.";
    else if (err.status >= 500) text = "PayNow had a problem on its side. Try again in a minute.";
    else if (err.status) text = "PayNow turned the request down. Try again in a minute.";
    const again = el("button", "btn btn-dark");
    again.type = "button";
    again.innerHTML = "Try again" + ARROW;
    again.addEventListener("click", () => {
      // the button is about to go: hold focus on the section's heading
      // meanwhile, rather than let it fall to the page
      const title = $("#bundles-title");
      if (title) title.focus();
      sayCatalog("Loading the bundles.");
      box.replaceChildren(skeleton());
      loadCatalog(box, true);
    });
    box.replaceChildren(stateCard("error", "The bundles didn't load", text, again));
    sayCatalog("The bundles didn't load. " + text);
    if (refocus) refocusOn(again);
  }

  // after a retry, unless the visitor has moved on to something else meanwhile
  function refocusOn(target) {
    const a = document.activeElement;
    if (target && (!a || a === document.body || a.id === "bundles-title")) target.focus();
  }

  function skeleton() {
    const s = el("div", "st-sk");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML =
      '<div class="st-sk-wide"><i></i><span><b style="--w:30%"></b><b style="--w:55%"></b><b style="--w:40%"></b></span></div>' +
      '<div class="st-sk-grid">' + '<div class="st-sk-card"><i></i><b style="--w:40%"></b><b style="--w:70%"></b><b style="--w:55%"></b></div>'.repeat(4) + "</div>";
    const w = el("p", "st-sk-wait", "Still waiting for PayNow…");
    w.setAttribute("data-catalog-wait", "");
    w.hidden = true;
    const frag = document.createDocumentFragment();
    frag.append(s, w);
    return frag;
  }

  /* ── buying ──────────────────────────────────────────────────────── */

  let dlg, form, uIn, gIn, toggle, giftWrap, giftField, go, goLabel, alertBox, statusBox, sumBox;
  let current = null;      // { p, d, opener }
  let busy = false;
  let flight = null;       // AbortController for the calls in progress
  let coolUntil = 0;
  let slowTimer = null;

  function setupBuy() {
    dlg = $("#buy");
    if (!dlg || typeof dlg.showModal !== "function") return;
    form = $("[data-buy-form]", dlg);
    uIn = $("#buy-user", dlg);
    gIn = $("#buy-gift", dlg);
    toggle = $("[data-gift-toggle]", dlg);
    giftWrap = $("[data-gift-wrap]", dlg);
    giftField = $("[data-field=gift]", dlg);
    go = $("[data-buy-go]", dlg);
    goLabel = $("[data-buy-go-label]", dlg);
    alertBox = $("[data-buy-alert]", dlg);
    statusBox = $("[data-buy-status]", dlg);
    sumBox = $("[data-buy-sum]", dlg);

    $("[data-buy-close]", dlg).addEventListener("click", () => closeBuy());
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeBuy(); });
    dlg.addEventListener("close", onClosed);
    // the backdrop closes it, but only when the press also began there
    let downOut = false;
    dlg.addEventListener("pointerdown", (e) => { downOut = e.target === dlg; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg && downOut) closeBuy(); });

    toggle.addEventListener("change", () => {
      giftField.hidden = !toggle.checked;
      giftWrap.classList.toggle("is-on", toggle.checked);
      if (toggle.checked) gIn.focus();
      else setErr(gIn, "");
      summary();
    });

    [uIn, gIn].forEach((input) => {
      input.addEventListener("input", () => {
        // a fix clears the message as soon as the name is right
        const f = input.closest(".st-field");
        if (f.classList.contains("has-err") && !checkName(input)) setErr(input, "");
        head(input);
        summary();
      });
      input.addEventListener("blur", () => {
        if (input.value.trim()) setErr(input, checkName(input));
      });
    });

    form.addEventListener("submit", submit);

    // Back from PayNow's checkout can restore this page from the cache,
    // mid-redirect. Give the button back.
    window.addEventListener("pageshow", (e) => { if (e.persisted) idle(); });
  }

  function openBuy(p, d, opener) {
    if (!dlg) return;
    current = { p, d, opener };
    const pile = $("[data-buy-pile]", dlg);
    pile.src = d.pile;
    pile.classList.toggle("is-gem", d.plain);
    $("[data-buy-name]", dlg).textContent = d.k ? d.label : "Bundle";
    $("[data-buy-amount]", dlg).textContent = d.amount ? num(d.amount) : d.label;
    $("[data-buy-unit]", dlg).hidden = !d.amount;
    $("[data-buy-price]", dlg).textContent = d.price;
    const was = $("[data-buy-was]", dlg);
    was.hidden = !d.was;
    was.replaceChildren(el("span", "visually-hidden", "was "), d.was);
    const vat = $("[data-buy-vat]", dlg);
    vat.hidden = !d.vat;
    vat.textContent = d.vat;

    giftWrap.hidden = !d.gift;
    if (!d.gift) toggle.checked = false;
    giftField.hidden = !toggle.checked;
    giftWrap.classList.toggle("is-on", toggle.checked);
    setErr(uIn, "");
    setErr(gIn, "");
    showAlert("");
    idle();
    summary();
    head(uIn);
    head(gIn);

    if (!dlg.open) dlg.showModal();
    html.classList.add("st-locked");
    requestAnimationFrame(() => (uIn.value ? go : uIn).focus());
  }

  function closeBuy() {
    if (flight) { flight.abort(); flight = null; }
    if (dlg.open) dlg.close();
  }

  function onClosed() {
    html.classList.remove("st-locked");
    idle();
    if (current && current.opener && current.opener.isConnected) current.opener.focus();
  }

  function checkName(input) {
    const v = input.value.trim();
    const mine = input === gIn;
    if (!v) return mine ? "Type the username of the player you're gifting to." : "Type your Java Edition username.";
    if (!NAME.test(v)) return "Usernames are 3 to 16 letters, numbers or underscores.";
    if (mine && uIn.value.trim().toLowerCase() === v.toLowerCase()) return "That's your own name. Turn off the gift to buy for yourself.";
    return "";
  }

  function setErr(input, msg) {
    const f = input.closest(".st-field");
    const e = $("[data-err]", f);
    f.classList.toggle("has-err", !!msg);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    // a live region that stays in place and is only emptied, so every new
    // message is announced
    e.textContent = msg;
  }

  function head(input) {
    const img = $("[data-head]", input.closest(".st-field"));
    const v = input.value.trim();
    clearTimeout(input._headTimer);
    if (!NAME.test(v)) { img.hidden = true; img.removeAttribute("src"); img.dataset.name = ""; return; }
    if (img.dataset.name === v) return;
    input._headTimer = setTimeout(() => {
      img.dataset.name = v;
      img.onload = () => { if (img.dataset.name === v) img.hidden = false; };
      img.onerror = () => {
        img.onerror = () => { img.hidden = true; };
        img.src = "https://minotar.net/helm/" + encodeURIComponent(v) + "/64";
      };
      img.src = "https://mc-heads.net/avatar/" + encodeURIComponent(v) + "/64";
    }, 300);
  }

  function summary() {
    if (!current) return;
    const u = uIn.value.trim();
    const g = gIn.value.trim();
    const giftOn = toggle.checked && !giftWrap.hidden;
    const what = current.d.k ? num(current.d.total) + " Sapphires" : current.d.label;
    const b = (t) => el("b", "", t);
    const parts = [];
    if (giftOn && NAME.test(g)) {
      parts.push(b(g), " gets " + what + " in game");
      if (NAME.test(u)) parts.push(", as a gift from ", b(u));
      parts.push(".");
    } else if (!giftOn && NAME.test(u)) {
      parts.push(b(u), " gets " + what + " in game.");
    } else {
      parts.push(giftOn ? "The Sapphires go to the player you're gifting to." : "The Sapphires go to the username you type.");
    }
    const gem = el("img");
    gem.src = IMG + "glyph.png";
    gem.width = 18;
    gem.height = 18;
    gem.alt = "";
    // one inline run of text beside the gem, so the names flow with it
    const text = el("span");
    text.append(...parts.map((x) => (typeof x === "string" ? document.createTextNode(x) : x)));
    sumBox.replaceChildren(gem, text);
  }

  function showAlert(msg, ref) {
    alertBox.replaceChildren();
    if (!msg) return;
    alertBox.append(el("span", "", msg));
    if (ref) alertBox.append(el("small", "", "Reference: " + ref));
  }

  // The status line under the button is the live region: every step is read
  // out as it happens. Steps the button already shows stay off screen; the
  // "taking a while" note and the hand-off to PayNow show there too.
  function say(text, shown) {
    statusBox.textContent = text;
    statusBox.classList.toggle("visually-hidden", !!text && !shown);
  }

  function working(label) {
    busy = true;
    // aria-disabled, not disabled: disabling the focused button would drop
    // keyboard focus out of the dialog. submit() ignores presses while busy.
    go.setAttribute("aria-disabled", "true");
    go.classList.add("is-busy");
    step(label);
    uIn.readOnly = true;
    gIn.readOnly = true;
    toggle.disabled = true;
  }

  // the next step, unless the "taking a while" note is up: that stays
  function step(label) {
    goLabel.textContent = label;
    if (!(statusBox.textContent && !statusBox.classList.contains("visually-hidden"))) say(label);
  }

  function idle() {
    busy = false;
    clearTimeout(slowTimer);
    if (!go) return;
    go.removeAttribute("aria-disabled");
    go.classList.remove("is-busy");
    goLabel.textContent = "Continue to checkout";
    uIn.readOnly = false;
    gIn.readOnly = false;
    toggle.disabled = false;
    say("");
  }

  // PayNow's checkout URL, and nothing else, gets to move this tab
  function safeUrl(s) {
    try {
      const u = new URL(String(s));
      if (u.protocol === "https:") return u.href;
      if (u.protocol === "http:" && LOCAL && LOCAL_HOST.test(u.hostname)) return u.href;
    } catch {}
    return "";
  }

  async function submit(e) {
    e.preventDefault();
    // one click at a time: rapid repeats can trip PayNow's rate limiting
    if (busy || Date.now() < coolUntil || !current) return;
    showAlert("");

    const giftOn = toggle.checked && !giftWrap.hidden;
    const errU = checkName(uIn);
    const errG = giftOn ? checkName(gIn) : "";
    setErr(uIn, errU);
    setErr(gIn, errG);
    if (errU || errG) {
      (errU ? uIn : gIn).focus();
      return;
    }
    if (IS_DEMO) {
      showAlert("This is PayNow's demo store, so buying is switched off here.");
      return;
    }

    const user = uIn.value.trim();
    const gift = giftOn ? gIn.value.trim() : "";
    const p = current.p;
    const ctl = new AbortController();
    flight = ctl;
    let stage = "auth";
    working("Checking your username…");
    slowTimer = setTimeout(() => say("PayNow is taking a while. Hang on…", true), 4000);
    // closed (or replaced by a newer try) while a reply was on its way
    const gone = () => ctl.signal.aborted || flight !== ctl;

    try {
      const signIn = async () => {
        const r = await pn("/store/customer/auth", { body: { platform: "minecraft", id: user }, signal: ctl.signal });
        if (!r || typeof r.customer_token !== "string" || !r.customer_token) throw Object.assign(new Error("no token"), { kind: "bad" });
        return r.customer_token;
      };
      const line = { product_id: p.id, quantity: 1 };
      if (gift) line.gift_to = { platform: "minecraft", id: gift };
      const body = {
        lines: [line],
        return_url: new URL("thanks/", new URL("./", location.href)).href,
        cancel_url: new URL("./", location.href).href,
        auto_redirect: true,
      };

      let token = await signIn();
      // no checkout is ever made for a dialog that was closed
      if (gone()) return;
      stage = "checkout";
      step("Opening checkout…");
      let session;
      try {
        session = await pn("/checkouts", { token, body, signal: ctl.signal });
      } catch (err) {
        // an expired or refused token: sign in once more, then try again
        if (err.status !== 401 && err.status !== 403) throw err;
        stage = "auth";
        token = await signIn();
        if (gone()) return;
        stage = "checkout";
        session = await pn("/checkouts", { token, body, signal: ctl.signal });
      }
      token = null;
      // the buyer backed out while the checkout was being made: stay here
      if (gone()) return;
      const url = safeUrl(session && session.url);
      if (!url) throw Object.assign(new Error("bad checkout url"), { kind: "bad" });
      clearTimeout(slowTimer);
      goLabel.textContent = "Opening checkout…";
      say("Taking you to PayNow…", true);
      flight = null;
      location.assign(url);
    } catch (err) {
      if (err.kind === "abort" || gone()) return; // closed by the buyer
      flight = null;
      idle();
      coolUntil = Date.now() + 800;
      explain(err, stage, gift, user);
    }
  }

  function explain(err, stage, gift, user) {
    const d = (err && err.data) || {};
    const said = String(d.message || "") + " " + String(d.code || "");
    const ref = typeof d.trace_id === "string" && /^[A-Za-z0-9-]{6,64}$/.test(d.trace_id) ? d.trace_id : "";

    if (err.kind === "http" && err.status === 400 && /player\W*not\W*found/i.test(said)) {
      const input = stage === "checkout" && gift ? gIn : uIn;
      setErr(input, "We couldn't find that Minecraft player.");
      input.focus();
      return;
    }
    let msg;
    if (err.kind === "timeout") msg = "PayNow is taking too long to answer. Try again in a minute.";
    else if (err.kind === "network") msg = "We couldn't reach PayNow. Check your connection and try again.";
    else if (err.kind === "bad") msg = "PayNow sent back something we didn't expect. Try again in a minute.";
    else if (err.status === 429) msg = "Too many tries at once. Wait a few seconds, then try again.";
    else if (err.status >= 500) msg = "PayNow had a problem on its side. Try again in a minute.";
    else if (err.status === 404) msg = "This bundle isn't on sale any more. Refresh the page to see what is.";
    else if (/limit|stock/i.test(said)) {
      msg = current && current.d.k && current.d.k.starter
        ? "The Starter Pack is one per player, and " + (gift || user) + " already has it."
        : "That player can't buy any more of this bundle.";
    } else msg = "PayNow couldn't start the checkout. Try again, or contact us if it keeps happening.";
    showAlert(msg, err.status >= 500 || err.kind === "http" ? ref : "");
    go.focus();
  }
})();
