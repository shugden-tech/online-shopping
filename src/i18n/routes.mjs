// Route table shared by pages, the language toggle, hreflang tags and the sitemap.
// Plain .mjs so astro.config.mjs can import it too.

/** @typedef {"mn" | "en"} Locale */
/** @typedef {"home"|"shop"|"finder"|"checkout"|"success"|"about"|"help"} RouteKey */

/** @type {Record<RouteKey, Record<Locale, string>>} */
export const ROUTES = {
  home: { mn: "/", en: "/en/" },
  shop: { mn: "/delguur/", en: "/en/shop/" },
  finder: { mn: "/unertei-tanilts/", en: "/en/scent-finder/" },
  checkout: { mn: "/zahialga/", en: "/en/checkout/" },
  success: { mn: "/zahialga/amjilttai/", en: "/en/checkout/success/" },
  about: { mn: "/bidnii-tuhai/", en: "/en/about/" },
  help: { mn: "/tuslamj/", en: "/en/help/" },
};

/** @param {RouteKey} key @param {Locale} locale */
export function route(key, locale) {
  return ROUTES[key][locale];
}

/** @param {Locale} locale @param {string} slug */
export function productPath(locale, slug) {
  return `${ROUTES.shop[locale]}${slug}/`;
}

/**
 * Both language versions of a pathname, or null when the page has no twin.
 * @param {string} pathname
 * @returns {Record<Locale, string> | null}
 */
export function alternatesFor(pathname) {
  const p = pathname.endsWith("/") ? pathname : pathname + "/";
  for (const key of /** @type {RouteKey[]} */ (Object.keys(ROUTES))) {
    const r = ROUTES[key];
    if (r.mn === p || r.en === p) return { ...r };
  }
  for (const loc of /** @type {Locale[]} */ (["en", "mn"])) {
    const base = ROUTES.shop[loc];
    if (p.startsWith(base) && p.length > base.length) {
      const slug = p.slice(base.length).replace(/\/$/, "");
      if (!slug.includes("/")) return { mn: productPath("mn", slug), en: productPath("en", slug) };
    }
  }
  return null;
}
