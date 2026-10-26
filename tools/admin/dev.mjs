// Local test bench for the admin dashboard (never deployed).
//   node tools/admin/dev.mjs [--port=8799] [--cup=running|signup|live] [--ranked=live|busy] [--crests=bench|real]
// Runs worker.js in Node on http://localhost:<port> (this PC only) with an in-memory KV, and
// signs you in as a TEST owner at /__login (Discord's real sign-in can't come back to
// localhost). Reads (GET) go to the real game server, signed with its admin secret when that
// file is on this PC; writes (POST) are answered here and never reach the game server, so every
// button can be tried safely. --cup and --ranked serve made-up states live may not have right
// now: an open cup mid-bracket (or taking sign-ups), and a busy ranked queue.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "--port=8799").split("=")[1]);
const REAL = "http://104.194.11.160:25543";
const TOKEN = (() => {
  const env = fs.readFileSync("C:/Users/brenn/soccer/soccer/discord-bot/.env", "utf8");
  const m = env.match(/^SOCCER_API_TOKEN=(.*)$/m);
  return m ? m[1].trim() : "";
})();
const flag = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const CUP_MODE = flag("cup", "running");
const RANKED_MODE = flag("ranked", "live");
const PACK_MODE = flag("pack", "live");   // stale: the real answers, dressed as a pack nobody published

// The admin secret signs the bench's reads of /discord/admin/* (docs/admin-api.md, "Signed
// requests"), so pages show real data. It's read here and never printed or sent anywhere else.
const ADMIN_SECRET = (() => { try { return fs.readFileSync("C:/Users/brenn/soccer/.plugin-admin-token", "utf8").trim(); } catch { return ""; } })();
function signedGet(u) {
  if (!ADMIN_SECRET) return {};
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", ADMIN_SECRET).update(["GET", u.pathname, u.search.slice(1), ts, ""].join("\n")).digest("hex");
  return { "X-Soccer-Ts": ts, "X-Soccer-Sig": sig };
}

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
    { key: "teams.red.colour", label: "Red team colour", group: "Team colours", type: "colour", value: "RED", options: ["RED", "DARK_RED", "GOLD", "YELLOW", "BLUE", "AQUA", "GREEN", "WHITE"], level: "owner" },
    { key: "teams.blue.colour", label: "Blue team colour", group: "Team colours", type: "colour", value: "BLUE", options: ["RED", "DARK_RED", "GOLD", "YELLOW", "BLUE", "AQUA", "GREEN", "WHITE"], level: "owner" },
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
  // live shape (03bc200): grants and tombstones by line id, and "grant" only when there's exactly one
  grants: { L123: { uuid: SAMPLE_PLAYER.uuid, amount: 1050, at: Date.now() - 86400e3, starter: false, reversed: false },
    L124: { uuid: SAMPLE_PLAYER.uuid, amount: 600, at: Date.now() - 86400e3, starter: true, reversed: true, reverseKind: "refund", reversedAt: Date.now() - 7200e3, reversedPaid: 600 } },
  tombstones: { L125: "chargeback" } };

// stage 3 samples (docs/admin-api.md "Cups" and "Ranked"), in the shapes live sends
const T0 = Date.now();
const who = (n, name, online = true, leader = false) => ({ uuid: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, name, online, leader });
const CUP_LIMITS = { teamSize: { min: 2, max: 5 }, maxTeams: [4, 8, 16, 32], halves: { min: 1, max: 4 }, halfMinutes: { min: 1, max: 30 }, teamName: 16, cupName: 32 };
const CUP_DEFAULTS = { name: "MCS Cup", teamSize: 3, maxTeams: 8, halves: 2, halfMinutes: 5, extraTime: false };
const noMoves = () => ({ can: { start: false, win: { a: false, b: false }, void: false }, why: {}, needsForce: { win: false, void: false } });

