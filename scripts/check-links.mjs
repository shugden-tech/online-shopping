// Post-build link check: node scripts/check-links.mjs (run after the site is built into dist/).
// No dependencies. Checks internal href/src/srcset targets, the sitemap, and mn/en hreflang on every page.
import { readdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const ATTR = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SRCSET = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const LINK_TAG = /<link\b[^>]*>/gi;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** dist/a/b/index.html -> "/a/b/", dist/404.html -> "/404.html" */
function pagePathOf(file) {
  const rel = path.relative(DIST, file).split(path.sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel}`;
}

function decodeAttr(s) {
  return s.replace(/&amp;/g, "&").trim();
}

function linksIn(html) {
  const found = [];
  for (const m of html.matchAll(ATTR)) found.push(decodeAttr(m[1] ?? m[2] ?? m[3] ?? ""));
  for (const m of html.matchAll(SRCSET)) {
    for (const candidate of decodeAttr(m[1] ?? m[2] ?? "").split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) found.push(url);
    }
  }
  return found;
}

/** External (http, //), mailto:, tel:, data:, javascript: and pure #hash links are not checked. */
function isIgnored(link) {
  if (!link || link.startsWith("#")) return true;
  if (link.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(link);
}

/** Pages rendered on demand by the Worker (not in dist/): the bundle list and bundle pages (0005). */
const ON_DEMAND = [/^\/(en\/)?bundles\/([a-z0-9][a-z0-9-]*\/)?$/];

/** Does a site path resolve to a file in dist/? */
function targetExists(pathname) {
  if (ON_DEMAND.some((re) => re.test(pathname))) return true;
  let p;
  try {
    p = decodeURI(pathname);
  } catch {
    p = pathname;
  }
  const rel = p.replace(/^\/+/, "");
  const candidates = p.endsWith("/") || rel === ""
    ? [path.join(DIST, rel, "index.html")]
    : [path.join(DIST, rel), path.join(DIST, rel, "index.html"), path.join(DIST, `${rel}.html`)];
  return candidates.some(isFile);
}

async function main() {
  if (!existsSync(DIST)) {
    console.error("dist/ not found. Build the site first.");
    process.exitCode = 1;
    return;
  }

  const files = await walk(DIST);
  const problems = [];
  let linkCount = 0;

  for (const file of files) {
    const html = await readFile(file, "utf8");
    const page = pagePathOf(file);
    const base = new URL(page, "http://local.invalid");
    const seen = new Set();

    for (const raw of linksIn(html)) {
      if (isIgnored(raw) || seen.has(raw)) continue;
      seen.add(raw);

      let pathname;
      try {
        pathname = new URL(raw, base).pathname;
      } catch {
        problems.push(`${page} -> ${raw}`);
        continue;
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/_image")) continue;

      linkCount++;
      if (!targetExists(pathname)) problems.push(`${page} -> ${raw}`);
    }

    const isNotFound = path.dirname(file) === DIST && path.basename(file) === "404.html";
    if (!isNotFound) {
      const tags = html.match(LINK_TAG) ?? [];
      for (const lang of ["mn", "en"]) {
        const found = tags.some(
          (t) =>
            /\brel\s*=\s*["']alternate["']/i.test(t) &&
            new RegExp(`\\bhreflang\\s*=\\s*["']${lang}["']`, "i").test(t),
        );
        if (!found) problems.push(`${page} -> missing <link rel="alternate" hreflang="${lang}">`);
      }
    }
  }

  if (!isFile(path.join(DIST, "sitemap-index.xml"))) {
    problems.push("/sitemap-index.xml -> missing from dist/");
  }

  for (const line of problems) console.log(line);
  console.log(
    `check-links: ${files.length} pages, ${linkCount} internal links checked, ${problems.length} problem(s)`,
  );
  if (problems.length) process.exitCode = 1;
}

main();
