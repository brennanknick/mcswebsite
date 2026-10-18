/* ==================================================================
   MCS admin dashboard: the Cloudflare Worker behind admin.mcsoccer.net

   One clean place for the MCS owners to run the server: fixtures,
   matches, reports, the tier list, and (as the game server's admin
   routes land) bow skins, players and Sapphires.

   Who gets in: Discord login only, and only members of the MCS Discord
   who hold the Owner role: Brenn, cold and duck (Brenn, 2026-10-18: "the
   dashboard is for me cold and duck"). The Admin role does NOT get in.
   The role is checked at sign-in and again every few minutes, so taking
   the role away takes the dashboard away. The game server checks every
   write a second time (the actor must be linked and hold a staff rank).

   What it holds: the game server's token (PLUGIN_TOKEN, a secret) and
   Discord's client secret. Neither ever reaches a browser. Every write
   is logged with who did it (the Activity page, kept 90 days in KV).

   Routes
     GET  /                  the app (app.html, app.css, app.js below)
     GET  /auth/login        to Discord's sign-in
     GET  /auth/callback     back from Discord: role check, session
     POST /auth/logout       ends the session
     GET  /tiers.js          PUBLIC: the tier list as data.js (const TIER_DATA)
     GET  /tiers.json        PUBLIC: the same as JSON (the bot's tier roles)
     /api/...                the app's calls (session + X-MCS-Admin header)

   Bindings (tools/admin/deploy.mjs sets them all)
     KV                      sessions (s:), activity (log:), the tier list (tiers)
     DISCORD_CLIENT_ID, GUILD_ID, OWNER_ROLE_ID, ORIGIN
     DISCORD_CLIENT_SECRET, PLUGIN_TOKEN                     (secrets)
     PLUGIN_ADMIN_TOKEN      (secret) the game server's admin secret: it signs
                             every request and never travels itself
   ================================================================== */

import APP_HTML from "./app.html";
import APP_CSS from "./app.css";
import APP_JS from "./app.js";

const HOST = "https://admin.mcsoccer.net";
const REDIRECT = HOST + "/auth/callback";
const DISCORD = "https://discord.com/api/v10";
const SESSION_TTL = 12 * 3600;          // seconds: sign in again after 12 hours
const RECHECK_MS = 10 * 60 * 1000;      // the Discord role, looked at again every 10 min
const LOG_TTL = 90 * 86400;             // activity kept 90 days
const PLUGIN_TIMEOUT_MS = 12000;
const WIPE_TIMEOUT_MS = 25000;          // a match wipe can take the plugin ~15 s

const SECURITY = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: https://mc-heads.net https://minotar.net https://cdn.discordapp.com https://mcsoccer.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Robots-Tag": "noindex, nofollow",
};

/* ── small helpers ─────────────────────────────────────────────────── */

