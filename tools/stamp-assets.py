"""Stamp every CSS/JS link with a hash of that file's contents.

    python tools/stamp-assets.py

Browsers (and GitHub Pages, which sends max-age=600) keep serving a cached
stylesheet after it changes, so a fix can look like it did nothing. Each
link gets ?v=<first 8 hex of sha1(file)>: the URL changes exactly when the
file does, so browsers refetch then and only then. Run before committing.
"""
import hashlib
import io
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ["assets/css/site.css", "assets/js/site.js", "site.config.js"]
PAGES = ["index.html", "rules/index.html", "404.html"]


def digest(rel):
    return hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:8]


versions = {a: digest(a) for a in ASSETS}

for page in PAGES:
    path = ROOT / page
    raw = io.open(path, encoding="utf-8", newline="").read()
    out = raw
    for asset, v in versions.items():
        # matches href="assets/css/site.css", "../assets/...", "/assets/...",
        # with or without an existing ?v=
        pattern = re.compile(r'((?:href|src)="(?:\.\./|/)?' + re.escape(asset) + r')(\?v=[0-9a-f]+)?"')
        out = pattern.sub(lambda m: f'{m.group(1)}?v={v}"', out)
    if out != raw:
        io.open(path, "w", encoding="utf-8", newline="").write(out)
    print(f"{page:18} " + "  ".join(f"{a.split('/')[-1]}?v={versions[a]}" for a in ASSETS))