/** An open cup: taking sign-ups, or drawn with a bye, a result, a live match and one ready to call. */
function sampleCup(mode, name = "MCS Halloween Cup") {
  const signup = mode === "signup";
  const team = (id, tname, color, seed, roster, extra = {}) => ({ id, name: tname, color, seed: signup ? undefined : seed, status: "IN", leader: roster[0].uuid, joinedAt: T0 - 3600e3,
    online: roster.filter((m) => m.online).length, members: roster, can: { rename: true, remove: true, swap: true }, needsForce: { remove: !!extra.currentMatch }, ...extra });
  const teams = [
    team("t1", "Outduel", "#e4572e", 1, [who(1, "Outduel", true, true), who(2, "Lngr"), who(3, "Pyro", false)]),
    team("t2", "Karl's Lot", "#29a3ff", 2, [who(4, "karlazuz", true, true), who(5, "duckudertruck"), who(6, "Akameq_")]),
    team("t3", "Blue Lock", "#59cd90", 3, [who(7, "Isagi", true, true), who(8, "Bachira"), who(9, "Nagi", false)], signup ? {} : { currentMatch: "r1m3" }),
  ];
  if (!signup) teams.push(
    team("t4", "Night Owls", "#f6ae2d", 4, [who(10, "Owlet", true, true), who(11, "Hoot", false), who(12, "Barn")]),
    { ...team("t5", "Red Lions", "#d7263d", 5, [who(13, "Leo", false, true), who(14, "Simba", false), who(15, "Nala", false)]), status: "OUT", can: { rename: true, remove: false, swap: false } },
    team("t6", "Late Kicks", "#a06cd5", 6, [who(16, "Tardy", true, true), who(17, "Snooze"), who(18, "Yawn")], { currentMatch: "r1m3" }));
  const m = (id, round, index, label, rest) => ({ id, round, index, label, ...noMoves(), ...rest });
  const rounds = signup ? [] : [
    { round: 1, name: "Quarterfinals", matches: [
      m("r1m1", 1, 0, "Quarterfinal 1", { a: "t1", state: "DONE", bye: true, winner: "t1", decidedBy: "bye", next: "r2m1" }),
      m("r1m2", 1, 1, "Quarterfinal 2", { a: "t4", b: "t5", state: "DONE", score: { a: 3, b: 1 }, winner: "t4", decidedBy: "goals", matchId: "sample", fieldId: "field_3", pitch: "3v3 Field", next: "r2m1",
        can: { start: false, win: { a: false, b: true }, void: false } }),
      m("r1m3", 1, 2, "Quarterfinal 3", { a: "t3", b: "t6", state: "LIVE", score: { a: 1, b: 1 }, fieldId: "field_4", pitch: "4v4 Field #1", startedAt: T0 - 300e3, next: "r2m2",
        can: { start: false, win: { a: true, b: true }, void: true }, needsForce: { win: true, void: true } }),
      m("r1m4", 1, 3, "Quarterfinal 4", { a: "t2", state: "DONE", bye: true, winner: "t2", decidedBy: "bye", next: "r2m2" })] },
    { round: 2, name: "Semifinals", matches: [
      m("r2m1", 2, 0, "Semifinal 1", { a: "t1", b: "t4", state: "READY", next: "r3m1", lastCall: { text: "It didn't start: nobody from Night Owls was online.", at: T0 - 600e3 },
        can: { start: true, win: { a: true, b: true }, void: false } }),
      m("r2m2", 2, 1, "Semifinal 2", { a: "t2", state: "WAITING", next: "r3m1" })] },
    { round: 3, name: "Final", matches: [m("r3m1", 3, 0, "Final", { state: "WAITING" })] }];
  const events = [{ seq: 1, at: T0 - 7200e3, type: "OPENED", text: `Sign-ups are open for ${name}` },
    ...teams.map((x, i) => ({ seq: 2 + i, at: T0 - 7000e3 + i * 60e3, type: "TEAM_JOINED", team: x.id, teamColor: x.color, text: `${x.name} signed up` }))];
  if (!signup) events.push({ seq: 20, at: T0 - 3600e3, type: "DRAWN", text: "The bracket is drawn" },
    { seq: 21, at: T0 - 1800e3, type: "MATCH_ENDED", team: "t4", teamColor: "#f6ae2d", match: "r1m2", text: "Night Owls beat Red Lions 3-1" },
    { seq: 22, at: T0 - 300e3, type: "MATCH_STARTED", match: "r1m3", text: "Blue Lock v Late Kicks has kicked off" });
  return { id: `cup-bench-${signup ? "s" : "r"}`, name, state: signup ? "SIGNUP" : "RUNNING", teamSize: 3, teamCount: teams.length, maxTeams: 8,
    createdAt: T0 - 7200e3, startedAt: signup ? undefined : T0 - 3600e3, updatedAt: T0, version: 7, rules: { halves: 2, halfMinutes: 5, extraTime: false },
    teams, rounds, events, createdBy: "dashboard:karl (594335716310515722)", open: true, editable: true, currentRound: signup ? 0 : 1, callSeconds: 5, forfeitSeconds: 60,
    limits: CUP_LIMITS, defaults: CUP_DEFAULTS, minMaxTeams: teams.length,
    can: signup ? { configure: true, teamSize: false, draw: true, redraw: false, cancel: true } : { configure: false, teamSize: false, draw: false, redraw: false, cancel: true },
    why: {}, liveGames: signup ? 0 : 1,
    freePitches: signup ? [] : [{ id: "field_3", name: "3v3 Field", reserved: false }, { id: "field_5", name: "4v4 Field #2", reserved: true }],
    swapCandidates: [{ uuid: who(20, "Benchwarmer").uuid, name: "Benchwarmer" }] };
}
const PAST_CUP = (() => {
  const t = sampleCup("running", "MCS Cup");
  for (const rd of t.rounds) for (const x of rd.matches) Object.assign(x, noMoves(), x.state === "DONE" ? {} : { state: "DONE", score: { a: 2, b: 1 }, winner: x.a || "t1", decidedBy: "goals", b: x.b || "t3" });
  return { ...t, id: "cup-bench-past", state: "FINISHED", open: false, editable: false, liveGames: 0, finishedAt: T0 - 86400e3, createdAt: T0 - 90000e3, champion: "t1",
    can: { configure: false, teamSize: false, draw: false, redraw: false, cancel: false }, freePitches: [], swapCandidates: [], teams: t.teams.map((x) => ({ ...x, currentMatch: undefined, can: { rename: false, remove: false, swap: false } })) };
})();
let benchCup = CUP_MODE === "live" ? null : sampleCup(CUP_MODE);
const isOpenCup = () => !!benchCup && (benchCup.state === "SIGNUP" || benchCup.state === "RUNNING");
const cupSummary = (t) => ({ id: t.id, name: t.name, state: t.state, teamSize: t.teamSize, teamCount: t.teams.length, maxTeams: t.maxTeams, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
  champion: t.champion ? { id: t.champion, name: t.teams.find((x) => x.id === t.champion).name, color: t.teams.find((x) => x.id === t.champion).color } : undefined,
  updatedAt: t.updatedAt, version: t.version, createdBy: t.createdBy, live: t.liveGames, ready: 1, teamsLeft: t.teams.filter((x) => x.status === "IN").length, editable: t.editable });

