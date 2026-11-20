// Loaders for the on-demand bundle pages (/bundles/, /bundles/{id}/ and the /en/ twins; 0005). Server-only.
// Rendered from D1 on each request and cached briefly at the edge, so admin edits show without a rebuild.
import type { AstroGlobal } from "astro";
import { getSettings } from "../settings";
import { getProduct } from "../products";
import { productPath, route, type Locale } from "../../i18n";
import { getBundle, listBundles } from "./store";
import { BUNDLE_ID_RE, type BundlePart, type BundleView } from "./types";

export const PAGE_CACHE = "public, max-age=60";

// public/_headers covers static assets only; on-demand pages set the same security headers themselves.
const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
function pageHeaders(Astro: AstroGlobal) {
  Astro.response.headers.set("Cache-Control", PAGE_CACHE);
  for (const [k, v] of Object.entries(SECURITY)) Astro.response.headers.set(k, v);
}

/** The site's own 404 page (a static asset) with a 404 status. */
export async function notFound(Astro: AstroGlobal): Promise<Response> {
  const assets = (Astro.locals.runtime?.env as unknown as { ASSETS?: { fetch: (u: string) => Promise<Response> } } | undefined)?.ASSETS;
  const page = await assets?.fetch(new URL("/404.html", Astro.url).href).catch(() => null);
  return new Response(page?.ok ? page.body : "Not found", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Link to a part's product page: the built page when it exists, else the on-demand one. Active products only. */
export async function partHref(locale: Locale, p: BundlePart): Promise<string | null> {
  if (p.productStatus !== "active") return null;
  if (await getProduct(p.productId)) return productPath(locale, p.productId);
  return `${route("shop", locale)}p/${p.productId}/`;
}

/** "Brand Name EDT" (or the owner's label when the product is not in the catalog). */
export const partName = (p: BundlePart) =>
  p.name ? [p.brand, p.name, p.concentration].filter(Boolean).join(" ") : (p.label ?? p.productId);

export const bundleName = (b: Pick<BundleView, "nameMn" | "nameEn">, locale: Locale) => (locale === "en" ? b.nameEn : null) ?? b.nameMn;
export const bundleDescription = (b: Pick<BundleView, "descriptionMn" | "descriptionEn">, locale: Locale) =>
  (locale === "en" ? b.descriptionEn : b.descriptionMn) ?? b.descriptionMn ?? b.descriptionEn ?? "";

export async function loadBundleList(Astro: AstroGlobal): Promise<BundleView[] | Response> {
  const env = Astro.locals.runtime?.env;
  if (!env?.DB) return new Response(null, { status: 503 });
  pageHeaders(Astro);
  try {
    const settings = await getSettings(env.DB);
    return await listBundles(env.DB, { status: "active", checkoutOpen: settings["checkout.open"] === true });
  } catch (e) {
    // A database problem shows an empty list (the site header and footer still render) instead of an error page.
    console.error("loadBundleList failed", e);
    return [];
  }
}

export async function loadBundlePage(Astro: AstroGlobal): Promise<BundleView | Response> {
  const id = String(Astro.params.id ?? "");
  if (!BUNDLE_ID_RE.test(id)) return notFound(Astro);
  const env = Astro.locals.runtime?.env;
  if (!env?.DB) return new Response(null, { status: 503 });
  let bundle: BundleView | null;
  try {
    const settings = await getSettings(env.DB);
    bundle = await getBundle(env.DB, id, settings["checkout.open"] === true);
  } catch (e) {
    console.error("loadBundlePage failed", id, e);
    return notFound(Astro);
  }
  if (!bundle || bundle.status !== "active") return notFound(Astro);
  pageHeaders(Astro);
  return bundle;
}
