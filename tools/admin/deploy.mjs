// Deploys the MCS admin dashboard (tools/admin) to Cloudflare as the Worker "admin" on
// admin.mcsoccer.net. Run from anywhere:
//   node tools/admin/deploy.mjs            dry run: what it would do
//   node tools/admin/deploy.mjs --apply    upload and wire it up
// Reads, and never prints:
//   C:\Users\brenn\soccer\.cloudflare-token       a token from the "Edit Cloudflare Workers" template
//   C:\Users\brenn\soccer\.discord-oauth-secret   the MCS Discord app's OAuth2 client secret
//   C:\Users\brenn\soccer\.plugin-admin-token     the game server's admin secret: it signs every request
//   the Discord bot's .env                        CLIENT_ID, GUILD_ID, and DISCORD_TOKEN (to look up the role ids)
// Everything it makes is idempotent: the KV namespace and the custom domain are reused.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = "C:/Users/brenn/soccer";
const BOT_ENV = "C:/Users/brenn/soccer/soccer/discord-bot/.env";
const SCRIPT = "admin";
const HOSTNAME = "admin.mcsoccer.net";
const ZONE = "mcsoccer.net";
const ORIGIN = "http://play.mcsoccer.net:25543";
const COMPAT = "2026-09-24";
const KV_TITLE = "mcs-admin";

const read = (f) => fs.readFileSync(f, "utf8").trim();
const CF = read(path.join(SECRETS, ".cloudflare-token"));
const env = Object.fromEntries(read(BOT_ENV).split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
}));
for (const k of ["CLIENT_ID", "GUILD_ID", "DISCORD_TOKEN"]) if (!env[k]) throw new Error(`the bot's .env has no ${k}`);
const oauthSecret = read(path.join(SECRETS, ".discord-oauth-secret"));
const adminTokenFile = path.join(SECRETS, ".plugin-admin-token");
const adminToken = read(adminTokenFile);
if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) throw new Error("the admin secret file should hold 32-256 letters, digits, - or _");

async function cf(method, p, body, headers = {}) {
  const res = await fetch("https://api.cloudflare.com/client/v4" + p, {
    method,
    headers: { Authorization: "Bearer " + CF, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(data.errors || data).slice(0, 400)}`);
  return data.result;
}

async function discord(p) {
  const res = await fetch("https://discord.com/api/v10" + p, { headers: { Authorization: "Bot " + env.DISCORD_TOKEN } });
  if (!res.ok) throw new Error(`discord ${p} -> ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ look
const zone = (await cf("GET", `/zones?name=${ZONE}`))[0];
if (!zone) throw new Error("no zone " + ZONE);
const account = zone.account.id;
console.log(`zone ${ZONE} in "${zone.account.name}"`);

const spaces = await cf("GET", `/accounts/${account}/storage/kv/namespaces?per_page=100`);
let kv = spaces.find((n) => n.title === KV_TITLE);
console.log(`KV "${KV_TITLE}": ${kv ? "exists" : "will be created"}`);

const roles = await discord(`/guilds/${env.GUILD_ID}/roles`);
// owners only (Brenn, 2026-10-18): the Admin role doesn't get in
const owner = roles.find((r) => r.name === "Owner");
if (!owner) throw new Error("the Discord has no Owner role");
console.log(`role: Owner (${owner.id})`);

const domains = await cf("GET", `/accounts/${account}/workers/domains`);
const domain = domains.find((d) => d.hostname === HOSTNAME);
console.log(`custom domain ${HOSTNAME}: ${domain ? `on "${domain.service}"` : "will be added"}`);
console.log("plugin admin secret: present (it signs every request and never travels; the bot token isn't used)");

const files = ["worker.js", "app.html", "app.css", "app.js"].map((f) => [f, fs.readFileSync(path.join(HERE, f), "utf8")]);
for (const [f, text] of files) console.log(`  ${f.padEnd(10)} ${(text.length / 1024).toFixed(1)} KB`);
if (!APPLY) { console.log("\nDry run only. --apply to deploy."); process.exit(0); }

// ------------------------------------------------------------------ deploy
if (!kv) kv = await cf("POST", `/accounts/${account}/storage/kv/namespaces`, { title: KV_TITLE });

const bindings = [
  { type: "kv_namespace", name: "KV", namespace_id: kv.id },
  { type: "plain_text", name: "DISCORD_CLIENT_ID", text: env.CLIENT_ID },
  { type: "plain_text", name: "GUILD_ID", text: env.GUILD_ID },
  { type: "plain_text", name: "OWNER_ROLE_ID", text: owner.id },
  { type: "plain_text", name: "ORIGIN", text: ORIGIN },
  { type: "secret_text", name: "DISCORD_CLIENT_SECRET", text: oauthSecret },
  // signed requests open every route the dashboard uses, so the bot's token stays with the bot
  { type: "secret_text", name: "PLUGIN_ADMIN_TOKEN", text: adminToken },
];

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: COMPAT, bindings })], { type: "application/json" }));
for (const [f, text] of files) {
  form.append(f, new Blob([text], { type: f === "worker.js" ? "application/javascript+module" : "text/plain" }), f);
}
await cf("PUT", `/accounts/${account}/workers/scripts/${SCRIPT}`, form);
console.log(`uploaded the "${SCRIPT}" Worker`);

if (!domain || domain.service !== SCRIPT) {
  await cf("PUT", `/accounts/${account}/workers/domains`, { environment: "production", hostname: HOSTNAME, service: SCRIPT, zone_id: zone.id });
  console.log(`attached ${HOSTNAME}`);
}
console.log(`\nDone: https://${HOSTNAME}/`);