/** A pretend cup write: the checks the game server makes first, then a small change to the bench's cup. */
function benchCupWrite(op, q) {
  const bad = (status, error) => ({ status, body: JSON.stringify({ ok: false, error }) });
  const okCup = (message, extra = {}) => { benchCup.version++; benchCup.updatedAt = Date.now(); return { status: 200, body: JSON.stringify({ ok: true, message, ...extra, tournament: benchCup }) }; };
  if (op === "create") {
    if (isOpenCup()) return bad(409, `${benchCup.name} is still open`);
    benchCup = sampleCup("signup", q.get("name") || "MCS Cup");
    benchCup.teams = [];
    benchCup.teamCount = 0;
    benchCup.can.draw = false;
    benchCup.why = { draw: "Need at least 2 teams" };
    return okCup(`Sign-ups are open for ${benchCup.name}.`);
  }
  if (!q.get("cup")) return bad(400, "cup required (the cup's id)");
  if (!isOpenCup()) return bad(409, "No cup is open");
  if (q.get("cup") !== benchCup.id || Number(q.get("expectVersion")) !== benchCup.version) return bad(409, "The cup changed since you loaded it");
  const t = benchCup;
  const m = t.rounds.flatMap((rd) => rd.matches).find((x) => x.id === q.get("match"));
  const team = t.teams.find((x) => x.id === q.get("team"));
  const forced = q.get("force") === "true";
  if (["start", "win", "void"].includes(op) && !m) return bad(404, `No match ${q.get("match")}`);
  if (["rename", "swap", "remove"].includes(op) && !team) return bad(404, `No team ${q.get("team")}`);
  switch (op) {
    case "draw":
    case "redraw": { const v = t.version; benchCup = sampleCup("running", t.name); benchCup.version = v; return okCup("The bracket is drawn."); }
    case "configure":
      for (const k of ["maxTeams", "teamSize"]) if (q.get(k)) t[k] = Number(q.get(k));
      for (const k of ["halves", "halfMinutes"]) if (q.get(k)) t.rules[k] = Number(q.get(k));
      if (q.get("extraTime")) t.rules.extraTime = q.get("extraTime") === "true";
      return okCup("Saved.");
    case "start": {
      const pitch = t.freePitches.find((p) => p.id === q.get("pitch"));
      if (!pitch) return bad(404, `No pitch called ${q.get("pitch")}`);
      Object.assign(m, { calling: true, calledTo: { id: pitch.id, name: pitch.name }, can: { ...m.can, start: false } });
      return okCup(`Calling ${m.label} to ${pitch.name}.`, { called: true, seconds: 5, match: m.id, pitch: { id: pitch.id, name: pitch.name } });
    }
    case "win": {
      if (m.needsForce.win && !forced) return bad(409, `That would stop the live game on ${m.pitch}; send force=true`);
      const side = q.get("side");
      Object.assign(m, { state: "DONE", winner: side === "a" || side === "b" ? m[side] : side, decidedBy: "staff", calling: false }, noMoves());
      if (m.id === "r1m3") t.liveGames = 0;
      return okCup(`${t.teams.find((x) => x.id === m.winner).name} go through.`);
    }
    case "void":
      if (m.needsForce.void && !forced) return bad(409, `That would stop the live game on ${m.pitch}; send force=true`);
      Object.assign(m, { state: "READY", score: undefined, calling: false, calledTo: undefined }, noMoves(), { can: { start: true, win: { a: true, b: true }, void: false } });
      if (m.id === "r1m3") t.liveGames = 0;
      return okCup(`${m.label} was called off.`);
    case "rename": team.name = q.get("name"); return okCup(`Renamed to ${team.name}.`);
    case "swap": {
      const out = team.members.find((x) => x.uuid === q.get("out"));
      const inn = t.swapCandidates.find((x) => x.uuid === q.get("in"));
      if (!out || !inn) return bad(404, "no such player");
      Object.assign(out, { uuid: inn.uuid, name: inn.name, online: true });
      t.swapCandidates = t.swapCandidates.filter((x) => x !== inn);
      return okCup(`${inn.name} is in for ${q.get("out")}.`);
    }
    case "remove":
      if (team.needsForce.remove && !forced) return bad(409, "That would stop the live game on 4v4 Field #1; send force=true");
      if (t.state === "SIGNUP") t.teams = t.teams.filter((x) => x !== team); else Object.assign(team, { status: "WITHDRAWN", can: { rename: false, remove: false, swap: false } });
      return okCup(`${team.name} ${t.state === "SIGNUP" ? "came off the sign-ups" : "were withdrawn"}.`);
    case "cancel":
      if (q.get("confirm") !== t.id) return bad(409, "Cancelling needs confirm=<the cup's id>");
      if (t.liveGames && !forced) return bad(409, "That would stop the live game on 4v4 Field #1; send force=true");
      Object.assign(t, { state: "CANCELLED", open: false, editable: false, finishedAt: Date.now(), liveGames: 0 });
      return okCup(`${t.name} was cancelled.`);
  }
  return bad(404, "no such endpoint");
}

