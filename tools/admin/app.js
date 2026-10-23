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
   * onopen(inputs) runs once it's showing (a live preview); alone: one button, for a result.
   */
  function formDialog({ title, text, fields = [], okLabel = "Save", bad = false, alone = false, onopen, submit }) {
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
          alone ? null : h("button", { class: "btn btn-dark", type: "button", value: "cancel", onclick: () => dlg.close("cancel") }, "Cancel"),
          h("button", { class: bad ? "btn btn-bad" : "btn", type: "submit", "data-ok": true }, okLabel)));
      function field(f) {
        let input;
        if (f.type === "player") return playerField(f, inputs);
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
        okBtn.textContent = "Working…";
        errEl.hidden = true;
        const r = submit ? await submit(values, inputs) : { ok: true };
        okBtn.disabled = false;
        okBtn.textContent = okLabel;
        if (r && r.ok === false) { errEl.textContent = r.error || "That didn't work."; errEl.hidden = false; return; }
        dlg.close("ok");
        resolve(r || { ok: true });
      });
      // a close event arrives a moment after close(): when a dialog opens straight after another
      // (a preview, then its "are you sure?"), the first one's event lands while this one is open
      dlg.onclose = () => { if (!dlg.open && dlg.returnValue !== "ok") resolve(null); };
      dlg.returnValue = "";
      dlg.showModal();
      if (onopen) onopen(inputs);
      const first = form.querySelector("input:not([type=checkbox]), select, textarea");
      if (first) first.focus();
    });
  }
  const confirmBox = (title, text, okLabel, bad = true) => formDialog({ title, text, okLabel, bad, submit: async () => ({ ok: true }) });

  /**
   * A player picker for formDialog: type a name, pick from everyone the game server has seen. Its
   * value is "uuid|name" once one is picked, or just what was typed (resolvePlayer settles that).
   */
  function playerField(f, inputs) {
    const box = h("input", { class: "input", type: "search", name: f.name, placeholder: f.placeholder || "Name or UUID", maxlength: 36, autocomplete: "off", spellcheck: "false", required: f.required || null, "aria-label": f.label });
    const list = h("div", { class: "pick" });
    const picked = { uuid: (f.value && f.value.uuid) || "", name: (f.value && f.value.name) || "" };
    box.value = picked.name;
    let timer = 0, asked = 0;
    box.addEventListener("input", () => {
      picked.uuid = "";
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = box.value.trim();
        const mine = ++asked;
        if (q.length < 2) return list.replaceChildren();
        const r = await call("GET", `/players?q=${encodeURIComponent(q)}`);
        if (mine !== asked) return;   // a newer search is on its way
        list.replaceChildren(...(r.ok ? r.items : []).slice(0, 6).map((p) => h("button", { class: "pick-item", type: "button",
          onclick: () => { picked.uuid = p.uuid; picked.name = p.name; box.value = p.name; list.replaceChildren(); } },
          head(p.name, 20), h("span", null, p.name), p.online ? h("span", { class: "tag is-good" }, "Online") : null)));
      }, 250);
    });
    inputs[f.name] = { type: "player", get value() { return picked.uuid ? `${picked.uuid}|${picked.name}` : box.value; } };
    // a div, not a label: a click on a pick must stay on the pick
    return h("div", { class: "field", "data-field": f.name }, h("span", null, f.label), box, list, f.hint ? h("small", null, f.hint) : null);
  }

  const isUuid = (s) => /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(String(s || "").trim());
  /** A player field's value as { uuid, name }, looking a typed name up; or { error }. */
  async function resolvePlayer(v) {
    const [a, b] = String(v || "").split("|");
    if (b && isUuid(a)) return { uuid: a, name: b };
    const typed = a.trim();
    if (!typed) return { error: "Pick a player." };
    const r = await call("GET", `/players?q=${encodeURIComponent(typed)}`);
    if (!r.ok) return { error: r.error };
    const bare = (x) => String(x).replace(/-/g, "").toLowerCase();
    const hit = (r.items || []).find((p) => (isUuid(typed) ? bare(p.uuid) === bare(typed) : p.name.toLowerCase() === typed.toLowerCase()));
    return hit ? { uuid: hit.uuid, name: hit.name } : { error: `Nobody called "${typed}" has played on MCS. Pick them from the list.` };
  }

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

    const [status, fx, reports, act, srv] = await Promise.all([call("GET", "/status"), call("GET", "/fixtures"), call("GET", "/reports?status=open"), call("GET", "/activity"), call("GET", "/server")]);

    const server = status.ok && status.server;
    grid.append(panel("Game server", [
      h("p", null, h("span", { class: server ? "dot" : "dot is-down" }), server ? "Online and answering" : "Not answering right now"),
      srv.ok && srv.pack && srv.pack.stale === true ? staleNote() : null,
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
  const REASONS = { CHEATING: "Cheating", CHAT: "Chat", VOICE: "Voice chat", TROLLING: "Trolling", OTHER: "Other" };

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
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => cosmetic(p) }, "Give or take a cosmetic"),
              h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => mergeAccounts(p) }, "Merge accounts"),
              h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => statsReset(p) }, "Wipe career"))
            : h("p", { class: "row-sub" }, "Only owners can give or take cosmetics."),
        ], { i: 2 }),
        rankedPanel(p, 3)),
      panel("Sapphire history", (p.ledger || []).length ? h("div", { class: "rows" }, p.ledger.map((l) => h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "score" }, `${l.amount > 0 ? "+" : ""}${Number(l.amount).toLocaleString()}`), h("span", { class: "tag" }, l.kind || "")),
          h("div", { class: "row-sub" }, h("span", null, l.at ? fmtWhen(l.at) : ""), l.reason ? h("span", null, l.reason) : null, l.by ? h("span", null, l.by) : null)),
        h("span", { class: "row-sub" }, l.paidAfter != null ? `${Number(l.paidAfter + l.earnedAfter).toLocaleString()} after` : "")))) : empty("No Sapphire history yet."), { i: 4 }));
  }

  /** The player's ranked lines (docs/admin-api.md: null while ranked isn't running). */
  function rankedPanel(p, i) {
    const rk = p.ranked;
    if (rk === undefined) return null;   // a game server from before the ranked block
    if (rk === null) return panel("Ranked", empty("Ranked isn't running."), { i });
    const line = (q) => {
      const x = rk[q];
      return actionRow(q, x ? `${x.elo} Elo · ${plural(x.games, "game")} · ${x.wins} W ${x.losses} L${x.leaves ? ` · left ${plural(x.leaves, "time")}` : ""}` : "No games yet");
    };
    return panel("Ranked", [
      h("div", { class: "rows" }, line("3v3"), line("4v4")),
      rk.queued ? h("p", null, h("span", { class: "tag is-live" }, "In the queue now")) : null,
      rk.cooldownUntil > Date.now() ? h("p", { class: "row-sub" }, `Leaver cooldown until ${fmtWhen(rk.cooldownUntil)}`) : null,
      rk.blocked ? h("p", { class: "note" }, `A reset would be refused: ${rk.blocked}`) : null,
      ME && ME.role === "owner" ? buttons(h("button", { class: "btn btn-dark btn-sm", type: "button", disabled: rk.blocked ? true : null,
        onclick: async () => { if (await resetRating(p)) profile(p.uuid); } }, "Reset rating")) : null,
    ], { i, aside: h("a", { href: "#/ranked" }, "Ladders") });
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
      r.stale === true ? panel(null, staleNote()) : null,
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
  const stat = (big, label) => h("div", { class: "stat" }, h("b", null, String(big)), h("span", null, label));
  const plural = (n, word, many) => `${Number(n).toLocaleString()} ${n === 1 ? word : many || word + "s"}`;
  // a panel that explains one tool, with the button that opens it
  const toolPanel = (title, text, label, cls, fn, i) => panel(title, [h("p", null, text),
    h("div", { class: "dlg-foot", style: "justify-content:flex-start;margin-top:.9rem" }, h("button", { class: `btn btn-sm ${cls}`, type: "button", onclick: () => fn() }, label))], { i });
  const buttons = (...kids) => h("div", { class: "dlg-foot", style: "justify-content:flex-start;margin-top:.9rem" }, kids);
  const HEX = /^#[0-9a-f]{6}$/i;
  // The server built a pack that players don't get yet: a bow change nobody published. Until it
  // is, new bows don't show and the painted menus fall back to plain (the plugin's pack.stale).
  const staleNote = () => h("p", { class: "err" }, h("b", null, "Players have an old pack. "),
    "A bow change built a new one that hasn't been published, so new bows don't show and menus are plain until it is. To publish: scripts/push-pack.sh on Brenn's PC.");

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
  // "DARK_BLUE" or "dark_blue" -> "Dark blue"
  const nice = (t) => String(t).replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

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
      pk && pk.stale === true ? panel(null, staleNote()) : null,
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
        pk.built ? h("p", { class: "row-sub" }, `Built here ${String(pk.built).slice(0, 8)} · players get ${pk.sent ? String(pk.sent).slice(0, 8) : "none set"}${pk.stale === false ? ", the same" : ""}`) : null,
        h("p", { class: "row-sub", style: "overflow-wrap:anywhere" }, `From ${pk.source}${pk.url ? `: ${pk.url}` : ""}`),
      ], { i: 4 }) : null].filter(Boolean));
  }

  async function restartServer(st) {
    const r = await formDialog({
      title: "Restart the server?", okLabel: "Restart", bad: true,
      text: st.busy ? h("p", { class: "note" }, "Something is on right now: a match, players on a pitch, a countdown, a ranked booking or a tournament match. Tick the box to restart anyway.")
        : "Everyone online sees a countdown. If a match starts meanwhile, the restart waits for it a minute at a time (three times at most), then calls itself off.",
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
    main.replaceChildren(
      pageHead("Sapphires", "Wallet tools", "Store orders and wallet repairs. Every change needs a reason, tells the player in game and goes in the Activity log."),
      panel("Look up a store order", [form, out], { i: 0 }),
      h("div", { class: "grid" },
        toolPanel("Add an order by hand", "For a PayNow order whose command never reached the game. Each line counts once: the same line again changes nothing.", "Add an order", "", () => storeGrant(), 1),
        toolPanel("Take an order back", "A refund, chargeback or revoke. Each line is taken back once, and a line that hasn't arrived yet is stopped from arriving later.", "Take one back", "btn-bad", () => storeReverse(), 2),
        toolPanel("Fix a wallet", "Bring a wallet that went below zero back to zero so its owner can spend again, or reset both parts to zero.", "Fix a wallet", "btn-dark", () => fixWallet(), 3)));
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
      // each store line's grant and tombstone, by line id: an order or pretty id can cover several
      const grants = r.grants && typeof r.grants === "object" ? Object.entries(r.grants) : r.grant ? [[(lines.find((l) => l.line) || {}).line || term, r.grant]] : [];
      const tombs = r.tombstones && typeof r.tombstones === "object" ? Object.entries(r.tombstones) : r.tombstone ? [[term, r.tombstone]] : [];
      const nameOf = (uuid) => (lines.find((l) => l.uuid === uuid && l.name) || {}).name || uuid;
      if (!lines.length && !grants.length && !tombs.length) return out.replaceChildren(empty(`Nothing in the wallet's books for "${term}".`));
      out.replaceChildren(h("div", { style: "margin-top:.9rem" },
        grants.map(([line, g]) => h("div", { class: "row" },
          h("div", { class: "row-main" },
            h("div", { class: "row-title" }, h("span", { class: "score" }, `+${Number(g.amount || 0).toLocaleString()}`), nameOf(g.uuid),
              g.starter ? h("span", { class: "tag" }, "Starter pack") : null,
              g.reversed ? h("span", { class: "tag is-bad" }, `Taken back: ${g.reverseKind || "?"}`) : h("span", { class: "tag is-good" }, "In their wallet")),
            h("div", { class: "row-sub" }, h("span", null, `Line ${line}`), g.at ? h("span", null, `Arrived ${fmtWhen(g.at)}`) : null,
              g.reversed && g.reversedAt ? h("span", null, `Taken back ${fmtWhen(g.reversedAt)}${g.reversedPaid != null ? ` (${Number(g.reversedPaid).toLocaleString()} came off)` : ""}`) : null)),
          h("div", { class: "row-actions" }, g.reversed ? null : h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => storeReverse(line, look) }, "Take it back")))),
        tombs.map(([line, t]) => h("p", { class: "note", style: "margin:.6rem 0" }, `Line ${line} was taken back before it arrived, so it can't arrive later${t ? ` (${t})` : ""}.`)),
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

  /* ── Clubs (owners): names, colours, crests, members ──────────── */

  const CREST_IMG = (hex) => `https://api.mcsoccer.net/crest/${encodeURIComponent(hex)}.png`;
  let clubMeta = null;    // clubs/list: the limits and the colour names
  let crestList = null;   // clubs/crests, fetched the first time a crest is picked
  const limit = (k, fallback) => (clubMeta && clubMeta.limits && clubMeta.limits[k]) || fallback;

  // a colour as it reads on the dark panels: a very dark one (a navy) is lifted toward white
  function legible(hex) {
    const n = parseInt(hex.slice(1), 16);
    const rgb = [n >> 16, (n >> 8) & 255, n & 255];
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    if (lum >= 0.28) return hex;
    const k = Math.min(0.6, (0.28 - lum) * 1.6);
    return "#" + rgb.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, "0")).join("");
  }

  // A crest: the pack's club and nation crests are images; a symbol (★ ⚑) is just its character,
  // which has no image, and an image that fails falls back to the character too
  function crestMark(hex, char, kind, size = 22) {
    const text = () => (char ? h("span", { class: "cflag", style: `font-size:${Math.round(size * 0.8)}px` }, char) : "");
    if (!hex || kind === "symbol") return text() || null;
    const img = h("img", { src: CREST_IMG(hex), width: size, height: size, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(text()), { once: true });
    return img;
  }

  /** A club's name as the game shows it: its crest, then the name in its gradient or its colour. */
  function clubLabel(c, size = 22) {
    const grad = (c.gradient || []).filter((x) => HEX.test(x)).map(legible);
    const style = grad.length >= 2 ? `background:linear-gradient(90deg,${grad.join(",")});-webkit-background-clip:text;background-clip:text;color:transparent`
      : HEX.test(c.colorHex || "") ? `color:${legible(c.colorHex)}` : null;
    return h("span", { class: "cname" }, crestMark(c.crest, c.flag, c.flagKind, size), h("b", { style }, c.name));
  }
  const gradBar = (grad) => h("i", { class: "grad-bar", style: `background:linear-gradient(90deg,${grad.join(",")})` });
  const swatch = (hex) => h("i", { class: "swatch", style: `background:${HEX.test(hex || "") ? hex : "transparent"}` });
  const inline = (...kids) => h("span", { class: "knob-in", style: "width:auto" }, kids);

  async function clubAdmin(id) {
    if (id) return clubPage(id);
    const seq = pageSeq;
    const top = pageHead("Clubs", "Clubs", "Every club's name, colours, crest and members. Changes show in game straight away.",
      ME && ME.role === "owner" ? h("button", { class: "btn", type: "button", onclick: newClub }, "New club") : null);
    main.replaceChildren(top, h("div", { class: "loading" }, "Loading clubs…"));
    const r = await call("GET", "/clubs/list");
    if (seq !== pageSeq) return;
    if (!r.ok) return main.replaceChildren(top, errorBox(r.error));
    clubMeta = r;
    const items = r.clubs || [];
    const rows = items.map((c) => {
      const fx = c.fixtures || {};
      const row = h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, clubLabel(c), h("span", { class: "tag" }, c.codeShown || "?"),
            c.inPlay ? h("span", { class: "tag is-live" }, c.playingOn ? `Playing on ${c.playingOn}` : "Playing") : null),
          h("div", { class: "row-sub" }, h("span", null, plural(c.members || 0, "member")), c.shortName ? h("span", null, `Short name ${c.shortName}`) : null,
            h("span", null, [fx.live && `${fx.live} live`, fx.scheduled && `${fx.scheduled} to play`, fx.finished && `${fx.finished} played`].filter(Boolean).join(" · ") || "No fixtures"))),
        h("a", { class: "btn btn-dark btn-sm", href: `#/clubs/${encodeURIComponent(c.id)}` }, "Open"));
      return { row, text: [c.name, c.id, c.shortName, c.codeShown].join(" ").toLowerCase() };
    });
    const find = h("input", { class: "input", type: "search", placeholder: `Find one of ${items.length} clubs`, autocomplete: "off", spellcheck: "false", "aria-label": "Find a club", style: "max-width:320px" });
    find.addEventListener("input", () => { const w = find.value.trim().toLowerCase(); rows.forEach((x) => { x.row.hidden = !!w && !x.text.includes(w); }); });
    main.replaceChildren(top, panel(null, [
      h("div", { class: "panel-head" }, h("small", null, `${plural(items.length, "club")} · ${plural(r.memberTotal || 0, "player")} in them`), items.length > 8 ? find : null),
      items.length ? h("div", { class: "rows" }, rows.map((x) => x.row)) : empty("No clubs yet.")]));
  }

  async function clubPage(id) {
    const seq = pageSeq;
    const back = h("a", { class: "btn btn-dark", href: "#/clubs" }, "All clubs");
    main.replaceChildren(pageHead("Clubs", "Club", null, back), h("div", { class: "loading" }, "Loading…"));
    const [r, meta] = await Promise.all([call("GET", `/clubs/show?club=${encodeURIComponent(id)}`), clubMeta || call("GET", "/clubs/list")]);
    if (seq !== pageSeq) return;
    if (meta && meta.ok) clubMeta = meta;
    if (!r.ok) return main.replaceChildren(main.firstChild, errorBox(r.error));
    const c = r.club;
    const owner = ME && ME.role === "owner";
    const edit = (label, fn) => (owner ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => fn(c) }, label) : null);
    const grad = (c.gradient || []).filter((x) => HEX.test(x));
    const members = (c.memberList || []).slice().sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const ORDER = { LIVE: 0, SCHEDULED: 1, FINISHED: 2, CANCELLED: 3 };
    const fixtures = (c.fixtureList || []).slice().sort((a, b) => (ORDER[a.state] ?? 4) - (ORDER[b.state] ?? 4) || (a.state === "SCHEDULED" ? a.kickoff - b.kickoff : b.kickoff - a.kickoff));
    const st = c.standing;
    main.replaceChildren(...[
      pageHead("Club", clubLabel(c, 34), [plural(c.members || 0, "member"), c.inPlay ? `playing on ${c.playingOn || "a pitch"} now` : null].filter(Boolean).join(" · "), back),
      c.inPlay ? h("p", { class: "note", style: "margin:0 0 .9rem" }, "They're playing right now: renaming, deleting and member changes wait until the match ends. Colours and crests change live.") : null,
      h("div", { class: "grid" },
        panel("Look", h("div", { class: "rows" },
          actionRow("Name", c.name, edit("Rename", renameClub)),
          actionRow("Colour", inline(swatch(c.colorHex), c.color ? nice(c.color) : "None"), edit("Change", colourClub)),
          actionRow("Gradient", grad.length >= 2 ? inline(gradBar(grad), grad.join(" ")) : "Off", edit("Change", gradientClub)),
          actionRow("Short name", c.shortName || "None, the full name is used", edit("Change", shortClub)),
          actionRow("Code", `${c.codeShown || "?"}${c.code ? "" : ", made from the name"}`, edit("Change", codeClub)),
          actionRow("Crest", c.flag ? inline(crestMark(c.crest, c.flag, c.flagKind), c.flagName || c.flagCode || "") : "None", edit("Change", crestClub)),
          actionRow("Logo", c.logo ? inline(h("img", { src: `https://mc-heads.net/avatar/${encodeURIComponent(c.logo)}/44`, width: 22, height: 22, alt: "" }), "A player head") : "None", edit("Change", logoClub))), { i: 0 }),
        panel(`Members (${members.length})`, [
          members.length ? h("div", { class: "rows" }, members.map((m) => h("div", { class: "row" },
            h("div", { class: "row-main" }, h("div", { class: "row-title" }, head(m.name, 24), m.name, m.online ? h("span", { class: "tag is-good" }, "Online") : null, m.pitch ? h("span", { class: "tag" }, m.pitch) : null)),
            h("div", { class: "row-actions" },
              h("a", { class: "btn btn-dark btn-sm", href: `#/players/${encodeURIComponent(m.uuid)}` }, "Player"),
              owner ? h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => removeMember(c, m) }, "Remove") : null)))) : empty("Nobody's in this club yet."),
          owner ? buttons(h("button", { class: "btn btn-sm", type: "button", onclick: () => addMember(c) }, "Add a member")) : null,
        ], { i: 1 })),
      h("div", { class: "grid" },
        st ? panel(st.competition || "League", [
          h("div", { class: "stats-2" }, stat(`#${st.position}`, "in the table"), stat(st.points, st.points === 1 ? "point" : "points"),
            stat(`${st.won}-${st.drawn}-${st.lost}`, "won, drawn, lost"), stat(`${st.goalDifference > 0 ? "+" : ""}${st.goalDifference}`, "goal difference")),
          (st.form || []).length ? h("p", { class: "fchips" }, h("span", { class: "row-sub" }, "Form"), st.form.map((x) => h("span", { class: `fchip is-${String(x).toLowerCase()}` }, x))) : null,
        ], { i: 2, aside: h("a", { href: "https://mcsoccer.net/champions-league/", target: "_blank", rel: "noopener" }, "Table") }) : null,
        panel("Fixtures", fixtures.length ? h("div", { class: "rows" }, fixtures.map((f) => fixtureRow(f, false))) : empty("No fixtures."), { i: 3, aside: h("a", { href: "#/fixtures" }, "All fixtures") })),
      owner ? panel("Delete this club", [h("p", null, "It's gone for good: its members leave it, and fixtures it's booked in can't be played."),
        buttons(h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => deleteClub(c) }, "Delete club"))], { i: 4 }) : null,
    ].filter(Boolean));
  }

  /** One club edit: its fields and a reason, sent to clubs/<op>. The club page is drawn again after. */
  async function clubEdit(c, op, { title, text, fields = [], okLabel = "Save", bad = false, onopen, params }) {
    const r = await formDialog({ title, text, okLabel, bad, onopen, fields: [...fields, reasonField()],
      submit: async (v) => {
        const p = params ? await params(v) : {};
        if (p && p.ok === false) return p;
        return call("POST", `/clubs/${op}`, { club: c.id, clubName: c.name, ...p, reason: v.reason });
      } });
    if (!r) return null;
    clubsCache = null;   // the fixtures page's list of clubs
    toast(r.changed === false ? (r.message || "It was already like that. Nothing changed.") : (r.message || "Saved."));
    if (op === "delete") location.hash = "#/clubs";
    else clubPage(c.id);
    return r;
  }

  const renameClub = (c) => clubEdit(c, "rename", { title: `Rename ${c.name}`, okLabel: "Rename",
    text: "Its id stays the same, so fixtures and links keep working.",
    fields: [{ name: "name", label: "Club name", value: c.name, maxlength: limit("name", 32), required: true }],
    params: (v) => ({ name: v.name }) });

  const colourClub = (c) => clubEdit(c, "color", { title: `${c.name}'s colour`,
    fields: [{ name: "color", type: "select", label: "Colour", value: c.color || "none", options: ((clubMeta && clubMeta.colours) || ["none"]).map((x) => ({ value: x, label: nice(x) })) }],
    params: (v) => ({ color: v.color }) });

  function gradientClub(c) {
    const preview = h("div", { class: "knob-in", style: "min-height:22px" });
    const show = (val) => {
      const cols = String(val).split(/[\s,]+/).filter((x) => HEX.test(x));
      preview.replaceChildren(cols.length >= 2 ? gradBar(cols) : h("small", null, String(val).trim() ? "It needs 2 to 5 colours, like #004D98 #A50044." : "No gradient: the name shows in its colour."));
    };
    return clubEdit(c, "gradient", { title: `${c.name}'s gradient`, text: preview,
      fields: [{ name: "gradient", label: "Colours", value: (c.gradient || []).join(" "), placeholder: "#004D98 #A50044", hint: "2 to 5 hex colours, left to right. Empty for none." }],
      onopen: (inputs) => { show(inputs.gradient.value); inputs.gradient.addEventListener("input", () => show(inputs.gradient.value)); },
      params: (v) => ({ gradient: v.gradient.replace(/,/g, " ").replace(/\s+/g, " ").trim() || "off" }) });
  }

  const shortClub = (c) => clubEdit(c, "short", { title: `${c.name}'s short name`,
    text: "For places the full name doesn't fit. Empty takes it off.",
    fields: [{ name: "short", label: "Short name", value: c.shortName || "", maxlength: limit("short", 8) }],
    params: (v) => ({ short: v.short || "off" }) });

  const codeClub = (c) => clubEdit(c, "code", { title: `${c.name}'s code`,
    text: `The letters on the scorebug, ${c.codeShown || "?"} now. Empty makes one from the name.`,
    fields: [{ name: "code", label: "Code", value: c.code || "", maxlength: limit("code", 4), placeholder: c.codeShown || "" }],
    params: (v) => ({ code: v.code.toUpperCase() || "off" }) });

  async function crestClub(c) {
    if (!crestList) {
      const r = await call("GET", "/clubs/crests");
      if (!r.ok) return toast(r.error, true);
      crestList = r.items || [];
    }
    let chosen = c.flagCode || (c.flag ? "" : "none");
    const custom = h("input", { class: "input", maxlength: limit("flag", 8), value: c.flag && !c.flagCode ? c.flag : "", placeholder: "★ or FC", autocomplete: "off", "aria-label": "A character or short text" });
    const KIND = { club: 0, nation: 1, symbol: 2 };   // club crests first: they're what clubs pick
    const sorted = crestList.slice().sort((a, b) => (KIND[a.kind] ?? 3) - (KIND[b.kind] ?? 3));
    const tiles = [{ code: "none", display: "None" }, ...sorted].map((x) => {
      const b = h("button", { class: "crest-tile", type: "button", title: x.display || x.name, "aria-pressed": String(chosen === x.code),
        onclick: () => { chosen = x.code; custom.value = ""; tiles.forEach((t) => t.b.setAttribute("aria-pressed", String(t.x.code === chosen))); } },
        x.code === "none" ? h("span", { class: "crest-none" }, "×") : crestMark(x.crest, x.character, x.kind, 28) || h("span", { class: "crest-none" }, "?"),
        h("small", null, x.display || x.name));
      return { b, x, text: [x.name, x.display, x.kind, ...(x.aliases || [])].join(" ").toLowerCase() };
    });
    custom.addEventListener("input", () => { if (custom.value.trim()) { chosen = ""; tiles.forEach((t) => t.b.setAttribute("aria-pressed", "false")); } });
    const find = h("input", { class: "input", type: "search", placeholder: `Find one of ${crestList.length} crests`, autocomplete: "off", spellcheck: "false", "aria-label": "Find a crest" });
    find.addEventListener("input", () => { const w = find.value.trim().toLowerCase(); tiles.forEach((t) => { t.b.hidden = !!w && !t.text.includes(w); }); });
    find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });   // Enter finds, it doesn't save
    const body = h("div", { class: "form" }, find, h("div", { class: "crest-grid" }, tiles.map((t) => t.b)),
      h("label", { class: "field" }, h("span", null, "Or a character or short text"), custom, h("small", null, `Up to ${limit("flag", 8)} characters. A crest counts as one.`)));
    return clubEdit(c, "flag", { title: `${c.name}'s crest`, text: body,
      params: () => (custom.value.trim() || chosen ? { flag: custom.value.trim() || chosen } : { ok: false, error: "Pick a crest, or type a character." }) });
  }

  const logoClub = (c) => clubEdit(c, "logo", { title: `${c.name}'s logo`,
    text: "A player head for the club. Paste a textures.minecraft.net link, a head site's Value, or the texture's hash. Type none to take it off.",
    fields: [{ name: "logo", type: "textarea", label: "Head", max: 4000, required: true }],
    params: (v) => ({ logo: v.logo }) });

  const addMember = (c) => clubEdit(c, "add", { title: `Add someone to ${c.name}`, okLabel: "Add",
    text: "Someone in another club moves over. If they're online, they're told in game.",
    fields: [{ name: "who", type: "player", label: "Player", required: true }],
    params: async (v) => { const p = await resolvePlayer(v.who); return p.error ? { ok: false, error: p.error } : { id: p.uuid, name: p.name }; } });

  const removeMember = (c, m) => clubEdit(c, "remove", { title: `Take ${m.name} out of ${c.name}?`, okLabel: "Take them out", bad: true,
    text: "If they're online, they're told in game.",
    params: () => ({ id: m.uuid, name: m.name }) });

  function deleteClub(c) {
    const booked = (c.fixtures && c.fixtures.scheduled) || 0;
    return clubEdit(c, "delete", { title: `Delete ${c.name}?`, okLabel: "Delete club", bad: true,
      text: `There's no undo.${booked ? ` It's booked in ${plural(booked, "fixture")}, which can't be played without it.` : ""}`,
      fields: [{ name: "confirm", label: `Type ${c.id} to confirm`, required: true },
        booked ? { name: "force", type: "checkbox", label: `Delete it anyway, with ${plural(booked, "fixture")} booked`, value: false } : null].filter(Boolean),
      params: (v) => (v.confirm !== c.id ? { ok: false, error: `Type ${c.id} exactly.` }
        : booked && !v.force ? { ok: false, error: "Tick the box to delete it with fixtures booked." }
        : { confirm: c.id, force: booked ? true : undefined }) });
  }

  async function newClub() {
    const r = await formDialog({ title: "New club", okLabel: "Make it",
      text: "Then set its colours, crest and members on its page.",
      fields: [{ name: "name", label: "Club name", maxlength: limit("name", 32), required: true, placeholder: "Red Lions" }, reasonField("New league club")],
      submit: (v) => call("POST", "/clubs/create", { name: v.name, reason: v.reason }) });
    if (!r) return;
    clubsCache = null;
    toast(r.repeat ? "That club was made already." : (r.message || "Made."));
    if (r.club && r.club.id) location.hash = `#/clubs/${encodeURIComponent(r.club.id)}`;
  }

  /* ── Cups (owners): sign-ups, the draw, calling matches, results ─ */

  const CUP_STATE = { SIGNUP: ["Sign-ups open", "is-good"], RUNNING: ["Running", "is-live"], FINISHED: ["Finished", ""], CANCELLED: ["Cancelled", "is-bad"] };
  const TEAM_STATUS = { OUT: ["Out", ""], WITHDRAWN: ["Withdrawn", "is-bad"], CHAMPION: ["Champion", "is-good"] };
  const DECIDED = { forfeit: "Won by forfeit", staff: "Given by staff", bye: "A bye" };
  const CUP_LIMITS = { teamSize: { min: 2, max: 5 }, maxTeams: [4, 8, 16, 32], halves: { min: 1, max: 4 }, halfMinutes: { min: 1, max: 30 }, teamName: 16, cupName: 32 };
  const CUP_DEFAULTS = { name: "MCS Cup", teamSize: 3, maxTeams: 8, halves: 2, halfMinutes: 5, extraTime: false };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const isOpen = (t) => !!t && (t.state === "SIGNUP" || t.state === "RUNNING");
  let cupView = null;   // { id, list, t, sig }: what the Cups page shows

  function cupHead(id) {
    return pageHead("Cups", "Cups", "Run a cup from here: sign-ups, the draw, calling matches to pitches and results. Players see every change in game.",
      [id ? h("a", { class: "btn btn-dark", href: "#/cups" }, "All cups") : null, h("button", { class: "btn btn-dark", type: "button", onclick: () => cups(id, true) }, "Refresh")]);
  }

  // quiet: a refresh (the timer or the button), drawn only when the cup changed
  async function cups(id, quiet) {
    const seq = pageSeq;
    if (!quiet) main.replaceChildren(cupHead(id), h("div", { class: "loading" }, "Loading the cup…"));
    const [list, show] = await Promise.all([call("GET", "/cups/list"), call("GET", `/cups/show?id=${encodeURIComponent(id || "current")}`)]);
    if (seq !== pageSeq) return;
    if (leave) { leave(); leave = null; }
    if (!list.ok) return main.replaceChildren(cupHead(id), errorBox(list.error));
    const t = show.ok ? show.tournament : null;
    if (isOpen(t)) {
      // quick while a match is live or being called, so scores and calls keep up
      const busy = (t.rounds || []).some((rd) => (rd.matches || []).some((m) => m.state === "LIVE" || m.calling));
      const timer = setTimeout(() => cups(id, true), document.hidden ? 30000 : busy ? 5000 : 15000);
      leave = () => clearTimeout(timer);
    }
    const sig = JSON.stringify([list.current, (list.items || []).map((c) => [c.id, c.version]), t && t.id, t && t.version]);
    if (quiet && cupView && cupView.id === id && (sig === cupView.sig || dlg.open)) {
      const note = $("[data-cup-note]", main);
      if (note && sig === cupView.sig) note.textContent = `Updated ${clock(Date.now())}`;
      return;
    }
    if (quiet) settle();
    // a 404 only means there's no cup yet (or no such one); anything else is worth showing
    cupView = { id, list, t, sig, error: !show.ok && show.httpStatus !== 404 ? show.error : null };
    drawCups();
  }

  function drawCups() {
    const { id, list, t, error } = cupView;
    const owner = ME && ME.role === "owner";
    const past = (list.items || []).filter((c) => !(isOpen(t) && c.id === t.id));
    const parts = [cupHead(id)];
    if (error) parts.push(errorBox(error));
    else if (t && (isOpen(t) || id)) parts.push(...cupBoard(t));
    else if (id) parts.push(errorBox("There's no cup with that id."));
    else parts.push(panel("No cup is open", [h("p", null, "Start one and sign-ups open in game straight away. Teams join as a party with /tournament join."),
      owner ? buttons(h("button", { class: "btn btn-sm", type: "button", onclick: () => newCup(t) }, "Start a cup")) : null], { i: 0 }));
    if (!id) parts.push(panel("Past cups", past.length ? h("div", { class: "rows" }, past.map(cupRow)) : empty("No cups yet."), { i: 5 }));
    main.replaceChildren(...parts);
  }

  function cupRow(c) {
    const [label, cls] = CUP_STATE[c.state] || [c.state, ""];
    return h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("div", { class: "row-title" }, c.name, h("span", { class: `tag ${cls}` }, label),
          c.champion ? h("span", { class: "club", style: HEX.test(c.champion.color || "") ? `--c:${c.champion.color}` : null }, h("i"), `Won by ${c.champion.name}`) : null),
        h("div", { class: "row-sub" }, h("span", null, `${c.teamSize}v${c.teamSize}`), h("span", null, plural(c.teamCount || 0, "team")),
          h("span", null, fmtDay(c.finishedAt || c.startedAt || c.createdAt)))),
      h("a", { class: "btn btn-dark btn-sm", href: `#/cups/${encodeURIComponent(c.id)}` }, "Open"));
  }

  /** The cup's panels: what it is and what can be done, its bracket, its teams, what happened. */
  function cupBoard(t) {
    const edit = !!(t.editable && ME && ME.role === "owner");
    const [label, cls] = CUP_STATE[t.state] || [t.state, ""];
    const rules = t.rules || {};
    const can = t.can || {};
    const teams = new Map((t.teams || []).map((x) => [x.id, x]));
    const parts = [panel(null, [
      h("div", { class: "panel-head" }, h("h2", { class: "cup-title" }, t.name, h("span", { class: `tag ${cls}` }, label), t.liveGames ? h("span", { class: "tag is-live" }, `${t.liveGames} live`) : null),
        isOpen(t) ? h("small", { "data-cup-note": "" }, `Updated ${clock(Date.now())}`) : null),
      t.champion && teams.get(t.champion) ? h("p", { class: "cup-champ" }, h("span", { class: "club", style: HEX.test(teams.get(t.champion).color || "") ? `--c:${teams.get(t.champion).color}` : null }, h("i"), `Won by ${teams.get(t.champion).name}`)) : null,
      h("p", null, [`${t.teamSize}v${t.teamSize}`, `${t.teamCount || 0} of ${t.maxTeams} teams`, `${rules.halves || 2} halves of ${rules.halfMinutes || 5} min`, rules.extraTime ? "extra time, then penalties" : "a tie goes to penalties"].join(" · ")),
      h("p", { class: "row-sub" }, [t.createdBy ? `Opened by ${byName(t.createdBy)}` : null, t.createdAt ? fmtWhen(t.createdAt) : null, t.finishedAt ? `ended ${fmtWhen(t.finishedAt)}` : null].filter(Boolean).join(" · ")),
      t.state === "SIGNUP" ? h("p", { class: "row-sub" }, `Teams sign up in game: a party of exactly ${t.teamSize}, then the leader types /tournament join.`) : null,
      edit && t.state === "SIGNUP" && !can.draw && t.why && t.why.draw ? h("p", { class: "note" }, t.why.draw) : null,
      edit ? buttons(
        can.draw ? h("button", { class: "btn btn-sm", type: "button", onclick: () => drawCup(t, "draw") }, "Draw the bracket") : null,
        can.redraw ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => drawCup(t, "redraw") }, "Draw again") : null,
        can.configure ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => configureCup(t) }, "Settings") : null,
        can.cancel ? h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => cancelCup(t) }, "Cancel the cup") : null) : null,
    ], { i: 0 })];
    if ((t.rounds || []).length) parts.push(panel("Bracket", h("div", { class: "bracket" }, t.rounds.map((rd) =>
      h("section", { class: "bround" }, h("h3", null, rd.name || `Round ${rd.round}`),
        h("div", { class: "bround-list" }, (rd.matches || []).map((m) => matchCard(t, m, teams, edit)))))), { i: 1 }));
    parts.push(panel(`Teams (${(t.teams || []).length})`, (t.teams || []).length ? h("div", { class: "rows" }, t.teams.map((x) => teamRow(t, x, edit)))
      : empty(t.state === "SIGNUP" ? "Nobody's signed up yet." : "No teams."), { i: 2 }));
    const events = (t.events || []).slice(-25).reverse();
    if (events.length) parts.push(panel("What happened", h("div", { class: "rows" }, events.map((e) => h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("div", { class: "row-title" }, HEX.test(e.teamColor || "") ? h("span", { class: "club", style: `--c:${e.teamColor}` }, h("i")) : null, e.text),
        h("div", { class: "row-sub" }, h("span", null, `${fmtWhen(e.at)} (${ago(e.at)})`))), h("span")))), { i: 3 }));
    return parts;
  }

  function matchCard(t, m, teams, edit) {
    const side = (k) => {
      const team = teams.get(m[k]);
      return h("div", { class: m.winner && m.winner === m[k] ? "bside is-won" : "bside" },
        h("i", { style: team && HEX.test(team.color || "") ? `background:${team.color}` : null }),
        h("span", null, team ? team.name : m.bye ? "Bye" : "To be decided"),
        h("b", null, m.score ? String(m.score[k] ?? "") : ""),
        h("small", null, m.shootout ? `(${m.shootout[k]})` : ""));
    };
    const can = m.can || {};
    const win = can.win || {};
    const tag = m.state === "LIVE" ? h("span", { class: "tag is-live" }, "Live")
      : m.calling ? h("span", { class: "tag is-warn" }, "Calling")
      : m.state === "READY" ? h("span", { class: "tag is-good" }, "Ready") : null;
    const decided = m.state !== "DONE" || !m.decidedBy || m.decidedBy === "goals" ? null
      : m.decidedBy === "shootout" ? (m.shootout ? "Won on penalties" : "Won on a coin flip") : DECIDED[m.decidedBy] || null;
    const acts = edit ? [
      can.start ? h("button", { class: "btn btn-sm", type: "button", onclick: () => startMatch(t, m) }, "Start") : null,
      win.a || win.b ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => winMatch(t, m, teams) }, m.state === "DONE" ? "Change result" : "Give the win") : null,
      can.void ? h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => voidMatch(t, m) }, m.state === "LIVE" ? "Stop" : "Call off") : null,
    ].filter(Boolean) : [];
    return h("div", { class: `bmatch is-${String(m.state || "").toLowerCase()}${m.calling ? " is-calling" : ""}` },
      h("div", { class: "bmatch-head" }, h("small", null, m.label || m.id), tag),
      side("a"), side("b"),
      m.calling && m.calledTo ? h("p", { class: "row-sub" }, `Called to ${m.calledTo.name}`) : m.state === "LIVE" && m.pitch ? h("p", { class: "row-sub" }, m.pitch) : null,
      decided ? h("p", { class: "row-sub" }, decided) : null,
      m.lastCall && m.state === "READY" && !m.calling ? h("p", { class: "note bnote" }, m.lastCall.text) : null,
      edit && m.state === "READY" && !can.start && !m.calling && m.why && m.why.start ? h("p", { class: "row-sub" }, m.why.start) : null,
      m.matchId ? h("a", { class: "bmatch-link", href: `https://mcsoccer.net/matches/?m=${encodeURIComponent(m.matchId)}`, target: "_blank", rel: "noopener" }, "Match report") : null,
      acts.length ? h("div", { class: "row-actions", style: "justify-content:flex-start;margin-top:.35rem" }, acts) : null);
  }

  function teamRow(t, x, edit) {
    const st = TEAM_STATUS[x.status];
    const can = x.can || {};
    return h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("div", { class: "row-title" }, h("span", { class: "club", style: HEX.test(x.color || "") ? `--c:${x.color}` : null }, h("i"), x.name),
          x.seed ? h("span", { class: "tag" }, `Seed ${x.seed}`) : null, st ? h("span", { class: `tag ${st[1]}` }, st[0]) : null,
          x.currentMatch ? h("span", { class: "tag is-live" }, "Playing") : null),
        h("div", { class: "row-sub" }, (x.members || []).map((m) => h("span", { class: m.online ? "who is-on" : "who", title: m.online ? "Online" : "Offline" }, m.name, m.leader ? " (leader)" : "")))),
      edit ? h("div", { class: "row-actions" },
        can.rename ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => renameTeam(t, x) }, "Rename") : null,
        can.swap ? h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: () => swapPlayer(t, x) }, "Swap a player") : null,
        can.remove ? h("button", { class: "btn btn-bad btn-sm", type: "button", onclick: () => removeTeam(t, x) }, t.state === "SIGNUP" ? "Remove" : "Withdraw") : null) : h("span"));
  }

  /** A cup action on the cup as this page has it (its id and version). The answer is the cup as it is now. */
  const cupAct = (t, op, body) => call("POST", `/cups/${op}`, { cup: t.id, cupName: t.name, expectVersion: t.version, ...body });
  function cupDone(r) {
    toast(r.message || "Done.");
    if (!cupView) return;
    // a cup that closed (cancelled, or the final settled) goes back to the list
    if (!r.tournament || !isOpen(r.tournament)) return cups(cupView.id, true);
    cupView.t = r.tournament;
    cupView.sig = "";
    drawCups();
  }
  const mustTick = (force, v) => (force && !v.force ? { ok: false, error: "Tick the box to stop the live game." } : null);

  async function drawCup(t, op) {
    const again = op === "redraw";
    const r = await formDialog({ title: again ? "Draw the bracket again?" : "Draw the bracket?", okLabel: again ? "Draw again" : "Draw it",
      text: again ? "A new random draw. It only works before any match is played." : "Sign-ups close and the seeds are drawn at random. Players are told in game.",
      fields: [reasonField(again ? "Two friends drew each other" : "Everyone's in")],
      submit: (v) => cupAct(t, op, { reason: v.reason }) });
    if (r) cupDone(r);
  }

  const teamSizeOptions = (L) => range(L.teamSize.min, L.teamSize.max).map((n) => ({ value: String(n), label: `${n}v${n}` }));
  const halvesFields = (L, rules) => ({ type: "row", fields: [
    { name: "halves", type: "number", label: "Halves", value: String(rules.halves), min: L.halves.min, max: L.halves.max, required: true },
    { name: "halfMinutes", type: "number", label: "Minutes a half", value: String(rules.halfMinutes), min: L.halfMinutes.min, max: L.halfMinutes.max, required: true }] });

  async function configureCup(t) {
    const L = t.limits || CUP_LIMITS;
    const rules = t.rules || CUP_DEFAULTS;
    const sizes = !!(t.can && t.can.teamSize);
    const r = await formDialog({ title: `Settings for ${t.name}`,
      text: sizes ? null : "Teams have signed up, so the team size stays as it is.",
      fields: [
        { type: "row", fields: [
          sizes ? { name: "teamSize", type: "select", label: "Players a side", value: String(t.teamSize), options: teamSizeOptions(L) } : null,
          { name: "maxTeams", type: "select", label: "Teams at most", value: String(t.maxTeams), options: L.maxTeams.filter((n) => n >= (t.minMaxTeams || 0)).map((n) => ({ value: String(n), label: String(n) })) }].filter(Boolean) },
        halvesFields(L, rules),
        { name: "extraTime", type: "checkbox", label: "Extra time before penalties", value: !!rules.extraTime },
        reasonField("Shorter halves tonight"),
      ],
      submit: (v) => cupAct(t, "configure", { teamSize: sizes ? Number(v.teamSize) : undefined, maxTeams: Number(v.maxTeams), halves: Number(v.halves), halfMinutes: Number(v.halfMinutes), extraTime: v.extraTime, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function newCup(last) {
    const D = (last && last.defaults) || CUP_DEFAULTS;
    const L = (last && last.limits) || CUP_LIMITS;
    const r = await formDialog({ title: "Start a cup", okLabel: "Open sign-ups",
      text: "Sign-ups open in game straight away. Draw the bracket once the teams are in.",
      fields: [
        { name: "name", label: "Name", value: D.name, maxlength: L.cupName || 32, required: true },
        { type: "row", fields: [
          { name: "teamSize", type: "select", label: "Players a side", value: String(D.teamSize), options: teamSizeOptions(L) },
          { name: "maxTeams", type: "select", label: "Teams at most", value: String(D.maxTeams), options: L.maxTeams.map((n) => ({ value: String(n), label: String(n) })) }] },
        halvesFields(L, D),
        { name: "extraTime", type: "checkbox", label: "Extra time before penalties", value: !!D.extraTime },
        reasonField("Friday night cup"),
      ],
      submit: (v) => call("POST", "/cups/create", { name: v.name, teamSize: Number(v.teamSize), maxTeams: Number(v.maxTeams), halves: Number(v.halves), halfMinutes: Number(v.halfMinutes), extraTime: v.extraTime, reason: v.reason }) });
    if (!r) return;
    toast(r.message || "Sign-ups are open.");
    if (location.hash === "#/cups") cups(""); else location.hash = "#/cups";
  }

  async function startMatch(t, m) {
    const free = (t.freePitches || []).filter((p) => !p.reserved);
    if (!free.length) return toast("No pitch is free right now.", true);
    const fs = t.forfeitSeconds || 60;
    const r = await formDialog({ title: `Start ${m.label || m.id}`, okLabel: "Call them",
      text: `Everyone on both teams who's online is called to the pitch, and it kicks off ${plural(t.callSeconds || 5, "second")} later. A side with nobody there for ${fs % 60 ? plural(fs, "second") : plural(fs / 60, "minute")} loses by forfeit.`,
      fields: [{ name: "pitch", type: "select", label: "Pitch", value: free[0].id, options: free.map((p) => ({ value: p.id, label: p.name })) }, reasonField("Semifinal time")],
      submit: (v) => cupAct(t, "start", { match: m.id, matchName: m.label, pitch: v.pitch, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function winMatch(t, m, teams) {
    const win = (m.can && m.can.win) || {};
    const opts = ["a", "b"].filter((k) => win[k] && teams.get(m[k])).map((k) => ({ value: k, label: teams.get(m[k]).name }));
    if (!opts.length) return;
    const force = !!(m.needsForce && m.needsForce.win);
    const r = await formDialog({ title: m.state === "DONE" ? `Change ${m.label}'s result` : `Give ${m.label} to a side`, okLabel: "Give the win", bad: m.state !== "READY",
      text: m.state === "LIVE" ? "It's live: this ends it now, and the side you pick goes through." : m.state === "DONE" ? "The side you pick goes through instead." : "For a match that won't be played. The side you pick goes through.",
      fields: [{ name: "side", type: "select", label: "Winner", value: opts[0].value, options: opts },
        force ? { name: "force", type: "checkbox", label: "Yes, stop the live game", value: false } : null, reasonField("The other side never showed")].filter(Boolean),
      submit: (v) => mustTick(force, v) || cupAct(t, "win", { match: m.id, matchName: m.label, side: v.side, teamName: (teams.get(m[v.side]) || {}).name, force: force || undefined, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function voidMatch(t, m) {
    const live = m.state === "LIVE";
    const force = !!(m.needsForce && m.needsForce.void);
    const r = await formDialog({ title: live ? `Stop ${m.label}?` : `Call off ${m.label}?`, okLabel: live ? "Stop it" : "Call it off", bad: true,
      text: live ? "The game stops and its score is lost. The match goes back to ready, to be played again." : "The countdown stops. The match stays ready to start again.",
      fields: [force ? { name: "force", type: "checkbox", label: "Yes, stop the live game", value: false } : null, reasonField(live ? "Lag, replaying it" : "Wrong pitch")].filter(Boolean),
      submit: (v) => mustTick(force, v) || cupAct(t, "void", { match: m.id, matchName: m.label, force: force || undefined, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function renameTeam(t, x) {
    const r = await formDialog({ title: `Rename ${x.name}`, okLabel: "Rename",
      fields: [{ name: "name", label: "Team name", value: x.name, maxlength: (t.limits && t.limits.teamName) || 16, required: true }, reasonField()],
      submit: (v) => cupAct(t, "rename", { team: x.id, teamName: x.name, name: v.name, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function swapPlayer(t, x) {
    const cands = t.swapCandidates || [];
    if (!cands.length) return toast("Nobody's free to swap in: they must be online and on no team.", true);
    const r = await formDialog({ title: `Swap a player on ${x.name}`, okLabel: "Swap",
      text: "The roster changes for the rest of the cup.",
      fields: [{ type: "row", fields: [
        { name: "out", type: "select", label: "Out", value: (x.members[0] || {}).uuid, options: (x.members || []).map((m) => ({ value: m.uuid, label: m.name })) },
        { name: "in", type: "select", label: "In", value: cands[0].uuid, options: cands.map((p) => ({ value: p.uuid, label: p.name })) }] }, reasonField("Left for the night")],
      submit: (v) => cupAct(t, "swap", { team: x.id, teamName: x.name, out: v.out, in: v.in,
        outName: ((x.members || []).find((m) => m.uuid === v.out) || {}).name, inName: (cands.find((p) => p.uuid === v.in) || {}).name, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function removeTeam(t, x) {
    const signup = t.state === "SIGNUP";
    const force = !!(x.needsForce && x.needsForce.remove);
    const r = await formDialog({ title: signup ? `Remove ${x.name}?` : `Withdraw ${x.name}?`, okLabel: signup ? "Remove" : "Withdraw", bad: true,
      text: signup ? "The team comes off the sign-ups." : "The team is out of the cup and forfeits its matches: its opponents go through.",
      fields: [force ? { name: "force", type: "checkbox", label: "They're playing: stop the live game", value: false } : null, reasonField("Broke the rules")].filter(Boolean),
      submit: (v) => mustTick(force, v) || cupAct(t, "remove", { team: x.id, teamName: x.name, force: force || undefined, reason: v.reason }) });
    if (r) cupDone(r);
  }

  async function cancelCup(t) {
    const live = t.liveGames || 0;
    const r = await formDialog({ title: `Cancel ${t.name}?`, okLabel: "Cancel the cup", bad: true,
      text: "It ends with no winner and players are told in game. There's no undo.",
      fields: [live ? { name: "force", type: "checkbox", label: `Stop the ${plural(live, "live game")} too`, value: false } : null, reasonField("Not enough teams")].filter(Boolean),
      submit: (v) => mustTick(live > 0, v) || cupAct(t, "cancel", { force: live > 0 || undefined, reason: v.reason }) });
    if (r) cupDone(r);
  }

  /* ── Ranked: the queues, found and live matches, pitches, ladders ─ */

  let ladderQueue = "";
  let rankedSig = "";
  const PITCH_STATE = { free: ["Free", "is-good"], playing: ["Ranked match on", "is-live"], busy: ["Busy", "is-warn"], notReady: ["Not set up", "is-bad"] };
  const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const whoList = (players) => (players || []).map((p) => h("span", { class: p.left ? "who is-left" : "who is-on", title: p.left ? "Walked out" : null }, p.name || "?"));

  // quiet: a refresh (the timer or the button), drawn only when something changed
  async function ranked(quiet) {
    const seq = pageSeq;
    const top = pageHead("Ranked", "Ranked", "The ranked queues as they are now: who's searching, matches found and on, every ranked pitch and the ladders.",
      h("button", { class: "btn btn-dark", type: "button", onclick: () => ranked(true) }, "Refresh"));
    if (!quiet) main.replaceChildren(top, h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", "/ranked/status?limit=500");
    if (seq !== pageSeq) return;
    if (leave) leave();
    const poll = setTimeout(() => ranked(true), document.hidden ? 30000 : 10000);
    const tick = setInterval(() => {
      for (const el of $$("[data-since]", main)) el.textContent = `${mmss((Date.now() - Number(el.dataset.since)) / 1000)} waiting`;
      for (const el of $$("[data-ends]", main)) el.textContent = `${mmss((Number(el.dataset.ends) - Date.now()) / 1000)} left`;
    }, 1000);
    leave = () => { clearTimeout(poll); clearInterval(tick); };
    if (!r.ok) return quiet && rankedSig ? undefined : main.replaceChildren(top, errorBox(r.error));
    // the clocks tick on the page, so a clock moving on its own isn't a change
    const sig = JSON.stringify(r, (k, v) => (k === "waitedMs" || k === "halfSecondsLeft" || k === "secondsLeft" || k === "httpStatus" ? undefined : v));
    if (quiet && (sig === rankedSig || dlg.open)) return;
    rankedSig = sig;
    if (quiet) settle();
    drawRanked(top, r);
  }

  function drawRanked(top, r) {
    const owner = ME && ME.role === "owner";
    const queues = r.queues || [], found = r.found || [], matches = r.matches || [], pitches = r.pitches || [], ladders = r.ladders || [];
    const searching = queues.reduce((n, q) => n + (q.players || 0), 0);
    const free = pitches.filter((p) => p.state === "free").length;
    if (!ladders.some((l) => l.queue === ladderQueue)) ladderQueue = (ladders.find((l) => l.total) || ladders[0] || {}).queue || "";
    const ladder = ladders.find((l) => l.queue === ladderQueue);
    const cfg = r.config || {};
    const win = cfg.window || {};
    const sides = (teams) => ["red", "blue"].map((k) => teams && teams[k] ? h("span", null, `${teams[k].name} (${teams[k].avgElo}): `, whoList(teams[k].players)) : null);
    main.replaceChildren(...[top,
      r.enabled === false ? h("p", { class: "note", style: "margin:0 0 .9rem" }, "Ranked is switched off on the server: nobody can queue.") : null,
      r.fileOk === false ? errorBox("ranked.yml couldn't be read when the server started, so ratings aren't being saved. Fix it before anyone plays ranked.") : null,
      h("div", { class: "grid" },
        panel("Right now", h("div", { class: "stats-2" },
          stat(searching, searching === 1 ? "player searching" : "players searching"), stat(found.length, found.length === 1 ? "match found" : "matches found"),
          stat(matches.length, matches.length === 1 ? "match on" : "matches on"), stat(`${free}/${pitches.length}`, "pitches free")), { i: 0 }),
        panel("Ranked pitches", pitches.length ? h("div", { class: "rows" }, pitches.map((p) => {
          const [label, cls] = PITCH_STATE[p.state] || [p.state, ""];
          return h("div", { class: "row" }, h("div", { class: "row-main" },
            h("div", { class: "row-title" }, p.name || p.id, p.queue ? h("span", { class: "tag" }, p.queue) : null, h("span", { class: `tag ${cls}` }, label)),
            p.why || (p.problems || []).length ? h("div", { class: "row-sub" }, p.why ? h("span", null, p.why) : null, (p.problems || []).map((x) => h("span", null, x))) : null), h("span"));
        })) : empty("No pitch has ranked switched on."), { i: 1 })),
      queues.some((q) => (q.entries || []).length) ? panel("Searching", h("div", { class: "rows" }, queues.flatMap((q) => (q.entries || []).map((e) => h("div", { class: "row" },
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "tag" }, q.id), (e.members || []).map((m) => h("span", { class: "club" }, head(m.name, 20), m.name)), h("span", { class: "vs" }, `${e.avgElo} Elo`)),
          h("div", { class: "row-sub" }, h("span", { "data-since": e.since || Date.now() - (e.waitedMs || 0) }, `${mmss((e.waitedMs || 0) / 1000)} waiting`),
            h("span", null, e.rangeElo == null ? "open to anyone now" : `within ${e.rangeElo} Elo`), e.waitingForPitch ? h("span", null, "waiting for a free pitch") : null)),
        h("span"))))), { i: 2 }) : null,
      found.length ? panel("Matches found", h("div", { class: "rows" }, found.map((f) => {
        const d = f.draft;
        return h("div", { class: "row" }, h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "tag" }, f.queue), f.pitch ? f.pitch.name : "", f.drafting ? h("span", { class: "tag is-warn" }, "Captains picking") : h("span", { class: "tag is-good" }, "Starting")),
          d ? h("div", { class: "row-sub" }, (d.sides || []).map((s) => h("span", null, `${s.name} captain: ${s.captain ? s.captain.name : "?"}`)),
            d.turn ? h("span", null, `${nice(d.turn)} to pick`) : null, d.secondsLeft != null ? h("span", { "data-ends": Date.now() + d.secondsLeft * 1000 }, `${mmss(d.secondsLeft)} left`) : null)
            : h("div", { class: "row-sub" }, sides(f.teams))), h("span"));
      })), { i: 3 }) : null,
      matches.length ? panel("Ranked matches on", h("div", { class: "rows" }, matches.map((m) => {
        const sc = m.score || {};
        const left = new Set(m.left || []);
        const teams = m.teams ? Object.fromEntries(Object.entries(m.teams).map(([k, x]) => [k, { ...x, players: (x.players || []).map((p) => ({ ...p, left: p.left || left.has(p.uuid) })) }])) : null;
        return h("div", { class: "row" }, h("div", { class: "row-main" },
          h("div", { class: "row-title" }, h("span", { class: "tag" }, m.queue), m.pitch ? m.pitch.name : "", h("b", { class: "score" }, `${sc.red ?? 0} – ${sc.blue ?? 0}`),
            m.running ? h("span", { class: "tag is-live" }, "Live") : h("span", { class: "tag" }, "Starting"),
            m.running && m.halfSecondsLeft != null ? h("span", { class: "vs", "data-ends": Date.now() + m.halfSecondsLeft * 1000 }, `${mmss(m.halfSecondsLeft)} left`) : null),
          h("div", { class: "row-sub" }, sides(teams))), h("span"));
      })), { i: 4 }) : null,
      panel("Ladder", [
        ladders.length > 1 ? h("div", { class: "panel-head" }, h("div", { class: "tabs" }, ladders.map((l) =>
          h("button", { type: "button", "aria-pressed": String(l.queue === ladderQueue), onclick: () => { ladderQueue = l.queue; drawRanked(top, r); } }, `${l.queue} (${l.total})`)))) : null,
        ladder && (ladder.items || []).length ? h("div", { class: "table-wrap" }, h("table", { class: "ladder" },
          h("thead", null, h("tr", null, h("th", { class: "num" }, "#"), h("th", null, "Player"), h("th", { class: "num" }, "Elo"), h("th", { class: "num" }, "Games"), h("th", { class: "num" }, "Won"), h("th", { class: "num" }, "Lost"), owner ? h("th") : null)),
          h("tbody", null, ladder.items.map((x) => h("tr", null,
            h("td", { class: "num" }, String(x.rank)),
            h("td", null, h("span", { class: "who-cell" }, x.name ? head(x.name, 22) : null,
              x.uuid ? h("a", { href: `#/players/${encodeURIComponent(x.uuid)}` }, x.name || "Unknown") : x.name || "Unknown",
              x.linked ? null : h("span", { class: "tag", title: "No Discord link, so the website leaves them off its ladder" }, "Not linked"))),
            h("td", { class: "num" }, h("b", null, String(x.elo))), h("td", { class: "num" }, String(x.games)), h("td", { class: "num" }, String(x.wins)), h("td", { class: "num" }, String(x.losses)),
            owner ? h("td", { class: "num" }, h("button", { class: "btn btn-dark btn-sm", type: "button",
              onclick: async () => { if (await resetRating({ uuid: x.uuid, name: x.name || x.uuid }, ladder.queue)) ranked(true); } }, "Reset")) : null)))))
          : empty("Nobody's on this ladder yet."),
        ladder && ladder.total > (ladder.items || []).length ? h("p", { class: "row-sub" }, `Showing ${ladder.items.length} of ${ladder.total}.`) : null,
      ], { i: 5, aside: ladder && ladder.updatedAt ? h("small", null, `Updated ${ago(ladder.updatedAt)}`) : null }),
      panel("How the queue is set", h("div", { class: "rows" },
        actionRow("Starting Elo", String(cfg.startElo ?? "?")),
        actionRow("Elo moves", `Up to ${cfg.kPlacement ?? "?"} a game for the first ${plural(cfg.placementGames ?? 0, "game")}, then up to ${cfg.kSettled ?? "?"}`),
        actionRow("Search", `Within ${win.start ?? "?"} Elo, ${win.step ?? "?"} wider every ${win.everySeconds ?? "?"} s, anyone after ${win.anyoneAfterSeconds ?? "?"} s`),
        actionRow("Captains' draft", cfg.draft && cfg.draft.enabled ? `On, ${cfg.draft.pickSeconds} s a pick` : "Off"),
        actionRow("Match found", `${cfg.matchFoundSeconds ?? "?"} s to get ready`),
        actionRow("Forfeit", `After ${cfg.forfeitSeconds ?? "?"} s`),
        actionRow("Leaver cooldowns", `${(cfg.leaverCooldownMinutes || []).join(", ")} min, forgotten after ${cfg.leaverResetHours ?? "?"} h`),
        actionRow("On the ladder", `From ${plural(cfg.ladderMinGames ?? 1, "game")}`),
        actionRow("Discord link", cfg.requireLink ? "Needed to queue" : "Not needed")), { i: 6 }),
    ].filter(Boolean));
  }

  /** Reset someone's rating in a queue; true when it was done. */
  async function resetRating(p, queue) {
    const r = await formDialog({ title: `Reset ${p.name}'s rating?`, okLabel: "Reset", bad: true,
      text: "Elo, games, wins and losses go back to the start. Leaves, cooldowns and match history stay.",
      fields: [{ name: "queue", type: "select", label: "Queue", value: queue || "3v3", options: [{ value: "3v3", label: "3v3" }, { value: "4v4", label: "4v4" }, { value: "both", label: "Both" }] }, reasonField("Boosted by an alt")],
      submit: (v) => call("POST", "/ranked/reset", { id: p.uuid, name: p.name, queue: v.queue, reason: v.reason }) });
    if (!r) return false;
    toast(r.message || "Reset.");
    return true;
  }

  /* ── Maintenance (owners): fixing stats, always previewed first ── */

  const PARTS = { stats: "Career stats", matches: "Match history", ranked: "Ranked", training: "Training", sapphires: "Sapphires" };
  const CAREER = [["games", "game", "games"], ["wins", "win", "wins"], ["goals", "goal", "goals"], ["assists", "assist", "assists"], ["saves", "save", "saves"], ["mvps", "MVP", "MVPs"]];
  const partRows = (r) => h("div", { class: "rows" }, Object.entries(r.parts || {}).map(([k, line]) => actionRow(PARTS[k] || nice(k), String(line))));

  async function maint() {
    const seq = pageSeq;
    const top = pageHead("Maintenance", "Maintenance", "Owner tools for fixing stats. Each one shows what it's going to do before it does it.");
    main.replaceChildren(top, h("div", { class: "loading" }, "Loading…"));
    const r = await call("GET", "/maint/status");
    if (seq !== pageSeq) return;
    if (!r.ok) return main.replaceChildren(top, errorBox(r.error));
    const hist = r.history || {}, car = r.careers || {};
    const warn = [!hist.on ? "Match history is off, so merges can't move matches and old games can't be recounted." : !hist.ready ? "Match history is still loading. Give it a minute." : null,
      !car.on ? "Career stats are off." : !car.loaded ? "stats.yml didn't load, so careers can't change until it's fixed." : null].filter(Boolean);
    main.replaceChildren(top, ...[
      panel("Status", h("div", { class: "form-row" },
        stat(hist.ready ? Number(hist.matches || 0).toLocaleString() : "…", "matches in history"),
        stat(hist.ready ? Number(hist.players || 0).toLocaleString() : "…", "players in history"),
        stat(car.on && car.loaded ? "On" : "Off", "career stats")), { i: 0 }),
      ...warn.map((w) => h("p", { class: "note" }, w)),
      h("div", { class: "grid" },
        toolPanel("Wipe a career", "Clears one account's career stats. Match history, ranked, training and Sapphires stay, and stats.yml is backed up first.", "Wipe a career", "btn-bad", () => statsReset(), 1),
        toolPanel("Merge two accounts", "Moves an old account's stats, matches, ranked, training and Sapphires onto the main one. Discord links, cosmetics, ranks, clubs and titles stay put. There's no undo.", "Merge accounts", "btn-bad", () => mergeAccounts(), 2),
        toolPanel("Recount small games", "Old games with 2 or fewer a side at kickoff come off careers, the way new ones never count.", "Check old games", "btn-dark", () => recountSmall(), 3)),
    ]);
  }

  async function statsReset(p) {
    let asked = null;
    const r = await formDialog({ title: p ? `Wipe ${p.name}'s career?` : "Wipe a career", okLabel: "Show what goes",
      text: "First a look at what would be cleared. Nothing changes yet.",
      fields: [p ? null : { name: "who", type: "player", label: "Player", required: true }, reasonField("Stats from a hacked client")].filter(Boolean),
      submit: async (v) => {
        const who = p ? { uuid: p.uuid, name: p.name } : await resolvePlayer(v.who);
        if (who.error) return { ok: false, error: who.error };
        asked = { who, reason: v.reason };
        return call("POST", "/maint/statsreset", { id: who.uuid, name: who.name, dry: true, reason: v.reason });
      } });
    if (!r || !asked) return;
    const c = r.career || {};
    const done = await formDialog({ title: `Wipe ${r.name || asked.who.name}'s career?`, okLabel: "Wipe it", bad: true,
      text: h("div", { class: "form" }, h("p", null, r.message || ""), h("div", { class: "stats-2" }, CAREER.map(([k, one, many]) => stat(Number(c[k] || 0).toLocaleString(), Number(c[k]) === 1 ? one : many)))),
      submit: () => call("POST", "/maint/statsreset", { id: r.uuid || asked.who.uuid, name: r.name || asked.who.name, reason: asked.reason }) });
    if (done) toast(`${done.message || "Cleared."}${done.backup ? " stats.yml was backed up first." : ""}`);
  }

  async function mergeAccounts(p) {
    let reason = "";
    const r = await formDialog({ title: "Merge two accounts", okLabel: "Show what moves",
      text: "Everything moves from the old account onto the main one, which keeps its name. First a look at what would move: nothing changes yet.",
      fields: [
        { name: "from", type: "player", label: "Old account (moves out)", value: p ? { uuid: p.uuid, name: p.name } : null, required: true },
        { name: "into", type: "player", label: "Main account (keeps everything)", required: true },
        reasonField("Same player, new account")],
      submit: async (v) => {
        const [a, b] = await Promise.all([resolvePlayer(v.from), resolvePlayer(v.into)]);
        if (a.error || b.error) return { ok: false, error: a.error || b.error };
        if (a.uuid === b.uuid) return { ok: false, error: "Those are the same account." };
        reason = v.reason;
        return call("POST", "/maint/mergeplayer", { from: a.uuid, into: b.uuid, fromName: a.name, intoName: b.name, reason: v.reason });
      } });
    if (!r || !r.from || !r.into) return;
    const done = await formDialog({ title: `Merge ${r.from.name} into ${r.into.name}?`, okLabel: "Merge them", bad: true,
      text: h("div", { class: "form" }, h("p", null, r.message || ""), partRows(r)),
      submit: () => call("POST", "/maint/mergeplayer", { from: r.from.uuid, into: r.into.uuid, fromName: r.from.name, intoName: r.into.name, confirm: true, reason }) });
    if (!done) return;
    // the game's own line for each part: one can say that part didn't move
    await formDialog({ title: "Merged", okLabel: "Done", alone: true, text: h("div", { class: "form" }, h("p", null, done.message || "Merged."), partRows(done)) });
  }

  async function recountSmall() {
    let reason = "";
    const r = await formDialog({ title: "Recount small games", okLabel: "Check",
      text: "It looks through every match in history first, which can take up to a minute. Nothing changes yet.",
      fields: [reasonField("Old 1v1s still on careers")],
      submit: (v) => { reason = v.reason; return call("POST", "/maint/recountsmall", { reason: v.reason }); } });
    if (!r) return;
    const looked = `Looked through ${plural(r.scanned || 0, "match", "matches")}${r.unreadable ? `; ${r.unreadable} couldn't be read` : ""}.`;
    if (!r.games) return void formDialog({ title: "Nothing to take off", okLabel: "Done", alone: true, text: `${r.message || "No small games are left on careers."} ${looked}` });
    const done = await formDialog({ title: `Take ${plural(r.games, "game")} off careers?`, okLabel: "Take them off", bad: true,
      text: h("div", { class: "form" }, h("p", null, r.message || ""), h("p", { class: "row-sub" }, looked)),
      submit: () => call("POST", "/maint/recountsmall", { confirm: true, reason }) });
    if (done) toast(done.message || "Done.");
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

  const ROUTES = { "": home, fixtures, matches, clubs: clubAdmin, cups, ranked, reports, tiers, players, wallet, bows, settings, server, maint, activity };

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
    // #/players/<uuid or name> is a player's page; #/clubs/<id> a club's; #/cups/<id> an old cup
    if (page === "players" && arg) profile(decodeURIComponent(arg));
    else if (page === "settings") settings(arg);
    else if (page === "clubs" || page === "cups") ROUTES[page](arg ? decodeURIComponent(arg) : "");
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
