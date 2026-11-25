/* ==================================================================
   MCS: preview.mcsoccer.net
   Brenn, 2026-11-25: a public preview of a site remodel before it goes
   live. This Worker serves the website repo's PREVIEW branch (env.BRANCH,
   default "preview") straight from GitHub, the way GitHub Pages serves
   main on mcsoccer.net: push a remodel to that branch and it shows here
   within a minute. Deploy with tools/preview/deploy.mjs.

   It is never indexed (X-Robots-Tag and its own robots.txt), carries a
   small "Preview" tag so nobody takes it for the live site, and serves
   only files: no secrets, no writes.
   ================================================================== */

const REPO = "brennanknick/mcswebsite";
const CACHE_SECONDS = 60;

const TYPES = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff",
  ttf: "font/ttf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  webmanifest: "application/manifest+json",
};

const HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// a small tag in the corner of every page, so a shared link can't pass for the live site
const TAG = `<a href="https://mcsoccer.net/" style="position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 10px;` +
  `font:700 12px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:#0b1210;` +
  `background:#ffd98a;box-shadow:0 2px 8px rgba(0,0,0,.4)" title="This is a preview. The live site is mcsoccer.net">Preview</a>`;

const extOf = (p) => { const m = p.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ""; };

async function fromGitHub(branch, file) {
  return fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/${file}`, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
}

function respond(body, status, type, extra = {}) {
  return new Response(body, { status, headers: { ...HEADERS, "Content-Type": type, ...extra } });
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return respond("GET only", 405, TYPES.txt, { Allow: "GET, HEAD" });
    const url = new URL(request.url);
    const branch = (env.BRANCH || "preview").trim();

    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return respond("Bad path", 400, TYPES.txt); }
    // files only, and only inside the repo
    if (path.split("/").some((seg) => seg === ".." || seg.startsWith(".git"))) return respond("Not found", 404, TYPES.txt);
    if (path === "/robots.txt") return respond("User-agent: *\nDisallow: /\n", 200, TYPES.txt);
    if (path === "/sitemap.xml") return respond("Not found", 404, TYPES.txt);

    let file = path.replace(/^\/+/, "");
    if (file === "" || file.endsWith("/")) file += "index.html";
    let ext = extOf(file);

    // "/matches" is a folder: send it to "/matches/" so the page's relative links work, as Pages does
    if (!ext) {
      const probe = await fromGitHub(branch, file + "/index.html");
      if (probe.ok) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    }

    let res = await fromGitHub(branch, file);
    let status = 200;
    if (!res.ok) {
      if (res.status !== 404) return respond("GitHub isn't answering right now. Try again in a minute.", 502, TYPES.txt);
      res = await fromGitHub(branch, "404.html");
      if (!res.ok) return respond("Not found", 404, TYPES.txt);
      status = 404;
      ext = "html";
    }

    const type = TYPES[ext] || "application/octet-stream";
    const cache = { "Cache-Control": `public, max-age=${CACHE_SECONDS}` };
    if (request.method === "HEAD") return respond(null, status, type, cache);
    const out = respond(res.body, status, type, cache);
    if (ext !== "html") return out;
    return new HTMLRewriter().on("body", { element(el) { el.append(TAG, { html: true }); } }).transform(out);
  },
};