const rankedBusy = () => {
  const p = (n, name, elo, extra = {}) => ({ uuid: who(n, name).uuid, name, elo, eloBefore: elo, party: null, left: false, ...extra });
  return { ok: true, enabled: true, fileOk: true,
    config: { startElo: 1000, placementGames: 10, kPlacement: 40, kSettled: 24, window: { start: 100, step: 50, everySeconds: 20, anyoneAfterSeconds: 120 }, draft: { enabled: true, pickSeconds: 15 },
      matchFoundSeconds: 4, forfeitSeconds: 60, leaverCooldownMinutes: [2, 5, 15, 30], leaverResetHours: 24, ladderMinGames: 1, requireLink: true },
    queues: [{ id: "3v3", size: 3, players: 2, entries: [{ leader: who(2, "Lngr").uuid, members: [p(2, "Lngr", 1080), p(3, "Pyro", 1010)], avgElo: 1045, since: Date.now() - 42000, waitedMs: 42000, rangeElo: 150, waitingForPitch: false }] },
      { id: "4v4", size: 4, players: 1, entries: [{ leader: who(10, "Owlet").uuid, members: [p(10, "Owlet", 990)], avgElo: 990, since: Date.now() - 135000, waitedMs: 135000, rangeElo: null, waitingForPitch: true }] }],
    found: [{ id: "1a2b3c4d", queue: "3v3", pitch: { id: "field_3", name: "3v3 Field" }, foundAt: Date.now() - 8000, drafting: true, teams: null,
      draft: { turn: "red", secondsLeft: 12, picks: 2, sides: [{ team: "red", name: "Red", captain: { uuid: who(7, "Isagi").uuid, name: "Isagi" } }, { team: "blue", name: "Blue", captain: { uuid: who(8, "Bachira").uuid, name: "Bachira" } }],
        units: [{ players: [p(7, "Isagi", 1240)], team: "red", order: 0 }, { players: [p(8, "Bachira", 1190)], team: "blue", order: 0 }, { players: [p(9, "Nagi", 1100)], team: null, order: null }] } }],
    matches: [{ id: "9z8y7x6w", queue: "4v4", pitch: { id: "field_4", name: "4v4 Field #1" }, foundAt: Date.now() - 400000, running: true, score: { red: 2, blue: 1 }, halfSecondsLeft: 95,
      teams: { red: { name: "Red", avgElo: 1120, players: [p(4, "karlazuz", 1150), p(5, "duckudertruck", 1100), p(6, "Akameq_", 1110), p(1, "Outduel", 1120)] },
        blue: { name: "Blue", avgElo: 1105, players: [p(13, "Leo", 1090), p(14, "Simba", 1130), p(15, "Nala", 1100), p(16, "Tardy", 1100)] } }, left: [who(16, "Tardy").uuid] }],
    pitches: [{ id: "field_4", name: "4v4 Field #1", queue: "4v4", state: "playing", why: "a match is on", problems: [], match: "9z8y7x6w" },
      { id: "field_3", name: "3v3 Field", queue: "3v3", state: "busy", why: "a found ranked match holds it", problems: [], match: "1a2b3c4d" },
      { id: "warsaw", name: "Warsaw Stadium", queue: null, state: "notReady", why: null, problems: ["no penalty spot for draws (Setup step 7)"], match: null },
      { id: "field_5", name: "4v4 Field #2", queue: "4v4", state: "free", why: null, problems: [], match: null }],
    ladders: [{ queue: "3v3", updatedAt: Date.now() - 600000, total: 3, items: [{ rank: 1, uuid: who(7, "Isagi").uuid, name: "Isagi", elo: 1240, games: 35, wins: 20, losses: 15, linked: true },
      { rank: 2, uuid: who(8, "Bachira").uuid, name: "Bachira", elo: 1190, games: 28, wins: 16, losses: 12, linked: true }, { rank: 3, uuid: who(30, "x").uuid, name: null, elo: 1004, games: 1, wins: 1, losses: 0, linked: false }] },
      { queue: "4v4", updatedAt: Date.now() - 600000, total: 0, items: [] }] };
};

