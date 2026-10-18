// Local test bench for the admin dashboard (never deployed).
//   node tools/admin/dev.mjs [--port=8799]
// Runs worker.js in Node on http://localhost:<port> with an in-memory KV, and signs you in
// as a TEST owner at /__login (local only: Discord's real sign-in can't come back to
// localhost). Reads (GET) go to the real game server's API; writes (POST) are answered here
// with { ok: true } and never reach the game server, so every button can be tried safely.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "--port=8799").split("=")[1]);
const REAL = "http://104.194.11.160:25543";
const TOKEN = (() => {
  const env = fs.readFileSync("C:/Users/brenn/soccer/soccer/discord-bot/.env", "utf8");
  const m = env.match(/^SOCCER_API_TOKEN=(.*)$/m);
  return m ? m[1].trim() : "";
})();

// the worker, with its text imports inlined and its host set to this bench
const read = (f) => fs.readFileSync(path.join(HERE, f), "utf8");
// (function replacements: a string one would read the "$$" in app.js as an escape)
const src = read("worker.js")
  .replace('import APP_HTML from "./app.html";', () => `const APP_HTML = ${JSON.stringify(read("app.html"))};`)
  .replace('import APP_CSS from "./app.css";', () => `const APP_CSS = ${JSON.stringify(read("app.css"))};`)
  .replace('import APP_JS from "./app.js";', () => `const APP_JS = ${JSON.stringify(read("app.js"))};`)
  .replace('const HOST = "https://admin.mcsoccer.net";', () => `const HOST = "http://localhost:${PORT}";`);
