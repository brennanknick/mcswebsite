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

async function pluginBench(req, url) {
  const p = url.pathname.replace(/^\/__plugin/, "");
  if (req.method === "GET") {
    const r = await fetch(REAL + p + url.search, { headers: p.startsWith("/discord/") ? { "X-Soccer-Token": TOKEN } : {} });
    return { status: r.status, body: await r.text() };
  }
  console.log(`  (bench) pretend ${req.method} ${p}${url.search}`);
  if (p === "/discord/matches/wipe" && url.searchParams.get("dry")) return { status: 200, body: JSON.stringify({ ok: true, players: 6, fixture: false }) };
  return { status: 200, body: JSON.stringify({ ok: true }) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/__plugin/")) {
      const r = await pluginBench(req, url);
      res.writeHead(r.status, { "Content-Type": "application/json" });
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