/** Bench reads that stand in for live: an open cup, a busy ranked queue (see --cup and --ranked). */
function stage3Read(p, url) {
  const ok = (o) => ({ status: 200, body: JSON.stringify(o) });
  if (CUP_MODE !== "live" && p === "/discord/admin/cups/list") return ok({ ok: true, current: isOpenCup() ? benchCup.id : null, items: [...(benchCup ? [cupSummary(benchCup)] : []), cupSummary(PAST_CUP)] });
  if (CUP_MODE !== "live" && p === "/discord/admin/cups/show") {
    const id = url.searchParams.get("id") || "current";
    const t = id === "current" ? (isOpenCup() ? benchCup : PAST_CUP) : [benchCup, PAST_CUP].find((c) => c && c.id === id);
    return t ? ok({ ok: true, tournament: t }) : { status: 404, body: JSON.stringify({ ok: false, error: "no such cup" }) };
  }
  if (RANKED_MODE === "busy" && p === "/discord/admin/ranked/status") return ok(rankedBusy());
  return null;
}

/** Pretend answers for the clubs, ranked and maintenance writes, shaped like the game server's. */
function stage3Write(p, q) {
  const ok = (o) => ({ status: 200, body: JSON.stringify({ ok: true, ...o }) });
  const bad = (status, error) => ({ status, body: JSON.stringify({ ok: false, error }) });
  if (p.startsWith("/discord/admin/cups/")) return CUP_MODE === "live" ? ok({ message: "(bench) done." }) : benchCupWrite(p.split("/").pop(), q);
  if (p.startsWith("/discord/admin/clubs/")) {
    const op = p.split("/").pop();
    const id = q.get("club") || (q.get("name") || "bench club").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (op === "delete" && q.get("confirm") !== q.get("club")) return bad(409, `Send confirm=${q.get("club")} to delete it. There's no undo.`);
    if (op === "delete") return ok({ changed: true, message: `Deleted ${id}.`, before: { id }, club: null, deleted: id });
    return ok({ changed: true, repeat: false, message: `(bench) ${op} done.`, before: {}, club: { id, name: q.get("name") || id } });
  }
  if (p === "/discord/admin/ranked/reset") return ok({ uuid: q.get("id"), name: "that player", queue: q.get("queue"), changed: true, before: {}, after: {}, message: `Reset that player's ${q.get("queue")} rating: 1000 Elo, 0 games.` });
  const career = { name: "DuckyWins", games: 12, wins: 7, goals: 4, assists: 2, ownGoals: 0, shots: 9, shotsOnTarget: 6, passes: 40, saves: 1, steals: 3, tackleHits: 5, interceptions: 2, pkScored: 0, pkMissed: 0, pkSaved: 0, mvps: 1, cleanSheets: 0, possessionSeconds: 300 };
  if (p === "/discord/admin/maint/statsreset") return q.get("dry")
    ? ok({ dry: true, uuid: q.get("id"), name: "DuckyWins", career, message: "This wipes DuckyWins's career: 12 games, 4 goals, 2 assists. Match history stays." })
    : ok({ dry: false, uuid: q.get("id"), name: "DuckyWins", career, cleared: true, backup: `stats.yml.before-statsreset-${Date.now()}`, message: "Cleared all stats for DuckyWins." });
  if (p === "/discord/admin/maint/mergeplayer") {
    if (!/^[0-9a-f-]{32,36}$/i.test(q.get("from") || "") || !/^[0-9a-f-]{32,36}$/i.test(q.get("into") || "")) return bad(400, "use a UUID for from and into");
    const pair = { from: { uuid: q.get("from"), name: "OldAccount" }, into: { uuid: q.get("into"), name: "MainAccount" } };
    return q.get("dry") || q.get("confirm") !== "true"
      ? ok({ dry: true, ...pair, parts: { stats: "12 games, 4 goals, 2 assists", matches: "12 matches", ranked: "3v3 4 games", training: "best Targets 12", sapphires: "300 Sapphires (paid 0, earned 300)" },
        message: "OldAccount → MainAccount, who keeps the name. Discord links stay as they are. It can't be undone." })
      : ok({ dry: false, ...pair, parts: { stats: "12 games, 4 goals added", matches: "12 matches moved", ranked: "3v3 4 games", training: "not moved, see the console", sapphires: "300 Sapphires (paid 0, earned 300) moved" },
        message: "Merged OldAccount into MainAccount. Its match history is rewritten in the background." });
  }
  if (p === "/discord/admin/maint/recountsmall") return q.get("confirm") === "true"
    ? ok({ applied: true, scanned: 407, unreadable: 0, games: 3, players: 5, ids: ["a", "b", "c"], careers: 5, report: `small-recount-${Date.now()}.json`, message: "Marked 3 old games not counted and took them out of 5 players' career stats." })
    : ok({ applied: false, scanned: 407, unreadable: 0, games: 3, players: 5, ids: ["a", "b", "c"], message: "3 old games had 2 or fewer on a side at kickoff. They count for 5 players." });
  return null;
}