function respond(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...SECURITY, ...headers } });
}
function json(data, status = 200, headers = {}) {
  return respond(JSON.stringify(data), status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}
const fail = (status, error) => json({ ok: false, error }, status);

function randomId(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Plain one-line text, at most n characters: what every field from a browser goes through. */
function clean(v, n) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
}
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
/** A settings scope the game server knows (docs/admin-api.md, "Settings (knobs)"). */
const SCOPE = /^(pitch:[A-Za-z0-9_-]{1,64}|server|sounds|ranks|crates|cosmetics)$/;
const LINE = /^[A-Za-z0-9_-]{1,64}$/;

/* ── sessions ──────────────────────────────────────────────────────── */

async function sessionOf(request, env) {
  const sid = cookies(request).mcsa;
  if (!sid || !/^[A-Za-z0-9_-]{30,60}$/.test(sid)) return null;
  const s = await env.KV.get("s:" + sid, "json");
  if (!s) return null;
  // owners only: a session from before that rule (an admin's) ends here
  if (s.role !== "owner") { await env.KV.delete("s:" + sid); return null; }
  // the role, looked at again: losing it ends the session
  if (Date.now() - (s.checked || 0) > RECHECK_MS) {
    const role = await discordRole(env, s.token).catch(() => undefined);
    if (role === undefined) return { sid, ...s };               // Discord unreachable: keep going for now
    if (!role) { await env.KV.delete("s:" + sid); return null; }
    s.role = role;
    s.checked = Date.now();
    await env.KV.put("s:" + sid, JSON.stringify(s), { expirationTtl: Math.max(60, Math.round((s.expires - Date.now()) / 1000)) });
  }
  return { sid, ...s };
}

/** "owner", null (no access), or throws (Discord unreachable). Only the Owner role gets in. */
async function discordRole(env, token) {
  const r = await fetch(`${DISCORD}/users/@me/guilds/${env.GUILD_ID}/member`, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 401 || r.status === 403 || r.status === 404) return null;   // token gone, or not in the server
  if (!r.ok) throw new Error("discord " + r.status);
  const m = await r.json();
  const roles = Array.isArray(m.roles) ? m.roles : [];
  return roles.includes(env.OWNER_ROLE_ID) ? "owner" : null;
}

/* ── sign in with Discord ──────────────────────────────────────────── */

function login(env) {
  const state = randomId(18);
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("scope", "identify guilds.members.read");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "none");
  return respond(null, 302, { Location: u.href, "Set-Cookie": cookie("mcsa_state", state, 600), "Cache-Control": "no-store" });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const want = cookies(request).mcsa_state;
  if (url.searchParams.get("error")) return page("Sign-in was cancelled", "Discord didn't sign you in. You can try again.", true);
  if (!code || !state || !want || state !== want) return page("That sign-in link expired", "Start again from the sign-in button.", true);

  const tok = await fetch(`${DISCORD}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
    }),
  });
  if (!tok.ok) return page("Discord didn't accept that sign-in", "Try again in a moment.", true);
  const t = await tok.json();
  const me = await fetch(`${DISCORD}/users/@me`, { headers: { Authorization: "Bearer " + t.access_token } });
  if (!me.ok) return page("Discord didn't say who you are", "Try again in a moment.", true);
  const user = await me.json();

  let role;
  try { role = await discordRole(env, t.access_token); } catch { role = undefined; }
  if (role === undefined) return page("Discord isn't answering", "Your roles couldn't be checked. Try again in a moment.", true);
  if (!role) {
    await log(env, { id: user.id, name: user.global_name || user.username }, "sign-in refused", "no Owner role", false);
    return page("This dashboard is for the MCS owners", "Your Discord account doesn't have the Owner role in the MCS Discord.", false);
  }

  const sid = randomId(32);
  const now = Date.now();
  const s = {
    id: user.id,
    name: clean(user.global_name || user.username, 32) || "admin",
    username: clean(user.username, 32),
    avatar: user.avatar || null,
    role,
    token: t.access_token,
    created: now,
    checked: now,
    expires: now + SESSION_TTL * 1000,
  };
  await env.KV.put("s:" + sid, JSON.stringify(s), { expirationTtl: SESSION_TTL });
  await log(env, s, "signed in", role, true);
  // a page, not a redirect, so the next request is a same-site one
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Signing in…</title><p style="font-family:sans-serif;color:#ccc;background:#0b1210">Signing in…</p>`;
  const h = new Headers({ ...SECURITY, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  h.append("Set-Cookie", cookie("mcsa", sid, SESSION_TTL));
  h.append("Set-Cookie", cookie("mcsa_state", "", 0));
  return new Response(body, { status: 200, headers: h });
}

async function logout(request, env) {
  const sid = cookies(request).mcsa;
  if (sid && /^[A-Za-z0-9_-]{30,60}$/.test(sid)) {
    const s = await env.KV.get("s:" + sid, "json");
    if (s) await log(env, s, "signed out", "", true);
    await env.KV.delete("s:" + sid);
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie("mcsa", "", 0) });
}

/** A small page in the dashboard's colours, for sign-in problems. */
function page(title, text, retry) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — MCS Admin</title><link rel="stylesheet" href="/app.css"></head>
<body class="gate"><main class="gate-card"><img src="https://mcsoccer.net/assets/img/logo.png" alt="MCS" width="72" height="72"><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? '<a class="btn" href="/auth/login">Sign in with Discord</a>' : '<a class="btn btn-dark" href="https://mcsoccer.net/">Back to mcsoccer.net</a>'}</main></body></html>`;
  return respond(html, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
}

/* ── activity log ──────────────────────────────────────────────────── */

async function log(env, who, action, detail, ok) {
  const at = Date.now();
  // newest first in a KV listing: the key sorts by time, reversed
  const key = `log:${String(9999999999999 - at).padStart(13, "0")}:${randomId(4)}`;
  const entry = { at, who: { id: who.id, name: who.name }, action: clean(action, 80), detail: clean(detail, 300), ok: !!ok };
  try { await env.KV.put(key, JSON.stringify(entry), { expirationTtl: LOG_TTL }); } catch {}
}

/* ── the game server ───────────────────────────────────────────────── */

/**
 * One call to the plugin's token API (/discord/*). Params go in the query string, as the
 * plugin reads them. Resolves { ok, status, body } and never throws.
 */
async function plugin(env, method, path, params = {}, timeoutMs = PLUGIN_TIMEOUT_MS, send = null) {
  const u = new URL(env.ORIGIN.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  // the body as the exact bytes sent, so its hash matches
  const payload = send ? (typeof send.body === "string" ? enc.encode(send.body) : send.body) : null;
  const headers = await authHeaders(env, method, u, payload);
  if (send) headers["Content-Type"] = send.type;
  let r;
  try {
    r = await fetch(u.href, { method, headers, body: payload || undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, status: 0, body: { error: "The game server isn't answering right now." } };
  }
  // JSON almost everywhere; the bow panel answers its errors in plain text
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (r.ok && (!body || body.ok !== false)) return { ok: true, status: r.status, body };
  let error = body && typeof body.error === "string" && body.error.trim() ? body.error.trim()
    : body && typeof body.message === "string" && body.message.trim() ? body.message.trim()
    : !body && text && text.length < 300 && !/^\s*</.test(text) ? text.trim() : null;
  if (error === "not allowed") error = "The game server says your account isn't allowed to do that. It needs your Minecraft account linked and set as owner in game (/rank set).";
  else if (error === "reason required") error = "Give a reason.";
  if (!error) {
    error = r.status === 401 || r.status === 403 ? "The game server refused the dashboard's token."
      : r.status === 404 ? "The game server doesn't have that yet (it needs a plugin update)."
      : r.status === 429 ? "That's a lot of changes at once: wait a minute and try again."
      : r.status === 503 ? "The game server is busy or still loading. Check before trying again."
      : `The game server answered ${r.status}.`;
  }
  return { ok: false, status: r.status, body: { error: error.slice(0, 300) } };
}

/** The plugin's public API (/api/v1/*), no token. */
async function publicApi(env, path, params = {}) {
  const u = new URL(env.ORIGIN.replace(/\/+$/, "") + "/api/v1" + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  try {
    const r = await fetch(u.href, { signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS) });
    const body = await r.json().catch(() => null);
    return r.ok ? { ok: true, body } : { ok: false, status: r.status, body: { error: `The game server answered ${r.status}.` } };
  } catch {
    return { ok: false, status: 0, body: { error: "The game server isn't answering right now." } };
  }
}

const by = (s) => `dashboard:${clean(s.name, 32)} (${s.id})`;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * How the game server knows it's us (docs/admin-api.md, "Signed requests"). The hop to it is
 * plain HTTP, so the admin secret never travels: each request carries the time and an HMAC of
 * method, raw path, raw query, that time and the body's SHA-256, keyed with the secret. Each
 * signature works once and for two minutes, so every call (and every retry) signs afresh.
 * The bot's token goes along only while PLUGIN_TOKEN is still set (the server falls back to it
 * for the bot routes): drop that secret once signing is confirmed.
 */
async function authHeaders(env, method, u, body) {
  const h = {};
  if (env.PLUGIN_TOKEN) h["X-Soccer-Token"] = env.PLUGIN_TOKEN;
  if (!env.PLUGIN_ADMIN_TOKEN) return h;
  const ts = String(Date.now());
  const bodyHash = body ? hex(await crypto.subtle.digest("SHA-256", body)) : "";
  const msg = [method, u.pathname, u.search.slice(1), ts, bodyHash].join("\n");
  const key = await crypto.subtle.importKey("raw", enc.encode(env.PLUGIN_ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  h["X-Soccer-Ts"] = ts;
  h["X-Soccer-Sig"] = hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  if (body) h["X-Soccer-Body-Sha256"] = bodyHash;
  return h;
}

/* ── the tier list ─────────────────────────────────────────────────── */

const TIER_COLORS = ["#ffcf4a", "#ff9a3c", "#ff5f6d", "#c084fc", "#5b9dff", "#2dd4bf", "#8b96a5"];

/** A tier list from a browser, cleaned: 1-12 tiers, names unique, at most 40 a band. */
function cleanTiers(input) {
  const tiers = Array.isArray(input && input.tiers) ? input.tiers : null;
  if (!tiers || !tiers.length || tiers.length > 12) return null;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] || {};
    const color = /^#[0-9a-f]{6}$/i.test(String(t.color || "")) ? String(t.color).toLowerCase() : (TIER_COLORS[i] || "#8b96a5");
    const band = (list) => {
      const names = [];
      for (const n of Array.isArray(list) ? list : []) {
        const name = clean(n, 16);
        if (!NAME.test(name) || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        names.push(name);
        if (names.length >= 40) break;
      }
      return names;
    };
    out.push({ tier: i + 1, color, high: band(t.high), low: band(t.low) });
  }
  return out;
}

async function tierData(env) {
  const t = await env.KV.get("tiers", "json");
  return t || null;
}

/**
 * The old tier list's data.js (a JavaScript object: bare keys, trailing commas, comments)
 * as JSON. Workers can't eval, so a small string-aware rewrite: drop the comments, quote
 * the keys, drop trailing commas. Used once, to bring the tier list into the dashboard.
 */
function jsObjectToJson(src) {
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  // pass 1: comments out, strings kept as they are
  let noComments = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      noComments += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i + 2);
      i = e < 0 ? src.length : e;
    } else {
      noComments += c;
      i++;
    }
  }
  // pass 2: keys quoted, strings as JSON strings, trailing commas gone
  const s = noComments;
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") {
      // a JS string's body is a JSON string's body, but for \' and a bare " inside '...'
      let j = i + 1, body = "";
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\") { body += s[j + 1] === "'" ? "'" : s.slice(j, j + 2); j += 2; }
        else { body += c === "'" && s[j] === '"' ? '\\"' : s[j]; j++; }
      }
      out += '"' + body + '"';
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && isId(s[j])) j++;
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k++;
      out += s[k] === ":" ? JSON.stringify(s.slice(i, j)) : s.slice(i, j);
      i = j;
    } else if (c === ",") {
      let k = i + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] !== "}" && s[k] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  const a = out.indexOf("{"), b = out.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no object");
  return JSON.parse(out.slice(a, b + 1));
}

/* ── the app's API ─────────────────────────────────────────────────── */

async function api(request, env, s, path) {
  const method = request.method;
  // writes: our own page only (a header a cross-site form can't send, and the right Origin)
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (request.headers.get("X-MCS-Admin") !== "1" || (origin && origin !== HOST)) return fail(403, "Refused.");
  }
  let input = {};
  if (method === "POST" || method === "PUT") {
    try { input = await request.json(); } catch { return fail(400, "That request wasn't readable."); }
    if (!input || typeof input !== "object") input = {};
  }
  const q = new URL(request.url).searchParams;
  const who = { id: s.id, name: s.name };
  const done = async (r, action, detail) => {
    await log(env, who, action, detail + (r.ok ? "" : ` (refused: ${r.body && r.body.error})`), r.ok);
    return json(r.ok ? { ok: true, ...(r.body || {}) } : { ok: false, error: (r.body && r.body.error) || "That didn't work." }, r.ok ? 200 : (r.status >= 400 && r.status < 500 ? 400 : 502));
  };

  switch (`${method} ${path}`) {
    case "GET /me":
      return json({ ok: true, me: { id: s.id, name: s.name, username: s.username, avatar: s.avatar, role: s.role, expires: s.expires } });

    case "GET /status": {
      const [ping, meta] = await Promise.all([plugin(env, "GET", "/discord/ping"), publicApi(env, "/meta")]);
      return json({ ok: true, server: ping.ok, meta: meta.ok ? meta.body : null, admin: !!env.PLUGIN_ADMIN_TOKEN });
    }

    /* fixtures */
    case "GET /fixtures": {
      const r = await plugin(env, "GET", "/discord/fixtures", { since: 0 });
      return r.ok ? json({ ok: true, fixtures: (r.body && r.body.fixtures) || [] }) : json({ ok: false, error: r.body.error }, 502);
    }
    case "GET /clubs": {
      const r = await plugin(env, "GET", "/discord/clubs");
      return r.ok ? json({ ok: true, clubs: (r.body && r.body.clubs) || [] }) : json({ ok: false, error: r.body.error }, 502);
    }
    case "GET /pitches": {
      const r = await plugin(env, "GET", "/discord/pitches");
      return r.ok ? json({ ok: true, pitches: (r.body && r.body.pitches) || [] }) : json({ ok: false, error: r.body.error }, 502);
    }
    case "POST /fixtures/create": {
      const p = {
        home: clean(input.home, 64), away: clean(input.away, 64), kickoff: Math.round(Number(input.kickoff) || 0),
        label: clean(input.label, 60), competition: clean(input.competition, 60), pitch: clean(input.pitch, 64),
        tbd: input.tbd ? "true" : undefined, knockout: input.knockout ? "true" : undefined, by: by(s),
      };
      if (!ID.test(p.home) || !ID.test(p.away) || p.home === p.away) return fail(400, "Pick two different clubs.");
      if (!(p.kickoff > Date.now())) return fail(400, "Pick a time in the future.");
      const r = await plugin(env, "POST", "/discord/fixtures", p);
      // the clubs' names, as the game server knows them, for the activity log
      const fx = r.ok && r.body && r.body.fixture;
      const names = fx && fx.home && fx.away ? `${fx.home.name} vs ${fx.away.name}` : `${p.home} vs ${p.away}`;
      return done(r, "booked a fixture", `${names}${p.label ? ", " + p.label : ""}${p.tbd ? ", time TBD" : ""}`);
    }
    case "POST /fixtures/edit": {
      const id = clean(input.id, 64);
      if (!ID.test(id)) return fail(400, "Which fixture?");
      const p = { id, by: by(s) };
      if (input.kickoff != null) {
        const k = Math.round(Number(input.kickoff) || 0);
        if (!(k > Date.now())) return fail(400, "Pick a time in the future.");
        p.kickoff = k;
      }
      if (input.tbd != null) p.tbd = input.tbd ? "true" : "false";
      for (const k of ["home", "away", "pitch"]) if (input[k]) p[k] = clean(input[k], 64);
      for (const k of ["label", "competition"]) if (input[k] != null) p[k] = clean(input[k], 60);
      const r = await plugin(env, "POST", "/discord/fixtures/edit", p);
      return done(r, "edited a fixture", `#${id}`);
    }
    case "POST /fixtures/cancel": {
      const id = clean(input.id, 64);
      if (!ID.test(id)) return fail(400, "Which fixture?");
      const r = await plugin(env, "POST", "/discord/fixtures/cancel", { id, by: by(s) });
      return done(r, "cancelled a fixture", `#${id}`);
    }
    case "POST /fixtures/forfeit": {
      const id = clean(input.id, 64);
      const winner = input.winner === "home" || input.winner === "away" ? input.winner : null;
      if (!ID.test(id) || !winner) return fail(400, "Pick the fixture and who gets the win.");
      const p = { id, winner, by: by(s) };
      for (const k of ["home", "away"]) if (input[k] !== "" && input[k] != null && Number.isInteger(Number(input[k])) && Number(input[k]) >= 0) p[k] = Number(input[k]);
      const r = await plugin(env, "POST", "/discord/fixtures/forfeit", p);
      return done(r, "gave a walkover", `#${id} to ${winner}`);
    }
    case "POST /fixtures/result": {
      const id = clean(input.id, 64);
      const h = Number(input.home), a = Number(input.away);
      if (!ID.test(id) || !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 999 || a > 999) return fail(400, "Give both scores.");
      const r = await plugin(env, "POST", "/discord/fixtures/result", { id, home: h, away: a, by: by(s) });
      return done(r, "entered a result", `#${id} ${h}-${a}`);
    }

    /* matches */
    case "GET /matches": {
      const page = Math.max(1, Math.min(500, parseInt(q.get("page") || "1", 10) || 1));
      const r = await publicApi(env, "/matches", { page, size: 20, fixtures: q.get("fixtures") || undefined });
      return r.ok ? json({ ok: true, ...r.body }) : json({ ok: false, error: r.body.error }, 502);
    }
    case "POST /matches/wipe": {
      const id = clean(input.id, 100);
      if (!ID.test(id)) return fail(400, "Which match?");
      const dry = !!input.dry;
      const r = await plugin(env, "POST", "/discord/matches/wipe", { id, by: by(s), dry: dry ? 1 : undefined }, dry ? PLUGIN_TIMEOUT_MS : WIPE_TIMEOUT_MS);
      if (dry) return r.ok ? json({ ok: true, ...(r.body || {}) }) : json({ ok: false, error: r.body.error }, 400);
      return done(r, "deleted a match", id);
    }

    /* reports */
    case "GET /reports": {
      const status = q.get("status") === "all" ? "all" : "open";
      const r = await plugin(env, "GET", "/discord/reports", { status });
      return r.ok ? json({ ok: true, items: (r.body && r.body.items) || [] }) : json({ ok: false, error: r.body.error }, 502);
    }
    case "POST /reports/close": {
      const id = clean(input.id, 16);
      const how = input.how === "invalid" ? "invalid" : input.how === "handled" ? "handled" : null;
      if (!/^[0-9a-f]{8}$/i.test(id) || !how) return fail(400, "Which report, and handled or invalid?");
      const r = await plugin(env, "POST", "/discord/reports/close", { id, how, by: clean(s.name, 32) + " (dashboard)" });
      return done(r, how === "invalid" ? "marked a report invalid" : "handled a report", id);
    }

    /* the tier list */
    case "GET /tiers/import": {
      // the old tier list site's data.js, read here (the app's own page may only call us)
      let data;
      try {
        const r = await fetch("https://tiers.mcsoccer.net/data.js?cb=" + Date.now(), { signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS) });
        if (!r.ok) throw new Error(String(r.status));
        data = jsObjectToJson(await r.text());
      } catch {
        return fail(502, "The current tier list couldn't be read.");
      }
      const tiers = cleanTiers(data);
      return tiers ? json({ ok: true, data: { tiers } }) : fail(502, "The current tier list couldn't be read.");
    }
    case "GET /tiers": {
      const t = await tierData(env);
      return json({ ok: true, data: t });
    }
    case "PUT /tiers": {
      const tiers = cleanTiers(input);
      if (!tiers) return fail(400, "That tier list wasn't readable.");
      const now = await tierData(env);
      // two admins at once: the second save is refused, not silently merged
      if (now && input.version != null && Number(input.version) !== Number(now.version || 0)) {
        return fail(409, "Someone else saved the tier list while you were editing. Reload to see their changes.");
      }
      const next = { version: (Number(now && now.version) || 0) + 1, updated: new Date().toISOString().slice(0, 10), savedAt: Date.now(), savedBy: who.name, tiers };
      await env.KV.put("tiers", JSON.stringify(next));
      const count = tiers.reduce((n, t) => n + t.high.length + t.low.length, 0);
      await log(env, who, "saved the tier list", `${count} players${input.note ? ": " + clean(input.note, 200) : ""}`, true);
      return json({ ok: true, version: next.version, updated: next.updated });
    }

    /* activity */
    case "GET /activity": {
      const list = await env.KV.list({ prefix: "log:", limit: 100, cursor: q.get("cursor") || undefined });
      const items = (await Promise.all(list.keys.map((k) => env.KV.get(k.name, "json")))).filter(Boolean);
      return json({ ok: true, items, cursor: list.list_complete ? null : list.cursor });
    }

    /* players, Sapphires, ranks, cosmetics, bow skins: the game server's admin routes */
    case "GET /players": {
      const r = await plugin(env, "GET", "/discord/admin/players", { q: clean(q.get("q"), 16) });
      return r.ok ? json({ ok: true, items: (r.body && r.body.items) || [] }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "GET /player": {
      const r = await plugin(env, "GET", "/discord/admin/player", { id: clean(q.get("id"), 40) });
      return r.ok ? json({ ok: true, player: r.body }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /sapphires": {
      // owners only (Brenn, 2026-10-18; the game server checks it too)
      if (s.role !== "owner") return fail(403, "Only owners can give or take Sapphires.");
      const p = { id: clean(input.id, 40), op: input.op === "take" ? "take" : "give", amount: Math.round(Number(input.amount) || 0), reason: clean(input.reason, 120), key: clean(input.key, 64), by: by(s) };
      if (!p.id || !(p.amount > 0) || !p.reason) return fail(400, "Give a player, an amount and a reason.");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.key)) return fail(400, "Reload the page and try again.");
      const r = await plugin(env, "POST", "/discord/admin/sapphires", p);
      return done(r, p.op === "take" ? "took Sapphires" : "gave Sapphires", `${p.amount} ${p.op === "take" ? "from" : "to"} ${input.name ? clean(input.name, 16) : p.id}: ${p.reason}`);
    }
    case "POST /rank": {
      // owners only (the game server checks it too)
      if (s.role !== "owner") return fail(403, "Only owners can change ranks.");
      const op = ["give", "take", "set"].includes(input.op) ? input.op : null;
      const rank = clean(input.rank, 20).toLowerCase();
      const ranks = op === "set" ? ["owner", "admin", "developer", "mod", "helper", "media", "affiliate", "none"] : ["vip", "mvp"];
      const p = { id: clean(input.id, 40), op, rank, reason: clean(input.reason, 120), by: by(s) };
      if (op === "give" && rank === "mvp" && input.days) p.days = Math.max(1, Math.min(3650, Math.round(Number(input.days) || 30)));
      if (op === "give") {
        p.key = clean(input.key, 64);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.key)) return fail(400, "Reload the page and try again.");
      }
      if (!p.id || !op || !ranks.includes(rank) || !p.reason) return fail(400, "Give a player, a rank and a reason.");
      const r = await plugin(env, "POST", "/discord/admin/rank", p);
      return done(r, op === "set" ? "set a staff rank" : op === "give" ? "gave a rank" : "took a rank", `${rank.toUpperCase()}${p.days ? ` (${p.days} days)` : ""} ${op === "take" ? "from" : "for"} ${input.name ? clean(input.name, 16) : p.id}: ${p.reason}`);
    }
    case "GET /cosmetics/catalog": {
      const r = await plugin(env, "GET", "/discord/admin/cosmetics/catalog");
      return r.ok ? json({ ok: true, items: (r.body && r.body.items) || [] }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /cosmetics": {
      // owners only (Brenn, 2026-10-18: admins don't hand out cosmetics)
      if (s.role !== "owner") return fail(403, "Only owners can give or take cosmetics.");
      const p = { id: clean(input.id, 40), op: input.op === "take" ? "take" : "give", cosmetic: clean(input.cosmetic, 64), reason: clean(input.reason, 120), by: by(s) };
      if (!p.id || !p.cosmetic || !p.reason) return fail(400, "Give a player, a cosmetic and a reason.");
      const r = await plugin(env, "POST", "/discord/admin/cosmetics", p);
      return done(r, p.op === "take" ? "took a cosmetic" : "gave a cosmetic", `${p.cosmetic} ${p.op === "take" ? "from" : "to"} ${input.name ? clean(input.name, 16) : p.id}: ${p.reason}`);
    }

    /* settings: the staff menus' knobs. No scope: the list of scopes; a scope: its settings */
    case "GET /knobs": {
      const scope = clean(q.get("scope"), 80);
      if (scope && !SCOPE.test(scope)) return fail(400, "Which settings?");
      const r = await plugin(env, "GET", "/discord/admin/knobs", scope ? { scope } : {});
      return r.ok ? json({ ok: true, ...(r.body || {}) }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /knobs": {
      const scope = clean(input.scope, 80);
      const key = clean(input.key, 80);
      // a list (the command allow-list) can run long: it's comma separated text
      const value = input.value == null ? "" : String(input.value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
      const reason = clean(input.reason, 120);
      if (!SCOPE.test(scope) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(key) || !reason) return fail(400, "Which setting, and why?");
      const r = await plugin(env, "POST", "/discord/admin/knobs", { scope, key, value, reason, by: by(s) });
      return done(r, "changed a setting", `${scope} ${key} = ${value.slice(0, 60)}: ${reason}`);
    }

    /* the server: who's on, every pitch, the pack; restart, call off, reload, resend the pack */
    case "GET /server": {
      const r = await plugin(env, "GET", "/discord/admin/server");
      return r.ok ? json({ ok: true, ...(r.body || {}) }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /server/restart":
    case "POST /server/restart/cancel":
    case "POST /server/reload":
    case "POST /server/pack/resend": {
      if (s.role !== "owner") return fail(403, "Only owners can do that.");
      const p = { reason: clean(input.reason, 120), by: by(s) };
      if (!p.reason) return fail(400, "Give a reason.");
      if (path === "/server/restart") {
        p.delay = Math.max(10, Math.min(600, Math.round(Number(input.delay) || 60)));
        if (input.force === true) p.force = "true";
      }
      const r = await plugin(env, "POST", "/discord/admin" + path, p);
      const what = { "/server/restart": "asked for a restart", "/server/restart/cancel": "called off a restart", "/server/reload": "reloaded the config", "/server/pack/resend": "sent the pack again" }[path];
      return done(r, what, `${p.delay ? `in ${p.delay} s${p.force ? ", forced" : ""}: ` : ""}${p.reason}`);
    }

    /* the wallet's tools (owners): a store order looked up, added by hand or taken back; a wallet fixed */
    case "GET /wallet/audit": {
      if (s.role !== "owner") return fail(403, "Only owners can use the wallet tools.");
      const term = clean(q.get("q"), 80);
      if (!term) return fail(400, "Give an order, line or pretty id.");
      const r = await plugin(env, "GET", "/discord/admin/wallet/audit", { q: term });
      return r.ok ? json({ ok: true, ...(r.body || {}) }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /wallet/grant": {
      if (s.role !== "owner") return fail(403, "Only owners can use the wallet tools.");
      const p = { id: clean(input.id, 40), amount: Math.round(Number(input.amount) || 0), line: clean(input.line, 64), order: clean(input.order, 64), pretty: clean(input.pretty, 64), reason: clean(input.reason, 120), by: by(s) };
      if (input.starter === true) p.starter = "true";
      if (!p.id || !(p.amount > 0 && p.amount <= 1000000) || !p.reason) return fail(400, "Give a player, an amount and a reason.");
      if (!LINE.test(p.line)) return fail(400, "The line id takes only letters, numbers, - and _.");
      const r = await plugin(env, "POST", "/discord/admin/wallet/grant", p);
      return done(r, "added a store order by hand", `${p.amount}${p.starter ? " (starter)" : ""} to ${input.name ? clean(input.name, 36) : p.id}, line ${p.line}: ${p.reason}`);
    }
    case "POST /wallet/reverse": {
      if (s.role !== "owner") return fail(403, "Only owners can use the wallet tools.");
      const p = { line: clean(input.line, 64), kind: ["refund", "chargeback", "revoke"].includes(input.kind) ? input.kind : "", reason: clean(input.reason, 120), by: by(s) };
      if (!LINE.test(p.line) || !p.kind || !p.reason) return fail(400, "Give the line id, how it's taken back, and a reason.");
      const r = await plugin(env, "POST", "/discord/admin/wallet/reverse", p);
      return done(r, "took back a store order", `line ${p.line} (${p.kind}): ${p.reason}`);
    }
    case "POST /wallet/reset":
    case "POST /wallet/unpause": {
      if (s.role !== "owner") return fail(403, "Only owners can use the wallet tools.");
      const p = { id: clean(input.id, 40), key: clean(input.key, 64), reason: clean(input.reason, 120), by: by(s) };
      if (!p.id || !p.reason) return fail(400, "Give a player and a reason.");
      if (!/^[A-Za-z0-9_-]{8,59}$/.test(p.key)) return fail(400, "Reload the page and try again.");
      const r = await plugin(env, "POST", "/discord/admin" + path, p);
      return done(r, path === "/wallet/reset" ? "reset a wallet to zero" : "cleared a wallet's debt", `${input.name ? clean(input.name, 36) : p.id}: ${p.reason}`);
    }

    /* bow skins: the game server's bow panel, through its admin routes */

    case "GET /bows": {
      const r = await plugin(env, "GET", "/discord/admin/bows");
      return r.ok ? json({ ok: true, ...(r.body || {}) }) : json({ ok: false, error: r.body.error, status: r.status }, r.status === 404 ? 404 : 502);
    }
    case "POST /bows/create":
    case "POST /bows/name": {
      const slug = clean(input.slug, 40).toLowerCase();
      const name = clean(input.name, 60);
      const reason = clean(input.reason, 120);
      if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return fail(400, "The folder name takes only letters, numbers, - and _.");
      if (path === "/bows/name" && !name) return fail(400, "A bow skin needs a name.");
      if (!reason) return fail(400, "Give a reason.");
      const what = path === "/bows/create" ? "create" : "name";
      const r = await plugin(env, "POST", `/discord/admin/bows/${what}`, { slug, reason, by: by(s) }, PLUGIN_TIMEOUT_MS, { type: "text/plain; charset=utf-8", body: name });
      return done(r, what === "create" ? "made a bow skin" : "renamed a bow skin", `${slug}${name ? ` "${name}"` : ""}: ${reason}`);
    }
    case "POST /bows/delete": {
      const slug = clean(input.slug, 40).toLowerCase();
      const reason = clean(input.reason, 120);
      if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !reason) return fail(400, "Which bow skin, and why?");
      const r = await plugin(env, "POST", "/discord/admin/bows/delete", { slug, reason, by: by(s) });
      return done(r, "deleted a bow skin", `${slug}: ${reason}`);
    }
  }
  return fail(404, "Not a dashboard route.");
}

/** A bow skin frame (an image): POST /api/bows/upload?slug=&frame=1..4&reason= with the PNG as the body. */
async function bowUpload(request, env, s) {
  const q = new URL(request.url).searchParams;
  const slug = clean(q.get("slug"), 40).toLowerCase();
  const frame = Number(q.get("frame"));
  const reason = clean(q.get("reason"), 120);
  if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !(frame >= 1 && frame <= 4) || !reason) return fail(400, "Which bow skin and frame, and why?");
  const png = new Uint8Array(await request.arrayBuffer());
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 8 || MAGIC.some((b, i) => png[i] !== b)) return fail(400, "That isn't a PNG.");
  if (png.length > 256 * 1024) return fail(400, "That image is too big (256 KB at most).");
  const r = await plugin(env, "POST", "/discord/admin/bows/upload", { slug, frame, reason, by: by(s) }, PLUGIN_TIMEOUT_MS, { type: "image/png", body: png });
  await log(env, { id: s.id, name: s.name }, "uploaded a bow skin frame", `${slug} frame ${frame}: ${reason}${r.ok ? "" : ` (refused: ${r.body.error})`}`, r.ok);
  return json(r.ok ? { ok: true } : { ok: false, error: r.body.error }, r.ok ? 200 : 400);
}

/** A bow skin frame's image, for the dashboard's previews (signed-in only). */
async function bowTexture(env, path) {
  const m = path.match(/^\/bows\/tex\/([a-z0-9_-]{1,40})\/([0-3])\.png$/);
  if (!m) return respond("no such frame", 404);
  const u = new URL(env.ORIGIN.replace(/\/+$/, "") + `/discord/admin/bows/tex/${m[1]}/${m[2]}.png`);
  const headers = await authHeaders(env, "GET", u, null);
  try {
    const r = await fetch(u.href, { headers, signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS) });
    if (!r.ok || !(r.headers.get("Content-Type") || "").startsWith("image/png")) return respond("no such frame", 404);
    return respond(r.body, 200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=60" });
  } catch {
    return respond("the game server isn't answering", 502);
  }
}

/* ── the Worker ────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // public: the tier list for mcsoccer.net/tiers and the bot
      if (path === "/tiers.js" || path === "/tiers.json") {
        const t = await tierData(env);
        if (!t) return respond("tier list not set up yet", 404, { "Access-Control-Allow-Origin": "*" });
        const data = { meta: { title: "MCS", updated: t.updated, version: t.version }, tiers: t.tiers, discord: "" };
        const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" };
        return path === "/tiers.json"
          ? respond(JSON.stringify(data), 200, { ...headers, "Content-Type": "application/json; charset=utf-8" })
          : respond(`/* MCS tier list, from admin.mcsoccer.net */\nconst TIER_DATA = ${JSON.stringify(data)};\n`, 200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" });
      }

      if (path === "/app.css") return respond(APP_CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
      if (path === "/app.js") return respond(APP_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      if (path === "/auth/login" && method === "GET") return login(env);
      if (path === "/auth/callback" && method === "GET") return callback(request, env);
      if (path === "/auth/logout" && method === "POST") return logout(request, env);

      if (path.startsWith("/api/")) {
        const s = await sessionOf(request, env);
        if (!s) return fail(401, "Signed out.");
        const sub = path.slice(4);
        // two that aren't JSON: a bow frame's image, and a bow frame's upload
        if (method === "GET" && sub.startsWith("/bows/tex/")) return bowTexture(env, sub);
        if (method === "POST" && sub === "/bows/upload") {
          const origin = request.headers.get("Origin");
          if (request.headers.get("X-MCS-Admin") !== "1" || (origin && origin !== HOST)) return fail(403, "Refused.");
          return bowUpload(request, env, s);
        }
        return api(request, env, s, sub);
      }

      if (path === "/" && method === "GET") {
        const s = await sessionOf(request, env);
        if (!s) {
          return page("MCS Admin", "Sign in with your Discord account. It's for the MCS owners.", true);
        }
        return respond(APP_HTML, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      }
      if (path === "/favicon.ico") return respond(null, 302, { Location: "https://mcsoccer.net/favicon.ico" });
      return respond("Not found", 404, { "Content-Type": "text/plain" });
    } catch (e) {
      return json({ ok: false, error: "Something went wrong in the dashboard." }, 500);
    }
  },
};
