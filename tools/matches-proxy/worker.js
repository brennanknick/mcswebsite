/*
 * MCS match-history proxy (Cloudflare Worker)
 * =============================================================================
 * mcsoccer.net is served over HTTPS, but the game server only serves its match
 * history API over plain HTTP on port 25543, and browsers block an HTTPS page
 * from reading http:// URLs ("mixed content"). This Worker sits in between:
 *
 *   browser --HTTPS--> https://api.mcsoccer.net/api/v1/...  (this file)
 *                      --HTTP--> http://play.mcsoccer.net:25543/api/v1/...
 *
 * It only forwards the public read-only routes from docs/match-history.md,
 * adds the CORS headers the site needs, and caches answers so the game server
 * sees one polite client instead of every visitor. When the game server is
 * down it keeps serving the last good copy, marked "X-MCS-Cache: STALE".
 *
 * DEPLOY (about 5 minutes, in the Cloudflare account that runs mcsoccer.net)
 * -----------------------------------------------------------------------------
 *  1. In the dashboard sidebar open "Workers & Pages", then "Create" /
 *     "Create application", then "Start with Hello World!". Name it
 *     "mcs-matches" and press "Deploy".
 *  2. Press "Edit code". Select all of the sample code, delete it, paste this
 *     whole file in its place, and press "Deploy".
 *  3. Give it the site's own address: the Worker's "Settings" tab ->
 *     "Domains & Routes" -> "Add" -> "Custom domain" -> api.mcsoccer.net.
 *     Cloudflare creates the DNS record and certificate itself. (The
 *     workers.dev address it also gets works too, but only a custom domain
 *     lets the shared cache below do anything.)
 *  4. Check the compatibility date (Settings tab, "Runtime" section). It must
 *     be 2024-10-14 or later: custom ports in fetch() URLs (":25543") are
 *     honoured from 2024-09-02 ("allow_custom_ports"), and this file relies on
 *     the 2024-10-14 fix for promises shared between requests. A Worker made
 *     in the dashboard gets the current date, so a new one is fine.
 *  5. Test it: open https://api.mcsoccer.net/api/v1/meta in a browser. You
 *     should see JSON like {"server":"MCS","matches":...}.
 *     {"error":"game server unreachable"} / "timed out" / "unavailable" mean
 *     the game server is down, isn't running the match-history build yet, or
 *     the ORIGIN value is wrong.
 *  6. Set matchesApi in the website's site.config.js to
 *     "https://api.mcsoccer.net".
 *
 * To point it at a different game server: Settings -> "Variables and
 * Secrets" -> "Add", type "Text", name ORIGIN, value e.g.
 * http://play.mcsoccer.net:25543, then "Deploy". Use a host NAME, never a
 * bare IP: Workers cannot fetch IP addresses. Without ORIGIN, the default
 * below (DEFAULT_ORIGIN) is used.
 *
 * The free plan allows 100,000 requests a day (reset at 00:00 UTC) and 10 ms
 * of CPU per request; a cache hit here is little more than a Map lookup.
 *
 * Keep the DNS record for play.mcsoccer.net "DNS only" (grey cloud): through
 * Cloudflare's proxy (orange cloud) port 25543 would be ignored, and
 * Minecraft would break too.
 *
 * What it serves (everything else is a 404, and only GET/HEAD/OPTIONS work):
 *   /api/v1/meta  /api/v1/live  /api/v1/matches  /api/v1/matches/{id}
 *   /api/v1/players  /api/v1/players/{uuid}  /api/v1/leaders  /api/v1/ranked
 *   /crest/{hex}.png
 *
 * Headers the site can read on every response:
 *   X-MCS-Cache  HIT    served from the proxy's saved copy (still fresh)
 *                MISS   just fetched from the game server
 *                STALE  the game server is down or failing: this is the last
 *                       good copy (tell the visitor it may be out of date)
 *                BYPASS not cacheable (errors, 404s, "loading", preflights)
 *   X-MCS-Age    seconds since the proxy fetched the copy (HIT and STALE)
 *   ETag, Retry-After (Retry-After usually comes with 502/503/504 errors and
 *                "loading" answers: wait that many seconds, then retry)
 *
 * Caching: an in-memory copy per Worker instance (always), plus Cloudflare's
 * Cache API when it is active. The Cache API does nothing on *.workers.dev;
 * it works on a custom domain such as api.mcsoccer.net.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Game server web port. A host name: Workers cannot fetch a bare IP. */
