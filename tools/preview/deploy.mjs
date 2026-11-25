// Deploys tools/preview/worker.js to Cloudflare as the Worker "preview" on preview.mcsoccer.net.
// It serves the website repo's preview branch (BRANCH below) from GitHub. Run from anywhere:
//   node tools/preview/deploy.mjs                   dry run: what it would do
//   node tools/preview/deploy.mjs --apply           upload and attach the domain
//   node tools/preview/deploy.mjs --apply --branch=christmas-snow   serve another branch instead
// To show a remodel, push it to that branch (git push origin <branch>:preview); no redeploy needed.
// Reads, and never prints: C:\Users\brenn\soccer\.cloudflare-token (the "Edit Cloudflare Workers" token
// the admin dashboard uses). The custom domain is reused when it's there already.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = "preview";
const HOSTNAME = "preview.mcsoccer.net";
const ZONE = "mcsoccer.net";
const COMPAT = "2026-09-24";
const BRANCH = (process.argv.find((a) => a.startsWith("--branch=")) || "--branch=preview").split("=")[1];
if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(BRANCH)) throw new Error("that branch name isn't one");

const CF = fs.readFileSync("C:/Users/brenn/soccer/.cloudflare-token", "utf8").trim();

async function cf(method, p, body) {
  const res = await fetch("https://api.cloudflare.com/client/v4" + p, {
    method,
    headers: { Authorization: "Bearer " + CF, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(data.errors || data).slice(0, 400)}`);
  return data.result;
}

const zone = (await cf("GET", `/zones?name=${ZONE}`))[0];
if (!zone) throw new Error("no zone " + ZONE);
const account = zone.account.id;
console.log(`zone ${ZONE} in "${zone.account.name}"`);
const domains = await cf("GET", `/accounts/${account}/workers/domains`);
const domain = domains.find((d) => d.hostname === HOSTNAME);
console.log(`custom domain ${HOSTNAME}: ${domain ? `on "${domain.service}"` : "will be added"}`);
const code = fs.readFileSync(path.join(HERE, "worker.js"), "utf8");
console.log(`worker.js ${(code.length / 1024).toFixed(1)} KB, serving branch "${BRANCH}"`);
if (!APPLY) { console.log("\nDry run only. --apply to deploy."); process.exit(0); }

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: COMPAT,
  bindings: [{ type: "plain_text", name: "BRANCH", text: BRANCH }] })], { type: "application/json" }));
form.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
await cf("PUT", `/accounts/${account}/workers/scripts/${SCRIPT}`, form);
console.log(`uploaded the "${SCRIPT}" Worker`);

if (!domain || domain.service !== SCRIPT) {
  await cf("PUT", `/accounts/${account}/workers/domains`, { environment: "production", hostname: HOSTNAME, service: SCRIPT, zone_id: zone.id });
  console.log(`attached ${HOSTNAME}`);
}
console.log(`\nDone: https://${HOSTNAME}/  (branch "${BRANCH}")`);