// Uploaded club crests (docs/admin-api.md "Club crests (uploads)"): a pretend store, used unless
// --crests=real. The bench can't scale pictures, so a preview sends the dropped picture back as every
// size: the page's flow and layout can be tried here; real previews need the game server.
const CREST_MODE = flag("crests", "bench");
const benchPack = { building: false, built: "c56bc24fb33db696bcfd342a1d0fdbfa1d282f6b", sent: "c56bc24fb33db696bcfd342a1d0fdbfa1d282f6b", stale: false };
const crestOpts = { fit: "contain", crop: null, trim: true, bg: "auto", tol: 24, colors: 0, resample: "smooth" };
const benchCrests = [
  { id: "f000", character: "", crest: "f000", code: ":red_lions:", name: "red_lions", display: "Red Lions", kind: "club", aliases: [], rev: 1, liveRev: 1, packRev: 1,
    inPack: true, held: false, status: "live", width: 37, height: 11, sha256: "a1", options: { ...crestOpts }, source: { type: "png", width: 37, height: 11, bytes: 400 },
    usedBy: [{ id: "red_lions", name: "Red Lions" }], pending: null, created: Date.now() - 864e5, updated: Date.now() - 864e5, png: null },
  { id: "f001", character: "", crest: "f001", code: null, name: "blue_bears", display: "Blue Bears", kind: "club", aliases: [], rev: 1, liveRev: 0, packRev: 0,
    inPack: false, held: true, status: "held", width: 37, height: 11, sha256: "b2", options: { ...crestOpts, bg: "off" }, source: { type: "png", width: 37, height: 11, bytes: 400 },
    usedBy: [], pending: { club: "blue_bears", name: "Blue Bears", since: Date.now() - 3600e3, by: "dashboard:karl" }, created: Date.now() - 3600e3, updated: Date.now() - 3600e3, png: null },
];
const crestPics = new Map();   // id -> the last picture saved, for show and source
function crestList() {
  for (const c of benchCrests) if (!c.png) c.png = (crestPics.get(c.id) || SAMPLE_PNG).toString("base64");
  return { ok: true, range: { first: "f000", last: "f3ff" }, limits: { bytes: 4194304, side: 4096, minSide: 16, name: 40, display: 32, aliases: 5, colors: [2, 64], tol: [0, 128], width: 70, height: 40 },
    room: { slots: 128, used: benchCrests.filter((c) => c.status !== "retired").length, codesLeft: 1024 - benchCrests.length }, pack: benchPack,
    held: benchCrests.filter((c) => c.held).length, loadFailed: false, notes: [], items: benchCrests.filter((c) => c.status !== "retired").slice().reverse() };
}
function crestBench(method, p, q, body) {
  if (CREST_MODE === "real" || !p.startsWith("/discord/admin/clubs/crest/")) return null;
  const op = p.slice("/discord/admin/clubs/crest/".length);
  const ok = (o) => ({ status: 200, body: JSON.stringify({ ok: true, ...o }) });
  const bad = (status, error) => ({ status, body: JSON.stringify({ ok: false, error }) });
  const find = (id) => benchCrests.find((c) => c.id === id && c.status !== "retired");
  if (method === "GET") {
    if (op === "list") return { status: 200, body: JSON.stringify(crestList()) };
    if (op === "source") return find(q.get("id")) ? { status: 200, body: crestPics.get(q.get("id")) || SAMPLE_PNG, type: "image/png" } : bad(404, "no such crest");
    return null;
  }
  console.log(`  (bench) pretend crest ${op} ${q}`);
  if (op === "preview") {
    const pic = body && body.length ? body : find(q.get("id")) ? crestPics.get(q.get("id")) || SAMPLE_PNG : null;
    if (!pic) return bad(400, "send the picture as the body");
    const img = (w, h) => ({ png: pic.toString("base64"), width: w, height: h });
    const scales = (w, h) => Object.fromEntries([1, 2, 3, 4].map((g) => [g, img(w * g, h * g)]));
    return ok({ source: { type: "png", width: 512, height: 512, bytes: pic.length, decoded: [512, 512] },
      detected: { background: q.get("bg") === "off" ? null : "#ffffff", removed: q.get("bg") !== "off", trim: [40, 32, 432, 448], pixelArt: q.get("resample") === "pixel" },
      result: { width: 34, height: 40, colors: q.get("colors") && q.get("colors") !== "0" ? Number(q.get("colors")) : 57, sha256: crypto.createHash("sha256").update(pic).update(q.toString()).digest("hex") },
      images: { chat: img(34, 40), tile: img(16, 16), big: img(32, 32) }, renders: { chat: scales(9, 10), scorebug: scales(10, 12) },
      sizes: { chat: 10, tab: 10, nameTag: 10, bar: 10, scorebug: 12, tile: 16, big: 32, celebration: 64 }, room: crestList().room,
      warnings: q.get("fit") === "cover" ? [] : ["Wide logo: it will look small. Try fit=cover or a crop."], pack: benchPack });
  }
  if (op === "save") {
    const name = String(q.get("name") || "").replace(/^:+|:+$/g, "").toLowerCase();
    if (!name) return bad(400, "give name=");
    if (benchCrests.some((c) => c.name === name && c.id !== q.get("id") && c.status !== "retired")) return bad(409, `The name :${name}: is taken by ${name}.`);
    let c = q.get("id") ? find(q.get("id")) : null;
    if (q.get("id") && !c) return bad(404, "no such crest");
    const created = !c;
    const picture = !!(body && body.length) || ["fit", "bg", "tol", "colors", "resample", "trim", "crop"].some((k) => q.has(k));
    if (created) {
      const id = (0xf000 + benchCrests.length).toString(16);
      c = { id, character: String.fromCharCode(0xf000 + benchCrests.length), crest: id, code: null, aliases: [], rev: 0, liveRev: 0, packRev: 0, inPack: false, held: false,
        status: "held", width: 34, height: 40, options: { ...crestOpts }, source: null, usedBy: [], pending: null, created: Date.now() };
      benchCrests.push(c);
    }
    Object.assign(c, { name, display: q.get("display") || name, kind: q.get("kind") || "club", updated: Date.now() });
    if (picture) {
      if (body && body.length) crestPics.set(c.id, body);
      Object.assign(c, { rev: c.rev + 1, held: true, status: "held", sha256: q.get("expect") || "x", png: null });
    }
    const club = q.get("club");
    if (club) c.pending = { club, name: club, since: Date.now(), by: q.get("by") };
    const code = c.code || `:${name}:`;
    const message = !picture ? `Saved ${code}.` : c.liveRev ? `Saved ${code}. The pack keeps the old picture until this one is built in.` : `Saved ${code}. It goes in the pack when the pack is built.`;
    const assign = club ? { club, state: "pending", message: `${club} switches over once it's built and players have it.` } : { club: null, state: "none", message: "" };
    return ok({ repeat: false, created, changed: true, message: club ? `${message} ${assign.message}` : message, crest: c, assign, pack: benchPack, warnings: [] });
  }
  if (op === "build") {
    const held = benchCrests.filter((c) => c.held && (!q.get("id") || c.id === q.get("id")));
    if (!held.length) return ok({ changed: false, message: "Nothing is waiting for the pack.", released: [], held: 0, pack: benchPack });
    for (const c of held) Object.assign(c, { held: false, inPack: true, packRev: c.rev, status: "building" });
    Object.assign(benchPack, { building: true, stale: true });
    // a few seconds later the zip is built: the page's poll sees "Run push-pack"
    setTimeout(() => { for (const c of held) if (c.status === "building") c.status = "built"; benchPack.building = false; }, 5000);
    return ok({ changed: true, message: `Building the pack: ${held.map((c) => c.code || `:${c.name}:`).join(" and ")} in. Every painted menu is plain until scripts/push-pack.sh runs; run it when no game is on.`,
      released: held, held: benchCrests.filter((c) => c.held).length, pack: benchPack });
  }
  if (op === "delete") {
    const c = find(q.get("id"));
    if (!c) return bad(404, "no such crest");
    if (c.usedBy.length && q.get("detach") !== "true") return bad(409, `${c.usedBy[0].name} wears it. Send detach=true to clear its flag.`);
    const detached = c.usedBy;
    Object.assign(c, { status: "retired", held: c.inPack, usedBy: [], code: null });
    return ok({ repeat: false, message: `Retired :${c.name}:.${detached.length ? ` ${detached.map((x) => x.name).join(", ")} has no flag now.` : ""}${c.inPack ? " It leaves the pack when the pack is built." : ""}`, detached, crest: c, pack: benchPack });
  }
  if (op === "live") {
    const c = find(q.get("id"));
    if (!c) return bad(404, "no such crest");
    if (c.status !== "built") return bad(409, "It isn't built yet.");
    Object.assign(c, { status: "live", liveRev: c.rev, code: `:${c.name}:` });
    return ok({ message: `Marked :${c.name}: live.`, crest: c, pack: benchPack });
  }
  return null;
}