const DEFAULT_ORIGIN = "http://play.mcsoccer.net:25543";

/** Give up on the game server after this long (headers and body). */
const ORIGIN_TIMEOUT_MS = 6000;
/** After a timeout or refused connection, stop trying for this long. */
const ORIGIN_DOWN_MS = 10000;
/** At most this many game-server requests at once per Worker instance
 *  (the game server itself works on at most 3 at once, doc 1.5). */
const ORIGIN_CONCURRENCY = 3;
/** Requests waiting for one of those slots: at most this many, this long. */
const ORIGIN_QUEUE_MAX = 30;
const ORIGIN_QUEUE_WAIT_MS = 5000;
/** A slot held longer than this is assumed lost and taken back. */
const ORIGIN_SLOT_LEASE_MS = 30000;
/** Requests that join an identical request already in flight wait this long. */
const COALESCE_WAIT_MS = 15000;

/** The game server ignores a longer query string completely (doc 2.0). */
const MAX_QUERY_LENGTH = 2048;
/** ...and reads only the first 32 "&"-separated pairs. */
const MAX_QUERY_PAIRS = 32;

/** In-memory cache limits (a Worker instance has 128 MB). */
const MEM_MAX_ENTRIES = 500;
const MEM_MAX_BYTES = 24 * 1024 * 1024;
/** Bodies bigger than this are passed on but not cached. */
const MAX_CACHEABLE_BYTES = 1024 * 1024;
/** Cache API key prefix; bump the version to drop every old copy. */
const CACHE_API_PREFIX = "/__mcs-proxy-cache/v1";

const USER_AGENT = "mcs-matches-proxy/1 (+https://mcsoccer.net)";
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// ---------------------------------------------------------------------------
// Routes (docs/match-history.md, section 2). Paths are matched after
// percent-decoding, case-sensitively, with one optional trailing slash on API
// routes and none on crests, exactly like the game server. The forwarded path
// is rebuilt from the match, so nothing else from the visitor's path is sent.
//
//   params    query parameters passed on (first occurrence of each, as-is);
//             the game server ignores every other parameter anyway. If a later
//             plugin build adds a parameter, add it here or it is dropped.
//   ttl       seconds a copy is served without asking the game server
//   staleFor  extra seconds a copy may still be served if the game server fails
//   browser   Cache-Control sent to the browser with a fresh copy
// ---------------------------------------------------------------------------

const LIST_TTL = 20;
const LIST_STALE = 15 * MIN;
const LIST_BROWSER = "public, max-age=15";

const ROUTES = [
  {
    name: "meta",
    re: /^\/api\/v1\/meta\/?$/,
    path: () => "/api/v1/meta",
    params: [],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    // Live scores: short TTL, and only a short stale window, because an old
    // live board would show matches as "in progress" long after they ended.
    name: "live",
    re: /^\/api\/v1\/live\/?$/,
    path: () => "/api/v1/live",
    params: [],
    ttl: 4, staleFor: 30, browser: "no-store",
  },
  {
    name: "matches",
    re: /^\/api\/v1\/matches\/?$/,
    path: () => "/api/v1/matches",
    params: ["page", "size", "field", "mode", "player", "results", "ranked"],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    // One match record: effectively immutable (doc 4.17).
    name: "match",
    re: /^\/api\/v1\/matches\/([0-9]{8}-[0-9]{6}-[a-z0-9_]{1,40})\/?$/,
    path: (m) => "/api/v1/matches/" + m[1],
    params: [],
    ttl: HOUR, staleFor: DAY, browser: "public, max-age=3600",
  },
  {
    name: "search",
    re: /^\/api\/v1\/players\/?$/,
    path: () => "/api/v1/players",
    params: ["q"],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    // The game server accepts an upper-case UUID and lower-cases it; doing it
    // here too means both spellings share one cached copy.
    name: "player",
    re: /^\/api\/v1\/players\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?$/,
    path: (m) => "/api/v1/players/" + m[1].toLowerCase(),
    params: ["page", "size"],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    name: "leaders",
    re: /^\/api\/v1\/leaders\/?$/,
    path: () => "/api/v1/leaders",
    params: ["stat", "mode", "min", "limit"],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    // The ranked ladder (doc 2.8). It comes from the ranked ratings, not the
    // match index, so it answers normally while the index is loading.
    name: "ranked",
    re: /^\/api\/v1\/ranked\/?$/,
    path: () => "/api/v1/ranked",
    params: ["queue", "limit"],
    ttl: LIST_TTL, staleFor: LIST_STALE, browser: LIST_BROWSER,
  },
  {
    // Club crest PNG: 4 or 5 lower-case hex digits, no trailing slash.
    name: "crest",
    re: /^\/crest\/([0-9a-f]{4,5})\.png$/,
    path: (m) => "/crest/" + m[1] + ".png",
    params: [],
    ttl: DAY, staleFor: DAY, browser: "public, max-age=86400",
    image: true,
  },
];

