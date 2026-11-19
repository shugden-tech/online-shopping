// Loader for the on-demand product page (/delguur/p/{id}, /en/shop/p/{id}; 0004). Server-only.
// - a product that is in the built catalog redirects (301) to its static page
// - a product that is not active (draft / hidden) or unknown answers 404
// - otherwise the page is rendered from D1 and cached at the edge for 60 s
import type { AstroGlobal } from "astro";
import { getAdminProduct } from "./catalog/products";
import { PRODUCT_ID_RE, type AdminProduct } from "./contracts";
import { productPath } from "../i18n";
import { getProduct } from "./products";

/** The site's own 404 page (a static asset) with a 404 status. */
async function notFound(Astro: AstroGlobal): Promise<Response> {
  const assets = (Astro.locals.runtime?.env as unknown as { ASSETS?: { fetch: (u: string) => Promise<Response> } } | undefined)?.ASSETS;
  const page = await assets?.fetch(new URL("/404.html", Astro.url).href).catch(() => null);
  return new Response(page?.ok ? page.body : "Not found", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function liveProduct(Astro: AstroGlobal, locale: "mn" | "en"): Promise<AdminProduct | Response> {
  const id = String(Astro.params.id ?? "");
  if (!PRODUCT_ID_RE.test(id)) return notFound(Astro);
  if (await getProduct(id)) return Astro.redirect(productPath(locale, id), 301);
  const env = Astro.locals.runtime?.env;
  if (!env?.DB) return new Response(null, { status: 503 });
  const product = await getAdminProduct(env.DB, id);
  if (!product || product.status !== "active") return notFound(Astro);
  Astro.response.headers.set("Cache-Control", "public, max-age=60");
  return product;
}
