/* ==================================================================
   MCS Admin: the app
   One page; the hash picks the module (#/fixtures, #/tiers...). Every
   call goes to the Worker's /api with the X-MCS-Admin header, and the
   Worker talks to the game server. Text from the server is only ever
   set as text (reports quote players' chat): never as HTML.
   ================================================================== */

(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const main = $("[data-main]");
  const dlg = $("[data-dlg]");
  const toastEl = $("[data-toast]");
  const TIER_IMG = "https://mcsoccer.net/assets/img/tiers/";
  const NAME = /^[A-Za-z0-9_]{1,16}$/;

  /* ── building blocks ──────────────────────────────────────────── */

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(3)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }

  const head = (name, size = 28) => {
    const img = h("img", { src: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size * 2}`, width: size, height: size, alt: "", loading: "lazy" });
    img.addEventListener("error", () => { img.src = `https://minotar.net/helm/${encodeURIComponent(name)}/${size * 2}`; }, { once: true });
    return img;
  };

  async function call(method, path, body) {
    let r;
    try {
      r = await fetch("/api" + path, {
        method,
        credentials: "same-origin",
        headers: { "X-MCS-Admin": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { ok: false, error: "The dashboard can't be reached. Check your connection." };
    }
    if (r.status === 401) { location.href = "/"; return { ok: false, error: "Signed out." }; }
    let data = null;
    try { data = await r.json(); } catch {}
    if (!data || typeof data !== "object") data = { ok: false, error: `The dashboard answered ${r.status}.` };
    data.httpStatus = r.status;
    return data;
  }

  let toastTimer = 0;
  function toast(text, bad) {
    toastEl.textContent = text;
    toastEl.classList.toggle("is-bad", !!bad);
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), bad ? 6000 : 3200);
  }

  const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const localDate = (ms) => localInput(ms).slice(0, 10);
  const keyId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

  function pageHead(kicker, title, text, actions) {
    return h("header", { class: "head" },
      h("div", null, h("p", { class: "kicker" }, kicker), h("h1", null, title), text ? h("p", null, text) : null),
      actions ? h("div", { class: "head-actions" }, actions) : null);
  }
  const panel = (title, kids, opts = {}) => h("section", { class: "panel", style: opts.i != null ? `--i:${opts.i}` : null },
    title ? h("div", { class: "panel-head" }, h("h2", null, title), opts.aside || null) : null, kids);
  const errorBox = (text) => h("p", { class: "err" }, text);
  const empty = (text) => h("p", { class: "empty" }, text);

  /* ── the dialog ───────────────────────────────────────────────── */

  /**
   * A dialog with a form. fields: [{ name, label, type, value, options, hint, required, min, max }]
   * submit(values) resolves { ok, error }: an error keeps the dialog open and shows it.
   */
  function formDialog({ title, text, fields = [], okLabel = "Save", bad = false, submit }) {
    return new Promise((resolve) => {
      const inputs = {};
      const errEl = h("p", { class: "err", hidden: true });
      const form = h("form", { class: "form", method: "dialog" },
        text ? (text.nodeType ? text : h("p", null, text)) : null,
        fields.map((f) => {
          if (f.type === "row") return h("div", { class: "form-row" }, f.fields.map(field));
          return field(f);
        }),
        errEl,
        h("div", { class: "dlg-foot" },
          h("button", { class: "btn btn-dark", type: "button", value: "cancel", onclick: () => dlg.close("cancel") }, "Cancel"),
          h("button", { class: bad ? "btn btn-bad" : "btn", type: "submit", "data-ok": true }, okLabel)));
      function field(f) {
        let input;
        if (f.type === "select") {
          input = h("select", { class: "input", name: f.name, required: f.required || null },
            (f.options || []).map((o) => h("option", { value: o.value, selected: String(o.value) === String(f.value ?? "") || null }, o.label)));
        } else if (f.type === "checkbox") {
          input = h("input", { type: "checkbox", name: f.name, checked: f.value ? true : null });
          inputs[f.name] = input;
          if (f.onchange) input.addEventListener("change", () => f.onchange(input.checked, inputs));
          return h("label", { class: "check" }, input, f.label);
        } else if (f.type === "textarea") {
          input = h("textarea", { class: "input", name: f.name, maxlength: f.max || 200, required: f.required || null });
          input.value = f.value || "";
        } else {
          input = h("input", { class: "input", name: f.name, type: f.type || "text", value: f.value ?? "", required: f.required || null, min: f.min ?? null, max: f.max ?? null, maxlength: f.maxlength || null, placeholder: f.placeholder || null, autocomplete: "off" });
        }
        inputs[f.name] = input;
        const wrap = h("label", { class: "field", "data-field": f.name, hidden: f.hidden || null }, h("span", null, f.label), input, f.hint ? h("small", null, f.hint) : null);
        return wrap;
      }
      dlg.replaceChildren(h("div", { class: bad ? "dlg-box is-bad" : "dlg-box" }, h("h2", { id: "dlg-title" }, title), form));
      for (const f of fields.flatMap((x) => (x.type === "row" ? x.fields : [x]))) if (f.onchange && f.type === "checkbox") f.onchange(!!f.value, inputs);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const values = {};
        for (const [k, el] of Object.entries(inputs)) values[k] = el.type === "checkbox" ? el.checked : el.value.trim();
        const okBtn = $("[data-ok]", form);
        okBtn.disabled = true;
        errEl.hidden = true;
        const r = submit ? await submit(values, inputs) : { ok: true };
        okBtn.disabled = false;
        if (r && r.ok === false) { errEl.textContent = r.error || "That didn't work."; errEl.hidden = false; return; }
        dlg.close("ok");
        resolve(r || { ok: true });
      });
      dlg.onclose = () => { if (dlg.returnValue !== "ok") resolve(null); };
      dlg.returnValue = "";
      dlg.showModal();
      const first = form.querySelector("input:not([type=checkbox]), select, textarea");
      if (first) first.focus();
    });
  }
  const confirmBox = (title, text, okLabel, bad = true) => formDialog({ title, text, okLabel, bad, submit: async () => ({ ok: true }) });

  /* ── who's signed in ──────────────────────────────────────────── */

  let ME = null;
  async function loadMe() {
    const r = await call("GET", "/me");
    if (!r.ok) return;
    ME = r.me;
    const box = $("[data-me]");
    $("[data-me-name]", box).textContent = ME.name;
    $("[data-me-role]", box).textContent = ME.role;
    const av = $("[data-me-avatar]", box);
    av.src = ME.avatar ? `https://cdn.discordapp.com/avatars/${ME.id}/${ME.avatar}.png?size=64` : "https://cdn.discordapp.com/embed/avatars/0.png";
    box.hidden = false;
  }
  $("[data-signout]").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    location.href = "/";
  });

  /* ── shared data ──────────────────────────────────────────────── */

  let clubsCache = null;
  let pitchesCache = null;
  async function clubs() {
    if (clubsCache) return clubsCache;
    const r = await call("GET", "/clubs");
    clubsCache = r.ok ? r.clubs : [];
    return clubsCache;
  }
  async function pitches() {
    if (pitchesCache) return pitchesCache;
    const r = await call("GET", "/pitches");
    pitchesCache = r.ok ? r.pitches : [];
    return pitchesCache;
  }
  const clubTag = (c) => h("span", { class: "club", style: c && c.color ? `--c:${c.color}` : null }, h("i"), (c && c.name) || "?");

  async function refreshReportCount() {
    const r = await call("GET", "/reports?status=open");
    const pill = $("[data-count-reports]");
    const n = r.ok ? r.items.length : 0;
    pill.textContent = n;
    pill.hidden = !n;
  }

  /* ── Overview ─────────────────────────────────────────────────── */

  async function home() {
    const out = [pageHead("MCS Admin", `Hi, ${ME ? ME.name : "there"}`, "Everything for running MCS, in one place. Changes here reach the game and the Discord straight away.")];
    const grid = h("div", { class: "grid" });
    out.push(grid);
    main.replaceChildren(...out);

    const [status, fx, reports, act] = await Promise.all([call("GET", "/status"), call("GET", "/fixtures"), call("GET", "/reports?status=open"), call("GET", "/activity")]);

    const server = status.ok && status.server;
    grid.append(panel("Game server", [
      h("p", null, h("span", { class: server ? "dot" : "dot is-down" }), server ? "Online and answering" : "Not answering right now"),
      status.ok && status.meta ? h("div", { class: "form-row", style: "margin-top:.8rem" },
        h("div", { class: "stat" }, h("b", null, Number(status.meta.matches || 0).toLocaleString()), h("span", null, "matches played")),
        h("div", { class: "stat" }, h("b", null, Number(status.meta.players || 0).toLocaleString()), h("span", null, "players"))) : null,
    ], { i: 0 }));

    const list = fx.ok ? fx.fixtures : [];
    const live = list.filter((f) => f.state === "LIVE");
    const next = list.filter((f) => f.state === "SCHEDULED").sort((a, b) => a.kickoff - b.kickoff).slice(0, 4);
    grid.append(panel("Fixtures", [
      !fx.ok ? errorBox(fx.error) : null,
      live.length ? h("div", { class: "rows" }, live.map((f) => fixtureRow(f, false))) : null,
      next.length ? h("div", { class: "rows" }, next.map((f) => fixtureRow(f, false))) : fx.ok ? empty("Nothing booked.") : null,
    ], { i: 1, aside: h("a", { href: "#/fixtures" }, "All fixtures") }));

    const open = reports.ok ? reports.items.length : null;
    grid.append(panel("Reports", [
      reports.ok ? h("div", { class: "stat" }, h("b", null, String(open)), h("span", null, open === 1 ? "open report" : "open reports")) : errorBox(reports.error),
    ], { i: 2, aside: h("a", { href: "#/reports" }, "See reports") }));

    grid.append(panel("Recent activity", [
      act.ok && act.items.length ? h("div", { class: "rows" }, act.items.slice(0, 5).map(activityRow)) : empty("Nothing yet."),
    ], { i: 3, aside: h("a", { href: "#/activity" }, "All activity") }));
  }

  /* ── Fixtures ─────────────────────────────────────────────────── */

  let fxTab = "upcoming";

  function fixtureRow(f, actions = true) {
    const tags = [];
    if (f.state === "LIVE") tags.push(h("span", { class: "tag is-live" }, "Live"));
    if (f.tbd && f.state === "SCHEDULED") tags.push(h("span", { class: "tag is-warn" }, "Time TBD"));
    if (f.label) tags.push(h("span", { class: "tag" }, f.label));
    if (f.state === "CANCELLED") tags.push(h("span", { class: "tag is-bad" }, "Cancelled"));
    const score = f.score ? h("b", { class: "score" }, ` ${f.score.home} – ${f.score.away} `) : h("span", { class: "vs" }, "vs");
    const when = f.state === "SCHEDULED"
      ? (f.tbd ? `Time TBD, by ${fmtDay(f.kickoff)}` : fmtWhen(f.kickoff))
      : f.state === "FINISHED" ? `${fmtDay(f.kickoff)}${f.decidedBy && f.decidedBy !== "goals" ? ` · ${f.decidedBy === "forfeit" ? "walkover" : f.decidedBy === "entered" ? "result entered" : f.decidedBy}` : ""}`
      : fmtWhen(f.kickoff);
    return h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("div", { class: "row-title" }, clubTag(f.home), score, clubTag(f.away), tags),
        h("div", { class: "row-sub" }, h("span", null, when), f.pitch ? h("span", null, f.pitch) : null, h("span", null, `#${f.id}`))),
      actions && f.state === "SCHEDULED" ? h("div", { class: "row-actions" },
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => editFixture(f) }, "Edit"),
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => resultFixture(f) }, "Result"),
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => forfeitFixture(f) }, "Walkover"),
        h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => cancelFixture(f) }, "Cancel")) : h("span"));
  }

  async function fixtures() {
    main.replaceChildren(pageHead("Fixtures", "Fixtures", "Book, move and settle club games. Players see changes in game and in the Discord right away.",
      h("button", { class: "btn", type: "button", onclick: bookFixture }, "Book a fixture")), h("div", { class: "loading" }, "Loading fixtures…"));
    const r = await call("GET", "/fixtures");
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    const all = r.fixtures;
    const sets = {
      upcoming: all.filter((f) => f.state === "SCHEDULED" || f.state === "LIVE").sort((a, b) => (a.state === "LIVE" ? -1 : 0) - (b.state === "LIVE" ? -1 : 0) || a.kickoff - b.kickoff),
      finished: all.filter((f) => f.state === "FINISHED").sort((a, b) => b.kickoff - a.kickoff),
      cancelled: all.filter((f) => f.state === "CANCELLED").sort((a, b) => b.kickoff - a.kickoff),
    };
    const tabs = h("div", { class: "tabs" }, [["upcoming", "Upcoming"], ["finished", "Finished"], ["cancelled", "Cancelled"]].map(([k, label]) =>
      h("button", { type: "button", "aria-pressed": String(fxTab === k), onclick: () => { fxTab = k; fixtures(); } }, `${label} (${sets[k].length})`)));
    const list = sets[fxTab];
    main.replaceChildren(main.firstChild, panel(null, [h("div", { class: "panel-head" }, tabs),
      list.length ? h("div", { class: "rows" }, list.map((f) => fixtureRow(f))) : empty("Nothing here.")]));
  }

  async function clubOptions() {
    const cs = await clubs();
    return cs.map((c) => ({ value: c.id, label: c.name }));
  }
  async function pitchOptions() {
    const ps = await pitches();
    return [{ value: "", label: "Not picked yet" }, ...ps.map((p) => ({ value: p.id, label: p.name }))];
  }
  const timeFields = (f) => [
    { name: "tbd", type: "checkbox", label: "The time isn't agreed yet (the date is the deadline)", value: f ? f.tbd : false,
      onchange: (on, inputs) => {
        $("[data-field=kickoff]", dlg).hidden = on;
        $("[data-field=deadline]", dlg).hidden = !on;
        inputs.kickoff.required = !on;
        inputs.deadline.required = on;
      } },
    { name: "kickoff", type: "datetime-local", label: "Kickoff (your time)", value: f && !f.tbd ? localInput(f.kickoff) : "" },
    { name: "deadline", type: "date", label: "Play by", value: f ? localDate(f.kickoff) : "", hint: "Due by the end of that day." },
  ];
  function kickoffOf(v) {
    if (v.tbd) return v.deadline ? new Date(`${v.deadline}T23:59`).getTime() : NaN;
    return v.kickoff ? new Date(v.kickoff).getTime() : NaN;
  }

  async function bookFixture() {
    const [co, po] = await Promise.all([clubOptions(), pitchOptions()]);
    if (!co.length) return toast("The game server's clubs couldn't be loaded.", true);
    const r = await formDialog({
      title: "Book a fixture", okLabel: "Book it",
      fields: [
        { type: "row", fields: [
          { name: "home", type: "select", label: "Home", options: co, value: co[0].value, required: true },
          { name: "away", type: "select", label: "Away", options: co, value: (co[1] || co[0]).value, required: true }] },
        ...timeFields(null),
        { type: "row", fields: [
          { name: "label", label: "Label", placeholder: "Week 2", maxlength: 60 },
          { name: "competition", label: "Competition", value: "Champions League", maxlength: 60 }] },
        { name: "pitch", type: "select", label: "Pitch", options: po, value: "" },
        { name: "knockout", type: "checkbox", label: "Knockout (a draw goes to a shootout)" },
      ],
      submit: async (v) => {
        const kickoff = kickoffOf(v);
        if (!(kickoff > Date.now())) return { ok: false, error: "Pick a time in the future." };
        if (v.home === v.away) return { ok: false, error: "Pick two different clubs." };
        return call("POST", "/fixtures/create", { home: v.home, away: v.away, kickoff, tbd: v.tbd, label: v.label, competition: v.competition, pitch: v.pitch, knockout: v.knockout });
      },
    });
    if (r) { toast("Booked. It's announced in the Discord."); fixtures(); }
  }

  async function editFixture(f) {
    const po = await pitchOptions();
    const r = await formDialog({
      title: `Edit ${f.home.name} vs ${f.away.name}`,
      fields: [
        ...timeFields(f),
        { type: "row", fields: [
          { name: "label", label: "Label", value: f.label || "", maxlength: 60 },
          { name: "competition", label: "Competition", value: f.competition || "", maxlength: 60 }] },
        { name: "pitch", type: "select", label: "Pitch", options: po, value: f.pitchId || "" },
      ],
      submit: async (v) => {
        const kickoff = kickoffOf(v);
        if (!(kickoff > Date.now())) return { ok: false, error: "Pick a time in the future." };
        const body = { id: f.id, kickoff, tbd: v.tbd, label: v.label, competition: v.competition };
        if (v.pitch) body.pitch = v.pitch;
        return call("POST", "/fixtures/edit", body);
      },
    });
    if (r) { toast("Saved."); fixtures(); }
  }

  async function resultFixture(f) {
    const r = await formDialog({
      title: "Enter a result", text: `${f.home.name} vs ${f.away.name}. Use this for a game that was played but not recorded.`, okLabel: "Save result",
      fields: [{ type: "row", fields: [
        { name: "home", type: "number", label: f.home.name, min: 0, max: 999, required: true },
        { name: "away", type: "number", label: f.away.name, min: 0, max: 999, required: true }] }],
      submit: (v) => call("POST", "/fixtures/result", { id: f.id, home: Number(v.home), away: Number(v.away) }),
    });
    if (r) { toast("Result saved."); fixtures(); }
  }

  async function forfeitFixture(f) {
    const r = await formDialog({
      title: "Give a walkover", text: "For a game that never happened: one club gets the win, 1–0 unless you give a score.", okLabel: "Give the win",
      fields: [
        { name: "winner", type: "select", label: "Winner", options: [{ value: "home", label: f.home.name }, { value: "away", label: f.away.name }], value: "home" },
        { type: "row", fields: [
          { name: "home", type: "number", label: `${f.home.name} score (optional)`, min: 0, max: 999 },
          { name: "away", type: "number", label: `${f.away.name} score (optional)`, min: 0, max: 999 }] },
      ],
      submit: (v) => call("POST", "/fixtures/forfeit", { id: f.id, winner: v.winner, home: v.home === "" ? undefined : Number(v.home), away: v.away === "" ? undefined : Number(v.away) }),
    });
    if (r) { toast("Walkover given."); fixtures(); }
  }

  async function cancelFixture(f) {
    const ok = await confirmBox("Cancel this fixture?", `${f.home.name} vs ${f.away.name} comes off the schedule. Players are told in the Discord.`, "Cancel fixture");
    if (!ok) return;
    const r = await call("POST", "/fixtures/cancel", { id: f.id });
    if (r.ok) { toast("Cancelled."); fixtures(); } else toast(r.error, true);
  }

  /* ── Matches ──────────────────────────────────────────────────── */

  let matchPage = 1;

  async function matches() {
    main.replaceChildren(pageHead("Matches", "Matches", "Every game the server recorded, newest first. Delete one that shouldn't count: its stats come off everyone who played in it."), h("div", { class: "loading" }, "Loading matches…"));
    const r = await call("GET", `/matches?page=${matchPage}`);
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    const items = r.items || [];
    const rows = items.map((m) => {
      const red = m.teams && m.teams.RED, blue = m.teams && m.teams.BLUE;
      const sc = m.score || {};
      const tags = [h("span", { class: "tag" }, (m.mode || "").toLowerCase() || "match")];
      if (m.ranked) tags.push(h("span", { class: "tag is-good" }, "Ranked"));
      if (m.fixture) tags.push(h("span", { class: "tag is-warn" }, "Fixture"));
      return h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, `#${m.number || "?"}`,
            h("span", { class: "club", style: `--c:${(red && red.color) || "#ff5555"}` }, h("i"), (red && red.name) || "Red"),
            h("b", { class: "score" }, `${sc.RED ?? "–"} – ${sc.BLUE ?? "–"}`),
            h("span", { class: "club", style: `--c:${(blue && blue.color) || "#55ffff"}` }, h("i"), (blue && blue.name) || "Blue"), tags),
          h("div", { class: "row-sub" }, h("span", null, m.endedAt ? fmtWhen(m.endedAt) : ""), h("span", null, m.fieldName || ""), h("span", null, `${m.players || 0} players`), m.mvp ? h("span", null, `MVP ${m.mvp.name}`) : null)),
        h("div", { class: "row-actions" },
          h("a", { class: "btn btn-dark btn-sm", href: `https://mcsoccer.net/matches/?m=${encodeURIComponent(m.id)}`, target: "_blank", rel: "noopener" }, "View"),
          h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => wipeMatch(m) }, "Delete")));
    });
    const pager = h("div", { class: "panel-head", style: "margin:.8rem 0 0" },
      h("small", null, `Page ${r.page || matchPage} of ${r.pages || 1} · ${Number(r.total || 0).toLocaleString()} matches`),
      h("div", { class: "head-actions" },
        h("button", { class: "btn btn-dark btn-sm", type: "button", disabled: matchPage <= 1 || null, onclick: () => { matchPage--; matches(); } }, "Newer"),
        h("button", { class: "btn btn-dark btn-sm", type: "button", disabled: matchPage >= (r.pages || 1) || null, onclick: () => { matchPage++; matches(); } }, "Older")));
    main.replaceChildren(main.firstChild, panel(null, [rows.length ? h("div", { class: "rows" }, rows) : empty("No matches yet."), pager]));
  }

  async function wipeMatch(m) {
    const dry = await call("POST", "/matches/wipe", { id: m.id, dry: true });
    if (!dry.ok) return toast(dry.error, true);
    const n = Number(dry.players) || 0;
    const text = h("div", { class: "form" },
      h("p", null, `Match #${m.number} (${(m.score && m.score.RED) ?? "–"}–${(m.score && m.score.BLUE) ?? "–"}, ${m.fieldName || "a pitch"}) is removed for good.`),
      h("p", null, `${n} player${n === 1 ? "" : "s"} lose its goals, wins and stats.`),
      dry.fixture ? h("p", { class: "note" }, "It was a fixture, so that fixture goes back on the schedule.") : null);
    const ok = await formDialog({ title: "Delete this match?", text, okLabel: "Delete match", bad: true,
      submit: () => call("POST", "/matches/wipe", { id: m.id }) });
    if (ok) { toast("Match deleted."); matches(); }
  }

  /* ── Reports ──────────────────────────────────────────────────── */

  let reportTab = "open";
  const REASONS = { CHEATING: "Cheating", CHAT: "Chat", TROLLING: "Trolling", OTHER: "Other" };

  async function reports() {
    main.replaceChildren(pageHead("Reports", "Reports", "What players reported in game. Closing one here closes it in game and in the Discord too."), h("div", { class: "loading" }, "Loading reports…"));
    const r = await call("GET", `/reports?status=${reportTab === "all" ? "all" : "open"}`);
    const tabs = h("div", { class: "tabs" }, [["open", "Open"], ["all", "All"]].map(([k, label]) =>
      h("button", { type: "button", "aria-pressed": String(reportTab === k), onclick: () => { reportTab = k; reports(); } }, label)));
    if (!r.ok) return main.replaceChildren(main.firstChild, panel(null, [h("div", { class: "panel-head" }, tabs), errorBox(r.error)]));
    const items = r.items.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100);
    const rows = items.map((rep) => {
      const open = String(rep.status || "").toUpperCase() === "OPEN";
      const reason = REASONS[String(rep.reason || "").toUpperCase()] || "Other";
      const who = (p) => h("span", { class: "club" }, p && p.name ? head(p.name, 20) : null, (p && p.name) || "Unknown");
      return h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, who(rep.reporter), h("span", { class: "vs" }, "reported"), who(rep.target),
            h("span", { class: "tag" }, reason), open ? h("span", { class: "tag is-bad" }, "Open") : h("span", { class: "tag" }, String(rep.status || "closed").toLowerCase())),
          h("div", { class: "row-sub" }, rep.at ? h("span", null, `${fmtWhen(rep.at)} (${ago(rep.at)})`) : null, rep.where ? h("span", null, rep.where) : null,
            !open && rep.closedBy ? h("span", null, `closed by ${rep.closedBy}`) : null),
          rep.note ? h("p", { style: "margin:.4rem 0 0;color:var(--text-strong)" }, rep.note) : null,
          Array.isArray(rep.chat) && rep.chat.length ? h("pre", { class: "chat" }, rep.chat.slice(-5).join("\n")) : null),
        open ? h("div", { class: "row-actions" },
          h("button", { class: "btn btn-sm", type: "button", onclick: () => closeReport(rep, "handled") }, "Handled"),
          h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => closeReport(rep, "invalid") }, "Invalid")) : h("span"));
    });
    main.replaceChildren(main.firstChild, panel(null, [h("div", { class: "panel-head" }, tabs, h("small", null, `${items.length} shown`)),
      rows.length ? h("div", { class: "rows" }, rows) : empty(reportTab === "open" ? "No open reports. Nice." : "No reports.")]));
  }

  async function closeReport(rep, how) {
    const r = await call("POST", "/reports/close", { id: rep.id, how });
    if (r.ok) { toast(how === "invalid" ? "Marked invalid." : "Marked handled."); reports(); refreshReportCount(); } else toast(r.error, true);
  }

  /* ── Tier list ────────────────────────────────────────────────── */

  let tierState = null;   // { version, tiers: [{tier,color,high[],low[]}], dirty, added:Set }

  async function tiers() {
    if (tierState && tierState.dirty) return drawTiers();
    main.replaceChildren(pageHead("Tier list", "Tier list", "Drag players between tiers, or click one to move, rename or remove them. Saving updates mcsoccer.net/tiers within a minute."), h("div", { class: "loading" }, "Loading the tier list…"));
    const r = await call("GET", "/tiers");
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    if (!r.data) {
      return main.replaceChildren(main.firstChild, panel("The tier list isn't in the dashboard yet", [
        h("p", null, "Bring in the current tier list (the one on mcsoccer.net/tiers today) to start editing it here. Nothing changes on the site until you save."),
        h("div", { class: "dlg-foot", style: "justify-content:flex-start" }, h("button", { class: "btn", type: "button", onclick: importTiers }, "Bring in the current tier list")),
      ]));
    }
    tierState = { version: r.data.version || 0, updated: r.data.updated, savedBy: r.data.savedBy, tiers: clone(r.data.tiers), dirty: 0, added: new Set() };
    drawTiers();
  }

  const clone = (x) => JSON.parse(JSON.stringify(x));

  async function importTiers() {
    const r = await call("GET", "/tiers/import");
    if (!r.ok) return toast(r.error, true);
    tierState = { version: 0, tiers: clone(r.data.tiers), dirty: 1, added: new Set(), imported: true };
    drawTiers();
    toast("Brought in. Check it over, then save.");
  }

  function tierBadge(tier, band) {
    return tier >= 1 && tier <= 7 ? `${TIER_IMG}${band === "low" ? "lt" : "ht"}${tier}.png` : `${TIER_IMG}no-tier.png`;
  }

  function drawTiers() {
    const st = tierState;
    const total = st.tiers.reduce((n, t) => n + t.high.length + t.low.length, 0);
    const board = h("div", { class: "tiers", style: `--n:${st.tiers.length}` }, st.tiers.map((t, ti) =>
      h("section", { class: "tcol", style: `--tc:${t.color}` },
        h("header", { class: "tcol-head" }, h("img", { src: tierBadge(t.tier, "high"), width: 22, height: 22, alt: "" }), h("b", null, `Tier ${t.tier}`), h("small", null, String(t.high.length + t.low.length))),
        ["high", "low"].map((band) => {
          const list = h("div", { class: `tband is-${band}`, "data-ti": ti, "data-band": band },
            h("div", { class: "tband-tag" }, h("img", { src: tierBadge(t.tier, band), width: 22, height: 22, alt: "" }), `${band === "low" ? "LT" : "HT"}${t.tier}`),
            t[band].map((name, pi) => h("button", { class: st.added.has(name.toLowerCase()) ? "tp is-new" : "tp", type: "button", draggable: "true", "data-ti": ti, "data-band": band, "data-pi": pi, title: name },
              head(name, 28), h("span", null, name))));
          return list;
        }))));

    const bar = h("div", { class: st.dirty ? "tbar is-dirty" : "tbar" },
      h("div", null, st.dirty ? h("b", null, `${st.dirty} unsaved change${st.dirty === 1 ? "" : "s"}`) : h("span", null, st.updated ? `Saved${st.savedBy ? ` by ${st.savedBy}` : ""}, ${st.updated}` : "Saved"), ` · ${total} players`),
      h("div", { class: "head-actions" },
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: addPlayer }, "Add a player"),
        st.dirty ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => { tierState = null; tiers(); } }, "Discard") : null,
        h("button", { class: "btn btn-sm", type: "button", disabled: !st.dirty || null, onclick: saveTiers }, "Save")));

    main.replaceChildren(pageHead("Tier list", "Tier list", "Drag players between tiers, or click one to move, rename or remove them. Saving updates mcsoccer.net/tiers within a minute."), board, bar);
    wireDrag(board);
  }

  const changed = () => { tierState.dirty++; drawTiers(); };

  function wireDrag(board) {
    let from = null;
    board.addEventListener("dragstart", (e) => {
      const b = e.target.closest(".tp");
      if (!b) return;
      from = { ti: Number(b.dataset.ti), band: b.dataset.band, pi: Number(b.dataset.pi) };
      b.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", b.title);
    });
    board.addEventListener("dragend", () => { from = null; $$(".is-over", board).forEach((x) => x.classList.remove("is-over")); });
    board.addEventListener("dragover", (e) => {
      const zone = e.target.closest(".tband");
      if (!zone || !from) return;
      e.preventDefault();
      $$(".is-over", board).forEach((x) => x !== zone && x.classList.remove("is-over"));
      zone.classList.add("is-over");
    });
    board.addEventListener("drop", (e) => {
      const zone = e.target.closest(".tband");
      if (!zone || !from) return;
      e.preventDefault();
      const to = { ti: Number(zone.dataset.ti), band: zone.dataset.band };
      // dropped on a player: go just before them; on the band: go last
      const onto = e.target.closest(".tp");
      let at = onto ? Number(onto.dataset.pi) : tierState.tiers[to.ti][to.band].length;
      const src = tierState.tiers[from.ti][from.band];
      const [name] = src.splice(from.pi, 1);
      if (from.ti === to.ti && from.band === to.band && from.pi < at) at--;
      tierState.tiers[to.ti][to.band].splice(at, 0, name);
      from = null;
      changed();
    });
    board.addEventListener("click", (e) => {
      const b = e.target.closest(".tp");
      if (b) editPlayer(Number(b.dataset.ti), b.dataset.band, Number(b.dataset.pi));
    });
  }

  const tierOptions = () => tierState.tiers.flatMap((t, ti) => [
    { value: `${ti}:high`, label: `High Tier ${t.tier} (HT${t.tier})` },
    { value: `${ti}:low`, label: `Low Tier ${t.tier} (LT${t.tier})` }]);
  const nameTaken = (name, except) => tierState.tiers.some((t) => [...t.high, ...t.low].some((n) => n.toLowerCase() === name.toLowerCase() && n !== except));

  async function editPlayer(ti, band, pi) {
    const name = tierState.tiers[ti][band][pi];
    const list = tierState.tiers[ti][band];
    const r = await formDialog({
      title: name, okLabel: "Done",
      text: h("p", null, h("a", { href: `https://mcsoccer.net/tiers/?p=${encodeURIComponent(name)}`, target: "_blank", rel: "noopener" }, "See them on the tier list")),
      fields: [
        { name: "name", label: "Minecraft name", value: name, maxlength: 16, required: true, hint: "Exactly as in game: their head comes from it." },
        { name: "place", type: "select", label: "Tier", options: tierOptions(), value: `${ti}:${band}` },
        { name: "pos", type: "number", label: "Position in that tier", value: String(pi + 1), min: 1, max: 40, hint: "1 is the top." },
        { name: "remove", type: "checkbox", label: "Remove them from the tier list" },
      ],
      submit: async (v) => {
        if (!v.remove) {
          if (!NAME.test(v.name)) return { ok: false, error: "Minecraft names are 1 to 16 letters, numbers or _." };
          if (nameTaken(v.name, name)) return { ok: false, error: `${v.name} is already on the tier list.` };
        }
        return { ok: true, v };
      },
    });
    if (!r) return;
    const v = r.v;
    list.splice(pi, 1);
    if (!v.remove) {
      const [nti, nband] = v.place.split(":");
      const dest = tierState.tiers[Number(nti)][nband];
      const at = Math.max(0, Math.min(dest.length, (parseInt(v.pos, 10) || dest.length + 1) - 1));
      dest.splice(at, 0, v.name);
    }
    changed();
  }

  async function addPlayer() {
    const r = await formDialog({
      title: "Add a player", okLabel: "Add",
      fields: [
        { name: "name", label: "Minecraft name", maxlength: 16, required: true, placeholder: "DuckyWins" },
        { name: "place", type: "select", label: "Tier", options: tierOptions(), value: `${tierState.tiers.length - 1}:low` },
      ],
      submit: async (v) => {
        if (!NAME.test(v.name)) return { ok: false, error: "Minecraft names are 1 to 16 letters, numbers or _." };
        if (nameTaken(v.name)) return { ok: false, error: `${v.name} is already on the tier list.` };
        return { ok: true, v };
      },
    });
    if (!r) return;
    const [ti, band] = r.v.place.split(":");
    tierState.tiers[Number(ti)][band].push(r.v.name);
    tierState.added.add(r.v.name.toLowerCase());
    changed();
  }

  async function saveTiers() {
    const st = tierState;
    const r = await formDialog({
      title: "Save the tier list?", okLabel: "Save",
      text: "mcsoccer.net/tiers shows it within a minute.",
      fields: [{ name: "note", label: "What changed (optional)", maxlength: 200, placeholder: "Tested Lngr: HT2" }],
      submit: (v) => call("PUT", "/tiers", { tiers: st.tiers, version: st.version, note: v.note }),
    });
    if (!r) return;
    toast("Saved. The site updates within a minute.");
    tierState = null;
    tiers();
  }

  /* ── Players & Sapphires ──────────────────────────────────────── */

  const needsUpdate = (what) => panel(null, [h("p", { class: "note" }, `${what} needs the game server's admin update. This page works as soon as it's on the server.`)]);
  const RANK_NAMES = { owner: "Owner", admin: "Admin", developer: "Developer", mod: "Mod", helper: "Helper", media: "Media", affiliate: "Affiliate", vipplus: "MVP", mvp: "MVP", vip: "VIP", donator: "Donator", player: "Player" };
  const rankName = (id) => RANK_NAMES[String(id || "player").toLowerCase()] || String(id);
  const ownerOnly = () => ME && ME.role !== "owner" ? h("p", { class: "note" }, "Only owners can change ranks. The game server will refuse it from an admin.") : null;

  async function players() {
    const input = h("input", { class: "input", type: "search", placeholder: "Name or UUID", maxlength: 36, autocomplete: "off", spellcheck: "false" });
    const results = h("div");
    const form = h("form", { class: "search", onsubmit: async (e) => { e.preventDefault(); find(); } }, input, h("button", { class: "btn", type: "submit" }, "Find"));
    main.replaceChildren(pageHead("Players", "Players", "Look anyone up: their link, rank, Sapphires and cosmetics. Give or take Sapphires, ranks and cosmetics, always with a reason."), panel(null, [form, results]));
    input.focus();
    let timer = 0;
    input.addEventListener("input", () => { clearTimeout(timer); if (input.value.trim().length >= 2) timer = setTimeout(find, 300); });
    async function find() {
      const q = input.value.trim();
      if (!q) return;
      results.replaceChildren(h("div", { class: "loading" }, "Looking…"));
      const r = await call("GET", `/players?q=${encodeURIComponent(q)}`);
      if (q !== input.value.trim()) return;   // a newer search is on its way
      if (r.httpStatus === 404 && !r.items) return results.replaceChildren(needsUpdate("Finding players"));
      if (!r.ok) return results.replaceChildren(errorBox(r.error));
      if (!r.items.length) return results.replaceChildren(empty(`Nobody called "${q}" has played on MCS.`));
      results.replaceChildren(h("div", { class: "rows", style: "margin-top:.8rem" }, r.items.map((p) => h("div", { class: "row" },
        h("div", { class: "row-main" }, h("div", { class: "row-title" }, head(p.name, 24), p.name, p.online ? h("span", { class: "tag is-good" }, "Online") : null)),
        h("div", { class: "row-actions" }, h("a", { class: "btn btn-dark btn-sm", href: `#/players/${encodeURIComponent(p.uuid)}` }, "Open"))))));
    }
  }

  async function profile(id) {
    main.replaceChildren(pageHead("Players", "Player", null, h("a", { class: "btn btn-dark", href: "#/players" }, "Back")), h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", `/player?id=${encodeURIComponent(id)}`);
    if (r.httpStatus === 404 && !r.player && /update/.test(r.error || "")) return main.replaceChildren(main.firstChild, needsUpdate("Player pages"));
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    const p = r.player;
    const w = p.wallet || {};
    const rk = p.ranks || {};
    const seen = p.online ? "Online now" : p.lastSeen ? `Last seen ${fmtWhen(p.lastSeen)}` : "";
    main.replaceChildren(
      pageHead("Player", h("span", { class: "club" }, head(p.name, 40), p.name), seen, h("a", { class: "btn btn-dark", href: "#/players" }, "Back")),
      h("div", { class: "grid" },
        panel("Sapphires", [
          h("div", { class: "form-row" },
            h("div", { class: "stat" }, h("b", null, Number(w.balance || 0).toLocaleString()), h("span", null, "balance")),
            h("div", { class: "stat" }, h("b", null, Number(w.paid || 0).toLocaleString()), h("span", null, "bought")),
            h("div", { class: "stat" }, h("b", null, Number(w.earned || 0).toLocaleString()), h("span", null, "earned"))),
          w.crates ? h("p", { style: "margin:.6rem 0 0" }, `${w.crates} crate${w.crates === 1 ? "" : "s"} waiting`) : null,
          ME && ME.role === "owner"
            ? h("div", { class: "dlg-foot", style: "justify-content:flex-start;margin-top:1rem" },
              h("button", { class: "btn btn-sm", type: "button", onclick: () => sapphires(p, "give") }, "Give Sapphires"),
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => sapphires(p, "take") }, "Take Sapphires"),
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => fixWallet(p) }, "Fix wallet"))
            : h("p", { class: "row-sub", style: "margin-top:.8rem" }, "Only owners can give or take Sapphires."),
        ], { i: 0 }),
        panel("Rank", [
          h("p", null, "Shows as ", h("b", { style: "color:#fff" }, rankName(rk.shown))),
          rk.staff ? h("p", null, `Staff rank: ${rankName(rk.staff)}`) : null,
          rk.vip ? h("p", null, "Has VIP") : null,
          rk.mvpUntil ? h("p", null, `MVP until ${fmtDay(rk.mvpUntil)}`) : null,
          rk.hidden ? h("p", null, "Hidden from the supporters wall") : null,
          rk.display === false ? h("p", { class: "row-sub" }, "Ranks aren't switched on for players yet, so nobody sees these.") : null,
          ME && ME.role === "owner"
            ? h("div", { class: "dlg-foot", style: "justify-content:flex-start" },
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => rank(p) }, "Change rank"))
            : h("p", { class: "row-sub" }, "Only owners can change ranks."),
        ], { i: 1 }),
        panel("Account", [
          h("p", null, p.discord ? `Discord: linked${p.discordTag ? ` as ${p.discordTag}` : ""}` : "Discord: not linked"),
          p.firstSeen ? h("p", null, `First joined ${fmtDay(p.firstSeen)}`) : null,
          h("p", null, `${(p.cosmetics || []).length} cosmetic${(p.cosmetics || []).length === 1 ? "" : "s"} owned`),
          h("p", { class: "row-sub" }, p.uuid),
          ME && ME.role === "owner"
            ? h("div", { class: "dlg-foot", style: "justify-content:flex-start" },
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => cosmetic(p) }, "Give or take a cosmetic"))
            : h("p", { class: "row-sub" }, "Only owners can give or take cosmetics."),
        ], { i: 2 })),
      panel("Sapphire history", (p.ledger || []).length ? h("div", { class: "rows" }, p.ledger.map((l) => h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "score" }, `${l.amount > 0 ? "+" : ""}${Number(l.amount).toLocaleString()}`), h("span", { class: "tag" }, l.kind || "")),
          h("div", { class: "row-sub" }, h("span", null, l.at ? fmtWhen(l.at) : ""), l.reason ? h("span", null, l.reason) : null, l.by ? h("span", null, l.by) : null)),
        h("span", { class: "row-sub" }, l.paidAfter != null ? `${Number(l.paidAfter + l.earnedAfter).toLocaleString()} after` : "")))) : empty("No Sapphire history yet."), { i: 3 }));
  }

  async function sapphires(p, op) {
    const key = keyId();   // one per click: a re-send changes nothing
    const r = await formDialog({
      title: op === "take" ? `Take Sapphires from ${p.name}` : `Give Sapphires to ${p.name}`, okLabel: op === "take" ? "Take" : "Give", bad: op === "take",
      text: op === "give" ? "They go into the earned part of the wallet. The player is told in game." : "A take never goes below zero.",
      fields: [
        { name: "amount", type: "number", label: "Amount", min: 1, max: 100000, required: true },
        { name: "reason", label: "Reason", maxlength: 120, required: true, placeholder: op === "take" ? "Refunded order 1234" : "Giveaway winner" },
      ],
      submit: (v) => call("POST", "/sapphires", { id: p.uuid, name: p.name, op, amount: Number(v.amount), reason: v.reason, key }),
    });
    if (r) { toast(r.repeat ? "Already done. Nothing changed." : `Done. Balance: ${Number(r.balance || 0).toLocaleString()}`); location.hash = `#/players/${encodeURIComponent(p.uuid)}`; profile(p.uuid); }
  }

  async function rank(p) {
    const key = keyId();   // one per click: a re-send gives nothing twice
    const r = await formDialog({
      title: `Change ${p.name}'s rank`, okLabel: "Change",
      text: ownerOnly(),
      fields: [
        { name: "what", type: "select", label: "Change", options: [
          { value: "give:vip", label: "Give VIP" }, { value: "take:vip", label: "Take VIP" },
          { value: "give:mvp", label: "Give MVP (needs VIP)" }, { value: "take:mvp", label: "Take MVP" },
          { value: "set:owner", label: "Staff rank: Owner" }, { value: "set:admin", label: "Staff rank: Admin" },
          { value: "set:developer", label: "Staff rank: Developer" }, { value: "set:mod", label: "Staff rank: Mod" },
          { value: "set:helper", label: "Staff rank: Helper" }, { value: "set:media", label: "Staff rank: Media" },
          { value: "set:affiliate", label: "Staff rank: Affiliate" }, { value: "set:none", label: "No staff rank" }],
          onchange: null },
        { name: "days", type: "number", label: "MVP days (when giving MVP)", value: "30", min: 1, max: 3650 },
        { name: "reason", label: "Reason", maxlength: 120, required: true },
      ],
      submit: (v) => { const [op, rk] = v.what.split(":"); return call("POST", "/rank", { id: p.uuid, name: p.name, op, rank: rk, days: op === "give" && rk === "mvp" ? Number(v.days) || 30 : undefined, reason: v.reason, key }); },
    });
    if (r) { toast(r.message || "Rank changed."); location.hash = `#/players/${encodeURIComponent(p.uuid)}`; profile(p.uuid); }
  }

  async function cosmetic(p) {
    const cat = await call("GET", "/cosmetics/catalog");
    if (!cat.ok) return toast(cat.error, true);
    const owned = new Set(p.cosmetics || []);
    const TYPES = { trail: "Trails", celebration: "Celebrations", bow: "Bow skins" };
    const sorted = cat.items.slice().sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)));
    const options = sorted.map((c) => ({ value: c.id, label: `${TYPES[c.type] ? TYPES[c.type].slice(0, -1) : c.type}: ${c.name}${c.rarity ? ` (${c.rarity})` : ""}${owned.has(c.id) ? " · owned" : ""}` }));
    const r = await formDialog({
      title: `Cosmetics for ${p.name}`, okLabel: "Do it",
      fields: [
        { name: "op", type: "select", label: "Give or take", options: [{ value: "give", label: "Give" }, { value: "take", label: "Take" }] },
        { name: "cosmetic", type: "select", label: "Cosmetic", options },
        { name: "reason", label: "Reason", maxlength: 120, required: true },
      ],
      submit: (v) => call("POST", "/cosmetics", { id: p.uuid, name: p.name, op: v.op, cosmetic: v.cosmetic, reason: v.reason }),
    });
    if (r) { toast(r.changed === false ? (r.message || "Nothing to change.") : (r.message || "Done.")); location.hash = `#/players/${encodeURIComponent(p.uuid)}`; profile(p.uuid); }
  }

  /* ── Bow skins ────────────────────────────────────────────────── */

  async function bows() {
    main.replaceChildren(pageHead("Cosmetics", "Bow skins", "The custom bow skins: add new ones, upload their four frames, rename them, take them down. The resource pack rebuilds by itself.",
      h("button", { class: "btn", type: "button", onclick: newBow }, "New bow skin")), h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", "/bows");
    if (r.httpStatus === 404 && !r.bows) return main.replaceChildren(main.firstChild, needsUpdate("Managing bow skins here"));
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    const items = r.bows || [];
    const warnings = (r.warnings || []).filter(Boolean);
    main.replaceChildren(...[main.firstChild,
      warnings.length ? panel(null, warnings.map((w) => h("p", { class: "note", style: "margin:.2rem 0" }, String(w)))) : null,
      panel(null, items.length ? h("div", { class: "rows" }, items.map((b) => h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, b.name || b.slug, h("span", { class: "tag" }, b.slug)),
          h("div", { class: "row-sub", style: "margin-top:.5rem;gap:.4rem" }, [0, 1, 2, 3].map((n) => (b.frames && b.frames[n])
            ? h("img", { src: `/api/bows/tex/${encodeURIComponent(b.slug)}/${n}.png?v=${encodeURIComponent(b.stamp || "")}`, width: 48, height: 48, alt: `Frame ${n + 1}`, style: "background:#0a110d;padding:4px" })
            : h("span", { class: "tag", style: "width:48px;height:48px;justify-content:center" }, `${n + 1}?`)))),
        h("div", { class: "row-actions" },
          h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => uploadFrames(b) }, "Upload frames"),
          h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => renameBow(b) }, "Rename"),
          h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => deleteBow(b) }, "Delete"))))) : empty("No bow skins yet."))].filter(Boolean));
  }

  async function newBow() {
    const r = await formDialog({
      title: "New bow skin", okLabel: "Make it",
      text: "Make it, then upload its four frames (the bow from resting to fully drawn).",
      fields: [
        { name: "slug", label: "Folder name", maxlength: 40, required: true, placeholder: "golden_boot", hint: "Letters, numbers, - and _. It can't change later." },
        { name: "name", label: "Name players see", maxlength: 60, placeholder: "Golden Boot" },
        { name: "reason", label: "Reason", maxlength: 120, required: true, placeholder: "Halloween winner's bow" },
      ],
      submit: (v) => /^[a-z0-9_-]{1,40}$/i.test(v.slug) ? call("POST", "/bows/create", { slug: v.slug.toLowerCase(), name: v.name, reason: v.reason }) : { ok: false, error: "The folder name takes only letters, numbers, - and _." },
    });
    if (r) { toast("Made. Now upload its frames."); bows(); }
  }

  async function renameBow(b) {
    const r = await formDialog({
      title: `Rename ${b.name || b.slug}`, okLabel: "Rename",
      fields: [
        { name: "name", label: "Name players see", value: b.name || "", maxlength: 60, required: true },
        { name: "reason", label: "Reason", maxlength: 120, required: true },
      ],
      submit: (v) => call("POST", "/bows/name", { slug: b.slug, name: v.name, reason: v.reason }),
    });
    if (r) { toast("Renamed."); bows(); }
  }

  async function deleteBow(b) {
    const r = await formDialog({
      title: `Delete ${b.name || b.slug}?`, okLabel: "Delete", bad: true,
      text: "Its images are removed and it comes out of the resource pack.",
      fields: [{ name: "reason", label: "Reason", maxlength: 120, required: true }],
      submit: (v) => call("POST", "/bows/delete", { slug: b.slug, reason: v.reason }),
    });
    if (r) { toast("Deleted."); bows(); }
  }

  async function uploadFrames(b) {
    const fileFields = [1, 2, 3, 4].map((n) => ({ name: `f${n}`, type: "file", label: `Frame ${n}${n === 1 ? " (resting)" : n === 4 ? " (fully drawn)" : ""}` }));
    const r = await formDialog({
      title: `Frames for ${b.name || b.slug}`, okLabel: "Upload",
      text: "PNG images. Pick only the frames you're changing.",
      fields: [...fileFields, { name: "reason", label: "Reason", maxlength: 120, required: true }],
      submit: async (v, inputs) => {
        let sent = 0;
        for (const n of [1, 2, 3, 4]) {
          const file = inputs[`f${n}`].files && inputs[`f${n}`].files[0];
          if (!file) continue;
          if (file.size > 256 * 1024) return { ok: false, error: `Frame ${n} is too big (256 KB at most).` };
          let res;
          try {
            res = await fetch(`/api/bows/upload?slug=${encodeURIComponent(b.slug)}&frame=${n}&reason=${encodeURIComponent(v.reason)}`, {
              method: "POST", credentials: "same-origin", headers: { "X-MCS-Admin": "1", "Content-Type": "image/png" }, body: file });
          } catch { return { ok: false, error: "The dashboard can't be reached." }; }
          const out = await res.json().catch(() => ({ ok: false, error: `The dashboard answered ${res.status}.` }));
          if (!out.ok) return { ok: false, error: `Frame ${n}: ${out.error}` };
          sent++;
        }
        return sent ? { ok: true, sent } : { ok: false, error: "Pick at least one frame." };
      },
    });
    if (r) { toast(`Uploaded ${r.sent} frame${r.sent === 1 ? "" : "s"}. The pack rebuilds by itself.`); bows(); }
  }

  /* ── shared by the pages below ────────────────────────────────── */

  // Each page load is numbered: an answer that comes back after another page (or tab) opened is
  // dropped. And a page's timers, stopped by route() when another page opens.
  let pageSeq = 0;
  let leave = null;
  const actionRow = (title, sub, ...actions) => h("div", { class: "row" },
    h("div", { class: "row-main" }, h("div", { class: "row-title" }, title), sub ? h("div", { class: "row-sub" }, h("span", null, sub)) : null),
    h("div", { class: "row-actions" }, actions));
  const reasonField = (placeholder) => ({ name: "reason", label: "Reason", maxlength: 120, required: true, placeholder: placeholder || null });
  // "dashboard:karl (5943...)" -> "karl"; anything else as it is
  const byName = (by) => { const m = /^dashboard:(.*) \(\d+\)$/.exec(String(by || "")); return m ? m[1] : String(by || ""); };

  /* ── Settings: the staff menus' knobs ─────────────────────────── */

  // docs/admin-api.md, "Settings (knobs)": the game server lists the scopes, and every pitch is one
  // (they share the Pitches tab). The hash is #/settings/<scope id>: pitch:<id>, server, sounds...
  let knobTab = "pitch";
  let knobPitch = "";
  let knobScopes = null;

  async function settings(arg) {
    const seq = pageSeq;
    if (arg) {
      const a = decodeURIComponent(arg);
      if (a.startsWith("pitch:")) { knobTab = "pitch"; knobPitch = a.slice(6); } else knobTab = a;
    }
    const top = pageHead("Settings", "Settings", "The same settings as the staff menus in game: change them here or there.");
    main.replaceChildren(top, h("div", { class: "loading" }, "Loading…"));
    if (!knobScopes) {
      const sc = await call("GET", "/knobs");
      if (seq !== pageSeq) return;
      if (sc.httpStatus === 404 && !sc.scopes) return main.replaceChildren(top, needsUpdate("Changing settings here"));
      if (!sc.ok) return main.replaceChildren(top, errorBox(sc.error));
      knobScopes = Array.isArray(sc.scopes) ? sc.scopes : [];
    }
    const pitchScopes = knobScopes.filter((x) => String(x.id).startsWith("pitch:"));
    const tabList = [...(pitchScopes.length ? [{ id: "pitch", name: "Pitches" }] : []), ...knobScopes.filter((x) => !String(x.id).startsWith("pitch:"))];
    if (!tabList.length) return main.replaceChildren(top, panel(null, empty("The game server has no settings to show.")));
    if (!tabList.some((t) => t.id === knobTab)) knobTab = tabList[0].id;
    const bar = panel(null, [h("div", { class: "panel-head" }, h("div", { class: "tabs" }, tabList.map((t) =>
      h("button", { type: "button", "aria-pressed": String(knobTab === t.id), onclick: () => { location.hash = `#/settings/${encodeURIComponent(t.id)}`; } }, t.name || t.id))))]);
    let scope = knobTab;
    if (knobTab === "pitch") {
      if (!pitchScopes.some((p) => p.id === `pitch:${knobPitch}`)) knobPitch = pitchScopes[0].id.slice(6);
      scope = `pitch:${knobPitch}`;
      bar.append(h("label", { class: "field", style: "margin-top:.8rem;max-width:320px" }, h("span", null, "Pitch"),
        h("select", { class: "input", onchange: (e) => { location.hash = `#/settings/${encodeURIComponent(e.target.value)}`; } },
          pitchScopes.map((p) => h("option", { value: p.id, selected: p.id === scope || null }, p.name || p.id.slice(6))))));
    }
    main.replaceChildren(top, bar, h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", `/knobs?scope=${encodeURIComponent(scope)}`);
    if (seq !== pageSeq) return;
    if (!r.ok) return main.replaceChildren(top, bar, errorBox(r.error));
    drawKnobs(top, bar, scope, r.knobs || []);
  }

  // the 16 chat colours, for a colour knob's swatch (its options are names or #hex)
  const MC_COLOURS = { black: "#000000", dark_blue: "#0000aa", dark_green: "#00aa00", dark_aqua: "#00aaaa", dark_red: "#aa0000", dark_purple: "#aa00aa",
    gold: "#ffaa00", gray: "#aaaaaa", grey: "#aaaaaa", dark_gray: "#555555", dark_grey: "#555555", blue: "#5555ff", green: "#55ff55", aqua: "#55ffff",
    red: "#ff5555", light_purple: "#ff55ff", yellow: "#ffff55", white: "#ffffff" };
  const swatchOf = (v) => { const c = String(v || "").trim(); return /^#[0-9a-f]{6}$/i.test(c) ? c : MC_COLOURS[c.toLowerCase().replace(/[\s-]+/g, "_")] || null; };
  const optionOf = (o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) });
  const nice = (t) => String(t).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  /** A datetime-local value as an ISO time with this browser's offset ("2026-10-24T22:00:00-04:00"); "" when empty. */
  function isoLocal(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d)) return "";
    const off = -d.getTimezoneOffset();
    return `${localInput(d.getTime())}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }

  /** The control for one knob: { el, get(), on(fn), show(value)? }. Values go to the server as its docs say. */
  function knobInput(k, locked) {
    const v = k.value;
    const dis = locked || k.inWorld || null;
    const withUnit = (el) => (k.unit ? h("span", { class: "knob-in" }, el, h("span", { class: "knob-unit" }, k.unit)) : el);
    if (k.type === "bool") {
      const on = v === true || v === "true";
      const i = h("input", { type: "checkbox", checked: on || null, disabled: dis });
      const label = h("span", null, on ? "On" : "Off");
      return { el: h("label", { class: "check" }, i, label), get: () => i.checked, show: (x) => (x ? "On" : "Off"),
        on: (fn) => i.addEventListener("change", () => { label.textContent = i.checked ? "On" : "Off"; fn(); }) };
    }
    if (k.type === "choice" || k.type === "enum" || k.type === "colour") {
      const opts = (k.options || []).map(optionOf);
      if (v != null && v !== "" && !opts.some((o) => o.value === String(v))) opts.unshift({ value: String(v), label: String(v) });
      const sel = h("select", { class: "input", disabled: dis }, opts.map((o) =>
        h("option", { value: o.value, selected: o.value === String(v ?? "") || null }, k.type === "colour" || /^[a-z][a-z0-9_]*$/.test(o.label) ? nice(o.label) : o.label)));
      if (k.type !== "colour") return { el: withUnit(sel), get: () => sel.value, on: (fn) => sel.addEventListener("change", fn) };
      const sw = h("i", { class: "swatch" });
      const paint = () => { const c = swatchOf(sel.value); sw.style.background = c || "transparent"; sw.hidden = !c; };
      paint();
      return { el: h("span", { class: "knob-in" }, sw, sel), get: () => sel.value, show: (x) => nice(x), on: (fn) => sel.addEventListener("change", () => { paint(); fn(); }) };
    }
    if (k.type === "int" || k.type === "number") {
      const i = h("input", { class: "input", type: "number", value: v ?? "", min: k.min ?? null, max: k.max ?? null, step: k.step ?? (k.type === "int" ? 1 : "any"), disabled: dis, inputmode: k.type === "int" ? "numeric" : "decimal" });
      return { el: withUnit(i), get: () => (i.value === "" ? "" : Number(i.value)), on: (fn) => i.addEventListener("input", fn) };
    }
    if (k.type === "time") {
      const d = v ? new Date(v) : null;
      const i = h("input", { class: "input", type: "datetime-local", value: d && !isNaN(d) ? localInput(d.getTime()) : "", disabled: dis });
      const zone = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").replace(/_/g, " ");
      return { el: h("span", { class: "knob-list" }, i, h("small", null, zone ? `Your time (${zone}). Empty is not set.` : "Your time. Empty is not set.")), get: () => isoLocal(i.value), show: (x) => (x ? fmtWhen(new Date(x).getTime()) : "Not set"), on: (fn) => i.addEventListener("input", fn) };
    }
    if (k.type === "list") {
      const items = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
      const t = h("textarea", { class: "input", rows: Math.min(6, Math.max(2, Math.ceil(items.join(", ").length / 44))), disabled: dis, spellcheck: "false" });
      t.value = items.join(", ");
      return { el: h("span", { class: "knob-list" }, t, h("small", null, "Comma separated")),
        get: () => t.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(","),
        show: (x) => (x ? x.split(",").join(", ") : "(empty)"), on: (fn) => t.addEventListener("input", fn) };
    }
    const i = h("input", { class: "input", type: "text", value: v ?? "", maxlength: k.max ?? null, disabled: dis, autocomplete: "off", spellcheck: "false" });
    return { el: withUnit(i), get: () => i.value, on: (fn) => i.addEventListener("input", fn) };
  }

  /** True when a control's value is what the server has: an edit put back drops out of the save. */
  function sameValue(k, x) {
    if (k.type === "bool") return x === (k.value === true || k.value === "true");
    if (k.type === "time") return (x ? new Date(x).getTime() : 0) === (k.value ? new Date(k.value).getTime() : 0);
    if (k.type === "list") return x === (Array.isArray(k.value) ? k.value : String(k.value ?? "").split(",")).map((t) => String(t).trim()).filter(Boolean).join(",");
    return String(x) === String(k.value ?? "");
  }

  function drawKnobs(top, bar, scope, knobs) {
    const owner = ME && ME.role === "owner";
    const changed = new Map();
    const groups = new Map();
    for (const k of knobs) {
      const g = k.group || "Settings";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
    const saveBar = h("div", { class: "tbar" }, h("span", null, "No changes"), h("div", { class: "head-actions" },
      h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => settings() }, "Discard"),
      h("button", { class: "btn btn-sm", type: "button", disabled: true, onclick: save }, "Save")));
    const mark = () => {
      saveBar.classList.toggle("is-dirty", changed.size > 0);
      saveBar.firstChild.textContent = changed.size ? `${changed.size} unsaved change${changed.size === 1 ? "" : "s"}` : "No changes";
      saveBar.querySelector(".btn:not(.btn-dark)").disabled = !changed.size;
    };
    const findable = [];
    let i = 0;
    const panels = [...groups].map(([g, list]) => {
      const rows = list.map((k) => {
        const locked = k.level === "owner" && !owner;
        const input = knobInput(k, locked);
        input.on(() => {
          const value = input.get();
          if (sameValue(k, value)) changed.delete(k.key); else changed.set(k.key, { k, value, input });
          mark();
        });
        const notes = [k.help || null, k.needsReload ? "Takes effect after a reload." : null, k.inWorld ? "Set in game (it needs someone standing there)." : null, locked ? "Owners only." : null].filter(Boolean);
        const row = h("div", { class: k.type === "list" ? "row is-wide" : "row" },
          h("div", { class: "row-main" }, h("div", { class: "row-title" }, k.label || k.key),
            notes.length ? h("div", { class: "row-sub" }, notes.map((n) => h("span", null, n))) : null),
          h("div", { class: "row-actions knob-cell" }, input.el));
        return { row, text: [k.label, k.key, k.help, g].filter(Boolean).join(" ").toLowerCase() };
      });
      const p = panel(g, h("div", { class: "rows" }, rows.map((x) => x.row)), { i: i++ });
      findable.push({ p, rows });
      return p;
    });
    // a big scope (Sounds has hundreds) gets a finder
    let finder = null;
    if (knobs.length > 12) {
      const box = h("input", { class: "input", type: "search", placeholder: `Find one of ${knobs.length} settings`, autocomplete: "off", spellcheck: "false", "aria-label": "Find a setting" });
      const none = h("p", { class: "empty", hidden: true }, "No setting matches that.");
      box.addEventListener("input", () => {
        const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
        let any = 0;
        for (const f of findable) {
          let shown = 0;
          for (const x of f.rows) { const ok = words.every((w) => x.text.includes(w)); x.row.hidden = !ok; if (ok) shown++; }
          f.p.hidden = !shown;
          any += shown;
        }
        none.hidden = !!any;
      });
      finder = h("div", { class: "knob-find" }, box, none);
    }
    main.replaceChildren(top, bar, ...[finder, ...(panels.length ? panels : [panel(null, empty("Nothing to set here."))]), saveBar].filter(Boolean));

    async function save() {
      const r = await formDialog({
        title: "Save these settings?", okLabel: "Save",
        text: h("div", null, [...changed.values()].map(({ k, value, input }) =>
          h("p", { class: "row-sub" }, `${k.label || k.key}: ${input.show ? input.show(value) : value === "" ? "(empty)" : value}${k.unit && !input.show ? ` ${k.unit}` : ""}`))),
        fields: [reasonField("Longer halves for the league")],
        submit: async (v) => {
          for (const { k, value } of [...changed.values()]) {
            const res = await call("POST", "/knobs", { scope, key: k.key, value, reason: v.reason });
            if (!res.ok) return { ok: false, error: `${k.label || k.key}: ${res.error}` };
            changed.delete(k.key);
          }
          return { ok: true };
        },
      });
      if (r) { toast("Saved."); settings(); } else mark();
    }
  }

  /* ── Server: who's on, the pitches, the pack; restart and reload ── */

  const leftText = (at) => { const t = Math.max(0, Math.round((at - Date.now()) / 1000)); return t >= 60 ? `${Math.floor(t / 60)} min ${pad(t % 60)} s` : `${t} s`; };
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

  // quiet: a refresh (the timer or the button), drawn over the page as it is, never replaying its rise
  async function server(quiet) {
    const seq = pageSeq;
    const top = pageHead("Server", "Server", "Who's on, what every pitch is doing and the resource pack. Restart, reload or send the pack again from here.",
      h("button", { class: "btn btn-dark", type: "button", onclick: () => server(true) }, "Refresh"));
    if (!quiet) main.replaceChildren(top, h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", "/server");
    if (seq !== pageSeq) return;
    if (leave) leave();
    const poll = setTimeout(() => server(true), document.hidden ? 30000 : 10000);
    const tick = setInterval(() => { for (const el of $$("[data-left]", main)) el.textContent = leftText(Number(el.dataset.left)); }, 1000);
    leave = () => { clearTimeout(poll); clearInterval(tick); };
    if (r.httpStatus === 404 && !r.pitches) { leave(); leave = null; return main.replaceChildren(top, needsUpdate("The server page")); }
    const note = $("[data-server-note]", main);
    if (!r.ok) {
      if (quiet && note) { note.textContent = `Not answering right now (restarting?). Last heard ${note.dataset.at || ""}`; note.classList.add("is-bad"); return; }
      return main.replaceChildren(top, errorBox(r.error));
    }
    // a refresh redraws only when something changed, and never under an open dialog, so the
    // buttons stay put (and keep focus) between changes
    const sig = JSON.stringify(r);
    if (quiet && note && (sig === serverSig || dlg.open)) {
      if (sig === serverSig) { const at = clock(Date.now()); note.textContent = `Updated ${at}. It refreshes by itself.`; note.dataset.at = at; note.classList.remove("is-bad"); }
      return;
    }
    serverSig = sig;
    if (quiet) settle();
    drawServer(top, r);
  }
  let serverSig = "";

  function drawServer(top, st) {
    const players = Array.isArray(st.players) ? st.players : [];
    const ps = Array.isArray(st.pitches) ? st.pitches : [];
    const inUse = ps.filter((p) => p.running || p.players > 0 || p.countdown >= 0);
    const pk = st.pack || null;
    const rs = st.restart || null;
    const TYPE = { quick: "Quick", scrim: "Scrim", match: "Match", knockout: "Knockout", ranked: "Ranked" };
    const heard = clock(Date.now());
    main.replaceChildren(...[top,
      rs ? panel(null, h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "dot is-live" }), h("span", null, "Restarting in ", h("b", { "data-left": rs.at }, leftText(rs.at)))),
          h("div", { class: "row-sub" }, h("span", null, `At ${clock(rs.at)}`), rs.by ? h("span", null, `Asked by ${byName(rs.by)}`) : null)),
        h("div", { class: "row-actions" }, h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: cancelRestart }, "Call it off")))) : null,
      h("div", { class: "grid" },
        panel("Right now", [
          h("div", { class: "form-row" },
            h("div", { class: "stat" }, h("b", null, players.length), h("span", null, players.length === 1 ? "player on" : "players on")),
            h("div", { class: "stat" }, h("b", null, `${inUse.length}/${ps.length}`), h("span", null, "pitches in use")),
            h("div", { class: "stat" }, h("b", null, pk ? `${pk.loaded}/${pk.online}` : "?"), h("span", null, "have the pack"))),
          h("p", { class: "row-sub server-note", "data-server-note": "", "data-at": heard, style: "margin-top:.8rem" }, `Updated ${heard}. It refreshes by itself.`),
        ], { i: 0, aside: st.busy ? h("span", { class: "tag is-warn" }, "Something's on") : h("span", { class: "tag is-good" }, "All quiet") }),
        panel("Restart and reload", h("div", { class: "rows" },
          actionRow("Restart the server", "Everyone is told, with a countdown. The host starts it again, back in about a minute.",
            h("button", { class: "btn btn-sm", type: "button", disabled: rs ? true : null, onclick: () => restartServer(st) }, "Restart")),
          actionRow("Reload the config", st.busy ? "Not while anything is on: a reload ends every match. Wait until every pitch is idle." : "Reads config.yml again. It would end every match, so it only works while every pitch is idle.",
            h("button", { class: "btn btn-dark btn-sm", type: "button", disabled: st.busy ? true : null, onclick: reloadConfig }, "Reload")),
          actionRow("Send the pack again", "Sends the resource pack to everyone online once more, for when it didn't load.",
            h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: resendPack }, "Send"))), { i: 1 })),
      h("div", { class: "grid" },
        panel("Pitches", ps.length ? h("div", { class: "rows" }, ps.map((p) => h("div", { class: "row" },
          h("div", { class: "row-main" },
            h("div", { class: "row-title" }, p.name || p.id, p.type ? h("span", { class: "tag" }, TYPE[p.type] || p.type) : null,
              p.running ? h("span", { class: "tag is-live" }, "Match on") : p.countdown >= 0 ? h("span", { class: "tag is-warn" }, `Starts in ${p.countdown} s`) : null),
            h("div", { class: "row-sub" }, h("span", null, `${p.players || 0} playing`), p.waiting ? h("span", null, `${p.waiting} waiting`) : null)),
          h("a", { class: "btn btn-dark btn-sm", href: `#/settings/${encodeURIComponent("pitch:" + p.id)}` }, "Settings")))) : empty("No pitches."), { i: 2 }),
        panel(`Players on (${players.length})`, players.length ? h("div", { class: "rows" }, players.map((p) => h("div", { class: "row" },
          h("div", { class: "row-main" }, h("div", { class: "row-title" }, head(p.name, 24), p.name, p.pitch ? h("span", { class: "tag" }, p.pitch) : null)),
          h("a", { class: "btn btn-dark btn-sm", href: `#/players/${encodeURIComponent(p.uuid)}` }, "Open")))) : empty("Nobody's on right now."), { i: 3 })),
      pk ? panel("Resource pack", [
        h("p", null, `${pk.loaded} of ${pk.online} online have it loaded. ${pk.required ? "Players must accept it." : "Players may turn it down."}`),
        h("p", { class: "row-sub", style: "overflow-wrap:anywhere" }, `From ${pk.source}${pk.url ? `: ${pk.url}` : ""}`),
      ], { i: 4 }) : null].filter(Boolean));
  }

  async function restartServer(st) {
    const r = await formDialog({
      title: "Restart the server?", okLabel: "Restart", bad: true,
      text: st.busy ? h("p", { class: "note" }, "Something is on right now: a match, players on a pitch or a countdown. Tick the box to restart anyway.")
        : "Everyone online is told and sees the countdown.",
      fields: [
        { name: "delay", type: "select", label: "When", value: "60", options: [["10", "In 10 seconds"], ["30", "In 30 seconds"], ["60", "In 1 minute"], ["120", "In 2 minutes"], ["300", "In 5 minutes"], ["600", "In 10 minutes"]].map(([value, label]) => ({ value, label })) },
        st.busy ? { name: "force", type: "checkbox", label: "Restart even though something's on", value: false } : null,
        reasonField("Plugin update"),
      ].filter(Boolean),
      submit: (v) => call("POST", "/server/restart", { delay: Number(v.delay), force: v.force === true, reason: v.reason }),
    });
    if (r) { toast(r.message || "The restart is counting down."); server(true); }
  }

  async function cancelRestart() {
    const r = await formDialog({ title: "Call off the restart?", okLabel: "Call it off", text: "Players are told it's off.", fields: [reasonField("Not needed after all")],
      submit: (v) => call("POST", "/server/restart/cancel", { reason: v.reason }) });
    if (r) { toast(r.message || "Called off."); server(true); }
  }

  async function reloadConfig() {
    const r = await formDialog({ title: "Reload the config?", okLabel: "Reload", text: "The game server reads config.yml again. It's refused if a match starts in the meantime.", fields: [reasonField("Edited config.yml")],
      submit: (v) => call("POST", "/server/reload", { reason: v.reason }) });
    if (r) { toast(r.message || "Config reloaded."); server(true); }
  }

  async function resendPack() {
    const r = await formDialog({ title: "Send the pack again?", okLabel: "Send", text: "Everyone online gets the resource pack prompt once more.", fields: [reasonField("Players had no textures")],
      submit: (v) => call("POST", "/server/pack/resend", { reason: v.reason }) });
    if (r) { toast(r.message || "Sent."); server(true); }
  }

  /* ── Wallet tools (owners): store orders and wallet repairs ────── */

  async function wallet() {
    const seq = pageSeq;
    const input = h("input", { class: "input", type: "search", placeholder: "Order, line or pretty id", maxlength: 80, autocomplete: "off", spellcheck: "false", "aria-label": "Order, line or pretty id" });
    const out = h("div");
    const form = h("form", { class: "search", onsubmit: (e) => { e.preventDefault(); look(); } }, input, h("button", { class: "btn", type: "submit" }, "Look up"));
    const tool = (title, text, label, cls, fn, i) => panel(title, [h("p", null, text),
      h("div", { class: "dlg-foot", style: "justify-content:flex-start;margin-top:.9rem" }, h("button", { class: `btn btn-sm ${cls}`, type: "button", onclick: () => fn() }, label))], { i });
    main.replaceChildren(
      pageHead("Sapphires", "Wallet tools", "Store orders and wallet repairs. Every change needs a reason, tells the player in game and goes in the Activity log."),
      panel("Look up a store order", [form, out], { i: 0 }),
      h("div", { class: "grid" },
        tool("Add an order by hand", "For a PayNow order whose command never reached the game. Each line counts once: the same line again changes nothing.", "Add an order", "", () => storeGrant(), 1),
        tool("Take an order back", "A refund, chargeback or revoke. Each line is taken back once, and a line that hasn't arrived yet is stopped from arriving later.", "Take one back", "btn-bad", () => storeReverse(), 2),
        tool("Fix a wallet", "Bring a wallet that went below zero back to zero so its owner can spend again, or reset both parts to zero.", "Fix a wallet", "btn-dark", () => fixWallet(), 3)));
    input.focus();

    async function look() {
      const term = input.value.trim();
      if (!term) return;
      out.replaceChildren(h("div", { class: "loading" }, "Looking…"));
      const r = await call("GET", `/wallet/audit?q=${encodeURIComponent(term)}`);
      if (seq !== pageSeq || term !== input.value.trim()) return;
      if (r.httpStatus === 404 && !r.lines) return out.replaceChildren(needsUpdate("The wallet tools"));
      if (!r.ok) return out.replaceChildren(errorBox(r.error));
      const lines = Array.isArray(r.lines) ? r.lines : [];
      const g = r.grant || null;
      const lineId = (lines.find((l) => l.line) || {}).line || term;
      const who = g && (lines.find((l) => l.uuid === g.uuid && l.name) || {}).name;
      if (!lines.length && !g && !r.tombstone) return out.replaceChildren(empty(`Nothing in the wallet's books for "${term}".`));
      out.replaceChildren(h("div", { style: "margin-top:.9rem" },
        g ? h("div", { class: "row" },
          h("div", { class: "row-main" },
            h("div", { class: "row-title" }, h("span", { class: "score" }, `+${Number(g.amount || 0).toLocaleString()}`), who || g.uuid,
              g.starter ? h("span", { class: "tag" }, "Starter pack") : null,
              g.reversed ? h("span", { class: "tag is-bad" }, `Taken back: ${g.reverseKind || "?"}`) : h("span", { class: "tag is-good" }, "In their wallet")),
            h("div", { class: "row-sub" }, g.at ? h("span", null, `Arrived ${fmtWhen(g.at)}`) : null,
              g.reversed && g.reversedAt ? h("span", null, `Taken back ${fmtWhen(g.reversedAt)}${g.reversedPaid != null ? ` (${Number(g.reversedPaid).toLocaleString()} came off)` : ""}`) : null)),
          h("div", { class: "row-actions" }, g.reversed ? null : h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => storeReverse(lineId, look) }, "Take it back"))) : null,
        r.tombstone ? h("p", { class: "note", style: "margin:.6rem 0" }, `Taken back before it arrived, so it can't arrive later: ${r.tombstone}`) : null,
        lines.length ? h("div", { class: "rows" }, lines.map((l) => {
          const d = Number(l.delta ?? l.amount ?? 0);
          return h("div", { class: "row" },
            h("div", { class: "row-main" },
              h("div", { class: "row-title" }, h("span", { class: "score" }, `${d > 0 ? "+" : ""}${d.toLocaleString()}`), h("span", { class: "tag" }, l.kind || ""), l.name || l.uuid || ""),
              h("div", { class: "row-sub" }, l.at ? h("span", null, fmtWhen(l.at)) : null, l.reason ? h("span", null, l.reason) : null, l.by ? h("span", null, byName(l.by)) : null,
                h("span", null, [l.line && `line ${l.line}`, l.order && `order ${l.order}`, l.pretty].filter(Boolean).join(" · ")))),
            l.uuid ? h("a", { class: "btn btn-dark btn-sm", href: `#/players/${encodeURIComponent(l.uuid)}` }, "Player") : h("span"));
        })) : null));
    }
  }

  async function storeGrant() {
    const r = await formDialog({
      title: "Add a store order by hand", okLabel: "Add it",
      text: "Copy the ids from the order in PayNow, so the books match PayNow.",
      fields: [
        { name: "id", label: "Player", maxlength: 36, required: true, placeholder: "Name or UUID" },
        { type: "row", fields: [
          { name: "amount", type: "number", label: "Sapphires", min: 1, max: 1000000, required: true },
          { name: "line", label: "Line id", maxlength: 64, required: true }] },
        { type: "row", fields: [
          { name: "order", label: "Order id", maxlength: 64, placeholder: "If there is one" },
          { name: "pretty", label: "Pretty id", maxlength: 64, placeholder: "If there is one" }] },
        { name: "starter", type: "checkbox", label: "It's the Starter Pack (once per player)", value: false },
        reasonField("PayNow's command never arrived"),
      ],
      submit: (v) => (/^[A-Za-z0-9_-]{1,64}$/.test(v.line)
        ? call("POST", "/wallet/grant", { id: v.id, name: v.id, amount: Number(v.amount), line: v.line, order: v.order, pretty: v.pretty, starter: v.starter === true, reason: v.reason })
        : { ok: false, error: "The line id takes only letters, numbers, - and _." }),
    });
    if (r) toast(r.repeat ? "That line was already in. Nothing changed." : (r.message || "Added."));
  }

  async function storeReverse(line, then) {
    const r = await formDialog({
      title: "Take a store order back", okLabel: "Take it back", bad: true,
      text: "Its Sapphires come off the player's wallet. If they've spent them it goes below zero, and spending stops until it's fixed.",
      fields: [
        { name: "line", label: "Line id", value: line || "", maxlength: 64, required: true },
        { name: "kind", type: "select", label: "Why", options: [{ value: "refund", label: "Refund" }, { value: "chargeback", label: "Chargeback" }, { value: "revoke", label: "Revoke" }] },
        reasonField("Refunded in PayNow"),
      ],
      submit: (v) => call("POST", "/wallet/reverse", { line: v.line, kind: v.kind, reason: v.reason }),
    });
    if (r) { toast(r.repeat ? "Already taken back. Nothing changed." : (r.message || "Taken back.")); if (then) then(); }
  }

  async function fixWallet(p) {
    const key = keyId();   // one per click: a re-send changes nothing
    const r = await formDialog({
      title: p ? `Fix ${p.name}'s wallet` : "Fix a wallet", okLabel: "Fix it", bad: true,
      fields: [
        p ? null : { name: "id", label: "Player", maxlength: 36, required: true, placeholder: "Name or UUID" },
        { name: "what", type: "select", label: "What to do", options: [{ value: "unpause", label: "Clear the debt: only what's below zero" }, { value: "reset", label: "Reset everything to zero" }] },
        reasonField("Chargeback settled"),
      ].filter(Boolean),
      submit: (v) => call("POST", v.what === "reset" ? "/wallet/reset" : "/wallet/unpause", { id: p ? p.uuid : v.id, name: p ? p.name : v.id, key, reason: v.reason }),
    });
    if (r) { toast(r.repeat ? "Already done. Nothing changed." : (r.message || "Done.")); if (p) profile(p.uuid); }
  }

  /* ── Activity ─────────────────────────────────────────────────── */

  function activityRow(a) {
    return h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("div", { class: "row-title" }, (a.who && a.who.name) || "?", h("span", { class: "vs" }, a.action), a.ok ? null : h("span", { class: "tag is-bad" }, "refused")),
        h("div", { class: "row-sub" }, h("span", null, `${fmtWhen(a.at)} (${ago(a.at)})`), a.detail ? h("span", null, a.detail) : null)),
      h("span"));
  }

  async function activity() {
    main.replaceChildren(pageHead("Activity", "Activity", "Everything done in the dashboard, newest first, with who did it. Kept for 90 days."), h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", "/activity");
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    main.replaceChildren(main.firstChild, panel(null, r.items.length ? h("div", { class: "rows" }, r.items.map(activityRow)) : empty("Nothing yet.")));
  }

  /* ── the router ───────────────────────────────────────────────── */

  const ROUTES = { "": home, fixtures, matches, reports, tiers, players, wallet, bows, settings, server, activity };

  // A page rises in when it's opened. The first click or key inside it ends that, so
  // the redraws a button causes (a tab, a save, a move) don't replay the animation.
  const settle = () => main.classList.remove("is-entering");
  main.addEventListener("pointerdown", settle, true);
  main.addEventListener("keydown", settle, true);
  dlg.addEventListener("pointerdown", settle, true);

  let arrived = false;
  function route() {
    pageSeq++;
    if (leave) { leave(); leave = null; }
    // the page rises in once, when the dashboard first opens: never on a section switch
    if (!arrived) { main.classList.add("is-entering"); arrived = true; }
    const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
    const page = ROUTES[name] ? name : "";
    $$("[data-route]").forEach((a) => (a.dataset.route === page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (tierState && tierState.dirty && page !== "tiers") toast("Your tier list changes aren't saved yet: they're still there in Tier list.");
    // #/players/<uuid or name> is a player's page
    if (page === "players" && arg) profile(decodeURIComponent(arg));
    else if (page === "settings") settings(arg);
    else ROUTES[page]();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => { if (tierState && tierState.dirty) { e.preventDefault(); e.returnValue = ""; } });

  (async () => {
    await loadMe();
    route();
    refreshReportCount();
    // "soon" comes off Players and Bow skins once the dashboard holds the game server's admin token
    const st = await call("GET", "/status");
    if (st.ok && st.admin) $$("[data-soon]").forEach((el) => el.remove());
  })();
})();