// ---------------------------------------------------------------------------
// Per-instance state. A Worker instance (isolate) serves many requests, so
// these survive between requests until Cloudflare recycles the instance.
// Only plain data is shared between requests, never Response objects.
// ---------------------------------------------------------------------------

/** key -> { body: ArrayBuffer, contentType, etag, storedAt }. Map order = LRU order. */
const memCache = new Map();
let memBytes = 0;
/** key -> { promise, startedAt }: the one origin fetch identical requests share. */
const inflight = new Map();
/** Origin fetch slots in use: token -> time taken. */
const originSlots = new Map();
let nextSlotToken = 1;
const slotWaiters = [];
/** While Date.now() is below this, the game server counts as down. */
let originDownUntil = 0;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error("mcs-proxy: unexpected error", err && err.stack ? err.stack : err);
      return jsonResponse(500, { error: "proxy error" }, "BYPASS");
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const match = matchRoute(url.pathname);
  if (!match) return jsonResponse(404, { error: "not found" }, "BYPASS");

  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return preflight(request);
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(405, { error: "method not allowed" }, "BYPASS", { Allow: "GET, HEAD, OPTIONS" });
  }

  const origin = resolveOrigin(env);
  if (!origin) {
    return jsonResponse(500, { error: "proxy misconfigured: ORIGIN must be an http:// or https:// URL" }, "BYPASS");
  }

  const query = canonicalQuery(url.search, match.route.params);
  const key = match.path + (query ? "?" + query : "");
  const outcome = await getOutcome(key, match.route, origin, request, ctx);
  return render(outcome, match.route, request, method);
}

/** Percent-decode the path (as the game server does) and find its route. */
function matchRoute(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null; // a broken %-escape can never match a route
  }
  for (const route of ROUTES) {
    const m = route.re.exec(path);
    if (m) return { route, path: route.path(m) };
  }
  return null;
}

/** The game server's base URL: env.ORIGIN, else the default. Never the request. */
function resolveOrigin(env) {
  const raw = env && typeof env.ORIGIN === "string" && env.ORIGIN.trim() ? env.ORIGIN.trim() : DEFAULT_ORIGIN;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin; // scheme://host:port, any path in the setting is dropped
}

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

/**
 * Keep only the parameters this route understands, first occurrence of each,
 * in the visitor's order, values untouched apart from escaping characters the
 * game server's URL parser would reject with a CORS-less 400 (doc 2.0). The
 * game server ignores unknown and repeated parameters, so the answer is the
 * same, but junk like ?x=123 can no longer be used to bypass the cache.
 */
function canonicalQuery(search, allowed) {
  if (!allowed.length) return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw || raw.length > MAX_QUERY_LENGTH) return ""; // the game server would ignore it all
  const seen = new Set();
  const out = [];
  for (const pair of raw.split("&").slice(0, MAX_QUERY_PAIRS)) {
    const eq = pair.indexOf("=");
    const name = formDecode(eq < 0 ? pair : pair.slice(0, eq));
    if (name === null || !allowed.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name + "=" + escapeQueryValue(eq < 0 ? "" : pair.slice(eq + 1)));
  }
  return out.join("&");
}

function formDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** Escape stray "%" and every character outside a conservative safe set. */
function escapeQueryValue(s) {
  return s.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-_.!~*'();/?:@=+$,%]/gu, (ch) => {
    if (ch === "%") return "%25";
    try {
      return encodeURIComponent(ch);
    } catch {
      return "%EF%BF%BD"; // a lone surrogate
    }
  });
}

// ---------------------------------------------------------------------------
// Cache lookup, coalescing and the origin fetch
// ---------------------------------------------------------------------------

function isFresh(entry, route, now) {
  const age = now - entry.storedAt;
  return age >= -MIN * 1000 && age < route.ttl * 1000;
}

function isUsableStale(entry, route, now) {
  const age = now - entry.storedAt;
  return age >= -MIN * 1000 && age < (route.ttl + route.staleFor) * 1000;
}