async function pluginBench(req, url, sent) {
  const p = url.pathname.replace(/^\/__plugin/, "");
  const crest = crestBench(req.method, p, url.searchParams, sent);
  if (crest) return crest;
  if (req.method === "GET") {
    const made = stage3Read(p, url);
    if (made) return made;
    const real = new URL(REAL + p + url.search);
    const admin = p.startsWith("/discord/admin/");
    const r = await fetch(real.href, { headers: admin ? signedGet(real) : p.startsWith("/discord/") ? { "X-Soccer-Token": TOKEN } : {} });
    // without the admin secret the real server answers 401 (or 404 for a route it lacks): use samples
    if ((r.status === 404 || r.status === 401) && admin) {
      if (p === "/discord/admin/clubs/show") return { status: 200, body: JSON.stringify({ ok: true, club: { id: url.searchParams.get("club"), name: "Bench Club", flag: null, flagCode: null, crest: null,
        color: "gold", colorHex: "#ffaa00", gradient: [], shortName: "", code: "", codeShown: "BEN", logo: null, logoUrl: null, members: 0, inPlay: false, playingOn: null,
        fixtures: { scheduled: 0, live: 0, finished: 0, cancelled: 0 }, memberList: [], suffix: "", fixtureList: [], standing: null } }) };
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
    // --pack=stale: the plugin's pack.built / pack.sent / pack.stale, as after a bow edit nobody published
    if (PACK_MODE === "stale" && r.ok && (p === "/discord/admin/server" || p === "/discord/admin/bows")) {
      const body = await r.json();
      if (body.pack && typeof body.pack === "object") Object.assign(body.pack, { built: "c56bc24fb33db696bcfd342a1d0fdbfa1d282f6b", sent: "4dc054cf9b513b514f1c39d7f84bddd3cf06a9b5", stale: true });
      else Object.assign(body, { pack: "c56bc24f", stale: true });
      return { status: 200, body: JSON.stringify(body) };
    }
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "application/json" };
  }
  const made = stage3Write(p, url.searchParams);
  if (made) {
    console.log(`  (bench) pretend ${req.method} ${p}`);
    // the recount takes a while on the real server: long enough here to see the dialog working
    if (p === "/discord/admin/maint/recountsmall") await new Promise((ok) => setTimeout(ok, 1500));
    return made;
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

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // the app's own files, read fresh each time: a change to app.js or app.css needs only a reload
    if (url.pathname === "/app.js" || url.pathname === "/app.css") {
      res.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(read(url.pathname.slice(1)));
    }
    if (url.pathname.startsWith("/__plugin/")) {
      // a write's body: kept for the crest store (a preview sends the picture back)
      const sent = req.method === "GET" ? null : await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
      const r = await pluginBench(req, url, sent);
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
}

// this PC only: the bench's reads are signed with the real admin secret, so it must never be
// reachable from the network (both loopbacks, since "localhost" can mean either)
http.createServer(handle).listen(PORT, "127.0.0.1", () => console.log(`admin bench on http://localhost:${PORT}/__login (cup: ${CUP_MODE}, ranked: ${RANKED_MODE}, reads ${ADMIN_SECRET ? "signed" : "unsigned: admin pages use samples"})`));
http.createServer(handle).listen(PORT, "::1").on("error", () => {});