const tmp = path.join(process.env.TEMP || "/tmp", `mcs-admin-dev-${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
const worker = (await import("file:///" + tmp.replace(/\\/g, "/"))).default;

// an in-memory KV with the calls the worker uses
const store = new Map();
const KV = {
  async get(k, type) { const v = store.get(k); if (!v || (v.exp && v.exp < Date.now())) return null; return type === "json" ? JSON.parse(v.value) : v.value; },
  async put(k, value, o = {}) { store.set(k, { value: String(value), exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }); },
  async delete(k) { store.delete(k); },
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: null };
  },
};

// the game server, as the worker sees it: real reads, pretend writes
const ORIGIN = `http://localhost:${PORT}/__plugin`;
const env = { KV, ORIGIN, PLUGIN_TOKEN: "bench", DISCORD_CLIENT_ID: "0", GUILD_ID: "0", OWNER_ROLE_ID: "1", DISCORD_CLIENT_SECRET: "x" };

// samples in the shape of docs/admin-api.md, for when the real server doesn't have the admin routes yet
const SAMPLE_PLAYER = { uuid: "a1b2c3d4-0000-4000-8000-000000000001", name: "DuckyWins", online: true, firstSeen: Date.now() - 40 * 864e5, lastSeen: Date.now(),
  discord: "123", discordTag: "duckyonlywins",
  ranks: { shown: "vipplus", held: ["vipplus", "vip"], staff: "admin", vip: true, mvpUntil: Date.now() + 20 * 864e5, hidden: false, flight: true, display: false },
  wallet: { balance: 1250, paid: 1050, earned: 200, crates: 1 },
  ledger: [{ at: Date.now() - 3600e3, kind: "give", amount: 200, paidAfter: 1050, earnedAfter: 200, reason: "Giveaway winner", by: "dashboard:karlazuz (1)", ref: "k1" },
    { at: Date.now() - 86400e3, kind: "grant", amount: 1050, paidAfter: 1050, earnedAfter: 0, reason: "PayNow order", by: "paynow", ref: "o1" }],
  cosmetics: ["trail:flame", "bow:vip_bow"] };
const SAMPLE = {
  "/discord/admin/players": { items: [{ uuid: SAMPLE_PLAYER.uuid, name: "DuckyWins", online: true }, { uuid: "a1b2c3d4-0000-4000-8000-000000000002", name: "duckudertruck", online: false }] },
  "/discord/admin/player": SAMPLE_PLAYER,
  "/discord/admin/cosmetics/catalog": { items: [{ id: "trail:flame", name: "Flame", type: "trail", rarity: "rare", crate: "Stadium Crate", perk: null },
    { id: "celebration:supernova", name: "Supernova", type: "celebration", rarity: "legendary", crate: "Stadium Crate", perk: null },
    { id: "bow:vip_bow", name: "VIP Bow", type: "bow", rarity: "epic", crate: null, perk: "vip" }] },
  "/discord/admin/bows": { pack: "abcd1234", warnings: [], bows: [{ slug: "golden_boot", name: "Golden Boot", id: 7, stamp: "s1", own: [true, true, true, true], frames: [true, true, true, false] }] },
};
const SAMPLE_PNG = fs.readFileSync("C:/Users/brenn/soccer/rank-art/mcs/tags/vip_tag.png");

// stage 2 samples (docs/admin-api.md): the scopes, a few knobs of every type, the server, an order's audit
const SCOPES = [{ id: "pitch:field_4", name: "4v4 Field #1", level: "admin" }, { id: "pitch:warsaw", name: "Warsaw Stadium", level: "admin" },
  { id: "server", name: "Server", level: "owner" }, { id: "sounds", name: "Sounds", level: "owner" }, { id: "ranks", name: "Ranks", level: "owner" },
  { id: "crates", name: "Crates", level: "owner" }, { id: "cosmetics", name: "Cosmetics", level: "owner" }];
const KNOBS = {
  pitch: [
    { key: "boxseconds", label: "Box clock", group: "Match Rules", type: "int", value: 12, min: 0, max: 60, step: 1, unit: "seconds", level: "admin", help: "Starts when a side has the ball in its own box. 0 is off.", needsReload: false, inWorld: false },
    { key: "halfMinutes", label: "Half length", group: "Settings", type: "int", value: 10, min: 1, max: 30, unit: "minutes", level: "admin" },
    { key: "ballspeed", label: "Ball speed", group: "Settings", type: "number", value: 1.15, min: 0.5, max: 2, step: 0.05, level: "admin" },
    { key: "buzzer", label: "Buzzer beaters", group: "Match Rules", type: "bool", value: true, level: "admin" },
    { key: "fieldtype", label: "Match type", group: "Match type and names", type: "choice", value: "match", options: ["quick", "scrim", "match", "knockout"], level: "admin" },
    { key: "homename", label: "Home side's name", group: "Match type and names", type: "text", value: "Red", max: 24, level: "admin" },
    { key: "stands", label: "Stands", group: "Pitch & Watching", type: "text", value: "set", level: "admin", inWorld: true },
  ],
  server: [
    { key: "teams.red.colour", label: "Red team colour", group: "Team colours", type: "colour", value: "red", options: ["red", "dark_red", "gold", "yellow", "blue", "aqua", "green", "white"], level: "owner" },
    { key: "teams.blue.colour", label: "Blue team colour", group: "Team colours", type: "colour", value: "blue", options: ["red", "dark_red", "gold", "yellow", "blue", "aqua", "green", "white"], level: "owner" },
    { key: "commands.restrict", label: "Only allowed commands", group: "Commands", type: "bool", value: true, level: "owner" },
    { key: "commands.allowed", label: "Allowed commands", group: "Commands", type: "list", value: ["link", "unlink", "stats", "rules", "party", "warp", "vote", "cosmetics", "spectate", "leave"], level: "owner" },
  ],
  ranks: [
    { key: "ranks.display", label: "Show ranks", group: "Release", type: "bool", value: false, level: "owner", help: "Labels, colours and the tab order." },
    { key: "ranks.open", label: "Sell ranks in game", group: "Release", type: "bool", value: false, level: "owner" },
    { key: "ranks.vip.sapphires", label: "VIP price", group: "Prices", type: "int", value: 2000, min: 0, unit: "Sapphires", level: "owner" },
  ],
  crates: [
    { key: "crates.enabled", label: "Crates on", group: "Crates", type: "bool", value: true, level: "owner" },
    { key: "crates.launchAt", label: "Launch time", group: "Crates", type: "time", value: "2026-10-17T22:00:00-04:00", level: "owner" },
    { key: "crates.price", label: "Price", group: "Crates", type: "int", value: 300, min: 0, unit: "Sapphires", level: "owner" },
  ],
  cosmetics: [{ key: "trails.enabled", label: "Trails", group: "Cosmetics", type: "bool", value: true, level: "owner" }],
};
KNOBS.sounds = ["whistle", "kick", "net", "post", "crowd", "goal", "save", "pass"].flatMap((snd) => [
  { key: `${snd}.on`, label: `${snd[0].toUpperCase()}${snd.slice(1)}: on`, group: `${snd[0].toUpperCase()}${snd.slice(1)}`, type: "bool", value: true, level: "owner" },
  { key: `${snd}.sound`, label: `${snd[0].toUpperCase()}${snd.slice(1)}: sound`, group: `${snd[0].toUpperCase()}${snd.slice(1)}`, type: "text", value: `soccer:${snd}`, max: 64, level: "owner" },
  { key: `${snd}.volume`, label: `${snd[0].toUpperCase()}${snd.slice(1)}: volume`, group: `${snd[0].toUpperCase()}${snd.slice(1)}`, type: "number", value: 1, min: 0, max: 4, step: 0.1, level: "owner" },
]);
let benchRestart = null;
const serverSample = () => ({
  players: [{ uuid: SAMPLE_PLAYER.uuid, name: "DuckyWins", pitch: "4v4 Field #1" }, { uuid: "a1b2c3d4-0000-4000-8000-000000000002", name: "karlazuz" }],
  pitches: [{ id: "field_4", name: "4v4 Field #1", running: true, players: 8, countdown: -1, waiting: 0, type: "match" },
    { id: "warsaw", name: "Warsaw Stadium", running: false, players: 0, countdown: 7, waiting: 6, type: "knockout" },
    { id: "field_3", name: "3v3 Field", running: false, players: 0, countdown: -1, waiting: 0, type: "quick" }],
  busy: true,
  pack: { source: "an external link", url: "https://raw.githubusercontent.com/example/pack.zip", required: true, loaded: 2, online: 2 },
  restart: benchRestart,
});
const AUDIT = { lines: [
  { at: Date.now() - 86400e3, kind: "grant", uuid: SAMPLE_PLAYER.uuid, name: "DuckyWins", amount: 1050, delta: 1050, line: "L123", order: "O987", pretty: "MCS-1042", reason: "PayNow", by: "paynow" },
  { at: Date.now() - 3600e3, kind: "spend", uuid: SAMPLE_PLAYER.uuid, name: "DuckyWins", amount: 300, delta: -300, line: "L123", order: "", pretty: "", reason: "Stadium Crate", by: "DuckyWins" }],
  grant: { uuid: SAMPLE_PLAYER.uuid, amount: 1050, at: Date.now() - 86400e3, starter: false, reversed: false } };

async function pluginBench(req, url) {
  const p = url.pathname.replace(/^\/__plugin/, "");
  if (req.method === "GET") {
    const r = await fetch(REAL + p + url.search, { headers: p.startsWith("/discord/") ? { "X-Soccer-Token": TOKEN } : {} });
    // the bench has no admin secret, so the real server answers 401 (or 404 for a route it lacks): use samples
    if ((r.status === 404 || r.status === 401) && p.startsWith("/discord/admin/")) {
      if (p.startsWith("/discord/admin/bows/tex/")) return { status: 200, body: SAMPLE_PNG, type: "image/png" };
      if (p === "/discord/admin/knobs" && !url.searchParams.get("scope")) return { status: 200, body: JSON.stringify({ scopes: SCOPES }) };
      if (p === "/discord/admin/knobs" && KNOBS[(url.searchParams.get("scope") || "").split(":")[0]]) {
        const scope = url.searchParams.get("scope");
        return { status: 200, body: JSON.stringify({ scope, knobs: KNOBS[scope.split(":")[0]] }) };
      }
      if (p === "/discord/admin/knobs") {
        const scope = url.searchParams.get("scope") || "";
        const knobs = scope.startsWith("pitch:") ? [
          { key: "halves", label: "Halves", group: "Match", type: "int", value: 2, min: 1, max: 4, level: "admin", help: "How many halves a match has." },
          { key: "halfMinutes", label: "Half length (minutes)", group: "Match", type: "int", value: 10, min: 1, max: 30, level: "admin" },
          { key: "knockout", label: "Knockout by default", group: "Match", type: "bool", value: false, level: "admin" },
          { key: "boxRule", label: "Box rule", group: "Rules", type: "enum", value: "defenders", options: [{ value: "off", label: "Off" }, { value: "defenders", label: "Defenders only" }, { value: "all", label: "Everyone" }], level: "admin" },
          { key: "teamSize", label: "Players per side", group: "Ready zone", type: "int", value: 4, min: 1, max: 6, level: "admin" },
          { key: "stands", label: "Stands", group: "Watching", type: "text", value: "set", level: "admin", inWorld: true },
          { key: "delete", label: "Pitch enabled", group: "Danger", type: "bool", value: true, level: "owner", help: "Turning it off takes the pitch out of play.", needsReload: true },
        ] : [
          { key: "teamColourRed", label: "Red team colour", group: "Teams", type: "colour", value: "#ff5555", level: "owner" },
          { key: "launchAt", label: "Launch time", group: "Release", type: "time", value: Date.now() + 864e5, level: "owner" },
        ];
        return { status: 200, body: JSON.stringify({ scope, knobs }) };
      }
      if (p === "/discord/admin/server") return { status: 200, body: JSON.stringify(serverSample()) };
      if (p === "/discord/admin/wallet/audit") return url.searchParams.get("q") === "none" ? { status: 200, body: JSON.stringify({ lines: [] }) } : { status: 200, body: JSON.stringify(AUDIT) };
      if (SAMPLE[p]) return { status: 200, body: JSON.stringify(SAMPLE[p]) };
    }
    return { status: r.status, body: await r.text() };
  }
  if (p === "/discord/admin/sapphires") return { status: 200, body: JSON.stringify({ ok: true, repeat: false, balance: 1250 + (url.searchParams.get("op") === "take" ? -1 : 1) * Number(url.searchParams.get("amount") || 0) }) };
  if (p === "/discord/admin/rank") return { status: 200, body: JSON.stringify({ ok: true, message: `DuckyWins: ${url.searchParams.get("op")} ${url.searchParams.get("rank")} (bench).` }) };
  if (p === "/discord/admin/server/restart") { benchRestart = { at: Date.now() + 1000 * Number(url.searchParams.get("delay") || 60), by: url.searchParams.get("by") }; return { status: 200, body: JSON.stringify({ ok: true, at: benchRestart.at, message: `Restarting in ${url.searchParams.get("delay")} seconds; players were told.` }) }; }
  if (p === "/discord/admin/server/restart/cancel") { benchRestart = null; return { status: 200, body: JSON.stringify({ ok: true, message: "Restart called off." }) }; }
  if (p === "/discord/admin/server/reload") return { status: 409, body: JSON.stringify({ ok: false, error: "something is on (field_4); a reload would end it. Try again when they're idle." }) };
  if (p === "/discord/admin/server/pack/resend") return { status: 200, body: JSON.stringify({ ok: true, message: "Sent the pack to 2 players." }) };
  if (p === "/discord/admin/wallet/grant") return { status: 200, body: JSON.stringify({ ok: true, repeat: false, balance: 1850, message: `+${url.searchParams.get("amount")} to ${url.searchParams.get("id")} (line ${url.searchParams.get("line")})` }) };
  if (p === "/discord/admin/wallet/reverse") return { status: 200, body: JSON.stringify({ ok: true, repeat: false, message: `Took back 1,050 (line ${url.searchParams.get("line")}, ${url.searchParams.get("kind")}).` }) };
  if (p === "/discord/admin/wallet/reset" || p === "/discord/admin/wallet/unpause") return { status: 200, body: JSON.stringify({ ok: true, balance: 0, canSpend: true, message: `${url.searchParams.get("id")}: debt cleared.` }) };
  if (p === "/discord/admin/knobs") return { status: 200, body: JSON.stringify({ ok: true, message: `Set ${url.searchParams.get("key")} = ${url.searchParams.get("value")}.`, value: url.searchParams.get("value") }) };
  if (p === "/discord/admin/cosmetics") return { status: 200, body: JSON.stringify({ ok: true, changed: true, message: "DuckyWins now owns it (bench)." }) };
  console.log(`  (bench) pretend ${req.method} ${p}${url.search}`);
  if (p === "/discord/matches/wipe" && url.searchParams.get("dry")) return { status: 200, body: JSON.stringify({ ok: true, players: 6, fixture: false }) };
  return { status: 200, body: JSON.stringify({ ok: true }) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/__plugin/")) {
      if (req.method !== "GET") await new Promise((ok) => { req.resume(); req.on("end", ok); });
      const r = await pluginBench(req, url);
      res.writeHead(r.status, { "Content-Type": r.type || "application/json" });
      return res.end(r.body);
    }
    if (url.pathname === "/__login") {
      const sid = "bench" + "x".repeat(40);
      const now = Date.now();
      await KV.put("s:" + sid, JSON.stringify({ id: "000", name: "Test Admin", username: "test", avatar: null, role: url.searchParams.get("role") || "owner", token: "none", created: now, checked: now + 3600e3, expires: now + 3600e3 }), { expirationTtl: 3600 });
      res.writeHead(302, { Location: "/", "Set-Cookie": `mcsa=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` });
      return res.end();
    }
    const body = await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
    const request = new Request(url.href, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const r = await worker.fetch(request, env);
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = k === "set-cookie" ? r.headers.getSetCookie() : v; });
    // the bench is plain http: let the browser keep "Secure" cookies off localhost
    delete headers["strict-transport-security"];
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e && e.stack || e));
  }
}).listen(PORT, () => console.log(`admin bench on http://localhost:${PORT}/__login`));