/**
 * Decide what to answer. Returns one of:
 *   { kind: "entry", entry, label }   a cached/fetched 200 copy (HIT, MISS, STALE)
 *   { kind: "pass", status, contentType, body, retryAfter }   an origin answer passed on
 *   { kind: "error", status, error, retryAfter }   our own JSON error
 */
async function getOutcome(key, route, origin, request, ctx) {
  const now = Date.now();
  const mem = memGet(key);
  if (mem && isFresh(mem, route, now)) return { kind: "entry", entry: mem, label: "HIT" };

  // Join an identical request already in flight, or start one. The leader's
  // work is handed to waitUntil so it finishes even if its visitor leaves.
  let job = inflight.get(key);
  if (!job || now - job.startedAt > COALESCE_WAIT_MS + ORIGIN_TIMEOUT_MS) {
    const promise = refresh(key, route, origin, request, ctx, mem).catch((err) => {
      console.error("mcs-proxy: refresh failed", err && err.stack ? err.stack : err);
      return { kind: "error", status: 500, error: "proxy error" };
    });
    job = { promise, startedAt: now };
    inflight.set(key, job);
    promise.then(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), COALESCE_WAIT_MS);
  });
  const outcome = await Promise.race([job.promise, timeout]);
  clearTimeout(timer);
  if (outcome) return outcome;
  return failure(mem && isUsableStale(mem, route, Date.now()) ? mem : null, 504, "game server timed out", 5);
}

/** Serve the stale copy if there is one, else an error. */
function failure(stale, status, error, retryAfter) {
  if (stale) return { kind: "entry", entry: stale, label: "STALE" };
  return { kind: "error", status, error, retryAfter };
}

