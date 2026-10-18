// Local test bench for the admin dashboard (never deployed).
//   node tools/admin/dev.mjs [--port=8799]
// Runs worker.js in Node on http://localhost:<port> with an in-memory KV, and signs you in
// as a TEST admin at /__login (local only: Discord's real sign-in can't come back to
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
const env = { KV, ORIGIN, PLUGIN_TOKEN: "bench", DISCORD_CLIENT_ID: "0", GUILD_ID: "0", OWNER_ROLE_ID: "1", ADMIN_ROLE_ID: "2", DISCORD_CLIENT_SECRET: "x" };

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

async function pluginBench(req, url) {
  const p = url.pathname.replace(/^\/__plugin/, "");
  if (req.method === "GET") {
    const r = await fetch(REAL + p + url.search, { headers: p.startsWith("/discord/") ? { "X-Soccer-Token": TOKEN } : {} });
    // the bench has no admin secret, so the real server answers 401 (or 404 for a route it lacks): use samples
    if ((r.status === 404 || r.status === 401) && p.startsWith("/discord/admin/")) {
      if (p.startsWith("/discord/admin/bows/tex/")) return { status: 200, body: SAMPLE_PNG, type: "image/png" };
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
      if (SAMPLE[p]) return { status: 200, body: JSON.stringify(SAMPLE[p]) };
    }
    return { status: r.status, body: await r.text() };
  }
  if (p === "/discord/admin/sapphires") return { status: 200, body: JSON.stringify({ ok: true, repeat: false, balance: 1250 + (url.searchParams.get("op") === "take" ? -1 : 1) * Number(url.searchParams.get("amount") || 0) }) };
  if (p === "/discord/admin/rank") return { status: 200, body: JSON.stringify({ ok: true, message: `DuckyWins: ${url.searchParams.get("op")} ${url.searchParams.get("rank")} (bench).` }) };
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
