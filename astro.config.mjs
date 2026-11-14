// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import { alternatesFor } from "./src/i18n/routes.mjs";

// [[TODO owner]] set the real production domain here.
const SITE = "https://genzst.mn";

export default defineConfig({
  site: SITE,
  output: "static",
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  adapter: cloudflare({
    platformProxy: { enabled: true },
    imageService: "compile",
  }),
  i18n: {
    defaultLocale: "mn",
    locales: ["mn", "en"],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    preact(),
    sitemap({
      filter: (page) => !/\/(zahialga|en\/checkout)\//.test(page) && !page.includes("/404"),
      serialize(item) {
        const alt = alternatesFor(new URL(item.url).pathname);
        if (alt) {
          item.links = [
            { lang: "mn", url: SITE + alt.mn },
            { lang: "en", url: SITE + alt.en },
            { lang: "x-default", url: SITE + alt.mn },
          ];
        }
        return item;
      },
    }),
  ],
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  build: { inlineStylesheets: "auto" },
  vite: {
    build: { cssMinify: true },
  },
});