async function refresh(key, route, origin, request, ctx, mem) {
  // A copy another instance in this data centre saved (Cache API, if active).
  let candidate = mem;
  const shared = await cacheApiGet(key, request);
  if (shared && (!candidate || shared.storedAt > candidate.storedAt)) candidate = shared;

  let now = Date.now();
  if (candidate && isFresh(candidate, route, now)) {
    memSet(key, candidate);
    return { kind: "entry", entry: candidate, label: "HIT" };
  }
  const stale = candidate && isUsableStale(candidate, route, now) ? candidate : null;

  // The game server failed moments ago: do not make every visitor wait for it.
  if (now < originDownUntil) {
    return failure(stale, 503, "game server unavailable", Math.max(1, Math.ceil((originDownUntil - now) / 1000)));
  }

  const token = await acquireOriginSlot();
  if (!token) return failure(stale, 503, "busy", 2);

  const headers = new Headers({ "User-Agent": USER_AGENT });
  // Accept is the only visitor header passed on. No cookies, no auth, nothing else.
  const accept = request.headers.get("Accept");
  headers.set("Accept", accept && accept.length <= 256 && /^[\x20-\x7e]*$/.test(accept)
    ? accept
    : route.image ? "image/png" : "application/json");
  // Revalidate our own old copy cheaply (records and crests have ETags).
  if (candidate && candidate.etag) headers.set("If-None-Match", candidate.etag);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  let res;
  let body;
  try {
    res = await fetch(origin + key, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    body = await res.arrayBuffer(); // still under the timeout
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const retry = markOriginDown();
    console.warn("mcs-proxy: origin " + (timedOut ? "timed out" : "unreachable") + " for " + key + ": " + (err && err.message));
    return failure(stale, timedOut ? 504 : 502, timedOut ? "game server timed out" : "game server unreachable", retry);
  } finally {
    clearTimeout(timer);
    releaseOriginSlot(token);
  }

  now = Date.now();
  const status = res.status;
  const contentType = res.headers.get("Content-Type") || "";
  const isJson = /^application\/json\b/i.test(contentType);

  // Our old copy is still current.
  if (status === 304 && candidate) {
    originDownUntil = 0;
    const entry = { ...candidate, storedAt: now };
    memSet(key, entry);
    cacheApiPut(key, entry, route, request, ctx);
    return { kind: "entry", entry, label: "MISS" };
  }

  if (status === 200) {
    originDownUntil = 0;
    const expected = route.image ? /^image\/png\b/i.test(contentType) : isJson;
    if (!expected) return failure(stale, 502, "unexpected response from game server", 5);
    // Startup "loading" placeholder (doc 1.6): never cache it; prefer a saved copy.
    if (isJson && isLoadingBody(body)) {
      if (stale) return { kind: "entry", entry: stale, label: "STALE" };
      return { kind: "pass", status: 200, contentType, body, retryAfter: "2" };
    }
    if (body.byteLength > MAX_CACHEABLE_BYTES) {
      return { kind: "pass", status: 200, contentType, body };
    }
    const entry = { body, contentType, etag: res.headers.get("ETag") || "", storedAt: now };
    memSet(key, entry);
    cacheApiPut(key, entry, route, request, ctx);
    return { kind: "entry", entry, label: "MISS" };
  }

  // Not found (unknown match, player or crest): pass on, never cache.
  if (status === 404) return { kind: "pass", status, contentType, body };

  if (status >= 500) {
    // 520-530 are Cloudflare's own "could not reach the origin" answers.
    if (status >= 520 && status <= 530) {
      return failure(stale, 502, "game server unreachable", markOriginDown());
    }
    // The plugin's own errors: 500, and 503 busy / loading / switched off.
    if (stale) return { kind: "entry", entry: stale, label: "STALE" };
    if (isJson) return { kind: "pass", status, contentType, body, retryAfter: res.headers.get("Retry-After") };
    return { kind: "error", status: 502, error: "game server error (HTTP " + status + ")", retryAfter: 5 };
  }

  // Anything else (redirects, other 4xx) is not something the API does.
  if (status >= 400 && status < 500 && isJson) return { kind: "pass", status, contentType, body };
  if (status === 403 && new TextDecoder().decode(body.slice(0, 4096)).includes("1003")) {
    return { kind: "error", status: 502, error: "Cloudflare error 1003: ORIGIN must be a host name, not an IP address" };
  }
  return { kind: "error", status: 502, error: "unexpected response from game server (HTTP " + status + ")" };
}

/** Mark the game server as down for a short while; returns Retry-After seconds. */
function markOriginDown() {
  originDownUntil = Date.now() + ORIGIN_DOWN_MS;
  return Math.ceil(ORIGIN_DOWN_MS / 1000);
}

/** True for the small {"...","loading":true} bodies sent while the index loads. */
function isLoadingBody(buf) {
  if (buf.byteLength > 65536) return false;
  const text = new TextDecoder().decode(buf);
  if (!text.includes('"loading"')) return false;
  try {
    const json = JSON.parse(text);
    return !!json && json.loading === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Origin concurrency slots. Self-healing: a slot whose request vanished is
// reclaimed after ORIGIN_SLOT_LEASE_MS, and a waiter re-checks on every wake.
// ---------------------------------------------------------------------------

function slotsInUse(now) {
  for (const [token, takenAt] of originSlots) {
    if (now - takenAt > ORIGIN_SLOT_LEASE_MS || now < takenAt - MIN * 1000) originSlots.delete(token);
  }
  return originSlots.size;
}

async function acquireOriginSlot() {
  const deadline = Date.now() + ORIGIN_QUEUE_WAIT_MS;
  for (;;) {
    const now = Date.now();
    if (slotsInUse(now) < ORIGIN_CONCURRENCY) {
      const token = nextSlotToken++;
      originSlots.set(token, now);
      return token;
    }
    const left = deadline - now;
    // Forget waiters whose request has gone away without cleaning up.
    for (let i = slotWaiters.length - 1; i >= 0; i--) {
      if (now > slotWaiters[i].deadline + 1000) slotWaiters.splice(i, 1);
    }
    if (left <= 0 || slotWaiters.length >= ORIGIN_QUEUE_MAX) return 0;
    await new Promise((resolve) => {
      const waiter = { wake: resolve, timer: 0, deadline };
      waiter.timer = setTimeout(() => {
        const i = slotWaiters.indexOf(waiter);
        if (i >= 0) slotWaiters.splice(i, 1);
        resolve();
      }, left);
      slotWaiters.push(waiter);
    });
  }
}

function releaseOriginSlot(token) {
  originSlots.delete(token);
  const next = slotWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.wake();
  }
}

// ---------------------------------------------------------------------------
// In-memory LRU-ish cache
// ---------------------------------------------------------------------------

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  memCache.delete(key); // move to the newest end
  memCache.set(key, entry);
  return entry;
}

function memSet(key, entry) {
  const old = memCache.get(key);
  if (old) {
    memBytes -= old.body.byteLength;
    memCache.delete(key);
  }
  memCache.set(key, entry);
  memBytes += entry.body.byteLength;
  while (memCache.size > MEM_MAX_ENTRIES || memBytes > MEM_MAX_BYTES) {
    const oldestKey = memCache.keys().next().value;
    memBytes -= memCache.get(oldestKey).body.byteLength;
    memCache.delete(oldestKey);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Cache API (optional; a no-op on *.workers.dev, absent in Node)
// ---------------------------------------------------------------------------

function sharedCache() {
  try {
    return typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheApiKey(key, request) {
  return new Request(new URL(request.url).origin + CACHE_API_PREFIX + key, { method: "GET" });
}

async function cacheApiGet(key, request) {
  const cache = sharedCache();
  if (!cache) return null;
  try {
    const res = await cache.match(cacheApiKey(key, request));
    if (!res || res.status !== 200) return null;
    const storedAt = Number(res.headers.get("X-MCS-Stored-At"));
    if (!Number.isFinite(storedAt) || storedAt <= 0) return null;
    return {
      body: await res.arrayBuffer(),
      contentType: res.headers.get("Content-Type") || "",
      etag: res.headers.get("X-MCS-ETag") || "",
      storedAt,
    };
  } catch {
    return null;
  }
}

function cacheApiPut(key, entry, route, request, ctx) {
  const cache = sharedCache();
  if (!cache) return;
  try {
    const headers = new Headers({
      "Content-Type": entry.contentType,
      // Keep it for as long as it could be served, fresh or stale.
      "Cache-Control": "public, max-age=" + (route.ttl + route.staleFor),
      "X-MCS-Stored-At": String(entry.storedAt),
    });
    if (entry.etag) headers.set("X-MCS-ETag", entry.etag);
    const put = cache.put(cacheApiKey(key, request), new Response(entry.body.slice(0), { status: 200, headers }));
    const safe = Promise.resolve(put).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(safe);
  } catch {
    // caching is best effort
  }
}

// ---------------------------------------------------------------------------
// Responses to the browser
// ---------------------------------------------------------------------------

function baseHeaders(cacheLabel) {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag, Retry-After, X-MCS-Cache, X-MCS-Age",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-MCS-Cache": cacheLabel,
  });
}

function jsonResponse(status, obj, cacheLabel, extra) {
  const headers = baseHeaders(cacheLabel);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers });
}

/** CORS preflight: the game server cannot answer OPTIONS, so we do. */
function preflight(request) {
  const headers = baseHeaders("BYPASS");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  const asked = request.headers.get("Access-Control-Request-Headers");
  // Echo the requested header names; none of them is forwarded anyway.
  if (asked && /^[A-Za-z0-9!#$%&'*+.^_`|~, -]{1,512}$/.test(asked)) {
    headers.set("Access-Control-Allow-Headers", asked);
  }
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Vary", "Access-Control-Request-Headers");
  return new Response(null, { status: 204, headers });
}

function render(outcome, route, request, method) {
  const head = method === "HEAD";

  if (outcome.kind === "entry") {
    const { entry, label } = outcome;
    const headers = baseHeaders(label);
    if (entry.contentType) headers.set("Content-Type", entry.contentType);
    // A stale copy must not be kept by the browser: the next visit tries again.
    headers.set("Cache-Control", label === "STALE" ? "no-store" : route.browser);
    if (entry.etag) headers.set("ETag", entry.etag);
    if (label !== "MISS") headers.set("X-MCS-Age", String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))));
    if (label !== "STALE" && entry.etag && etagMatches(request.headers.get("If-None-Match"), entry.etag)) {
      headers.delete("Content-Type");
      return new Response(null, { status: 304, headers });
    }
    return new Response(head ? null : entry.body.slice(0), { status: 200, headers });
  }

  if (outcome.kind === "pass") {
    const headers = baseHeaders("BYPASS");
    if (outcome.contentType) headers.set("Content-Type", outcome.contentType);
    headers.set("Cache-Control", "no-store");
    if (outcome.retryAfter) headers.set("Retry-After", String(outcome.retryAfter));
    // Coalesced requests share one outcome, so each response gets its own copy.
    return new Response(head ? null : outcome.body.slice(0), { status: outcome.status, headers });
  }

  const extra = outcome.retryAfter ? { "Retry-After": String(outcome.retryAfter) } : undefined;
  const res = jsonResponse(outcome.status, { error: outcome.error }, "BYPASS", extra);
  return head ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

/** Weak comparison, as the game server does: W/"x", "x" and * all match. */
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const strip = (t) => t.trim().replace(/^W\//, "");
  const want = strip(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || strip(t) === want);
}
