// The eight bundle pictures in public/bundles/1..8.webp. Each bundle holds three decants of 10 ml,
// so every bundle is 30 ml in total. Order matches the picture files.
const IMG = (n: number) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/bundles/${n}.webp`;

export const BUNDLE_PRICE = 99000;
export const BUNDLE_ML = 30;
export const BUNDLE_PART_ML = 10;

// Exact product identities; concentrations must never be substituted for one another.
export const BUNDLE_PRODUCT_SLUGS: Record<string, string> = {
  "Montblanc Legend EDT": "montblanc-legend-edt",
  "Emporio Armani Stronger With You Intensely EDP": "emporio-armani-stronger-with-you-intensely-edp",
  "Versace Pour Homme EDT": "versace-pour-homme-edt",
  "Jean Paul Gaultier Le Male EDT": "jean-paul-gaultier-le-male-edt",
  "Terre d'Hermès EDT": "hermes-terre-dhermes-edt",
  "Versace Eros EDT": "versace-eros-edt",
  "Dolce & Gabbana Light Blue Pour Homme EDT": "dolce-and-gabbana-light-blue-pour-homme-edt",
  "Maison Margiela Replica Sailing Day EDT": "maison-margiela-replica-sailing-day-edt",
  "Valentino Uomo Born In Roma EDT": "valentino-uomo-born-in-roma-edt",
  "Versace Eros Parfum": "versace-eros-parfum",
  "Azzaro The Most Wanted Parfum": "azzaro-the-most-wanted-parfum",
  "Dolce & Gabbana Pour Homme EDT": "dolce-and-gabbana-pour-homme-edt",
  "Rabanne Invictus EDT": "rabanne-invictus-edt",
  "Yves Saint Laurent Y EDP": "yves-saint-laurent-y-edp",
  "Moncler Pour Homme EDP": "moncler-pour-homme-edp",
  "Versace Eros EDP": "versace-eros-edp",
  "Jean Paul Gaultier Le Male Elixir Parfum": "jean-paul-gaultier-le-male-elixir-parfum",
};

export const BUNDLES = [
  { image: IMG(1), parts: ["Montblanc Legend EDT", "Emporio Armani Stronger With You Intensely EDP", "Versace Pour Homme EDT"] },
  { image: IMG(2), parts: ["Jean Paul Gaultier Le Male EDT", "Terre d'Hermès EDT", "Versace Eros EDT"] },
  { image: IMG(3), parts: ["Versace Pour Homme EDT", "Dolce & Gabbana Light Blue Pour Homme EDT", "Maison Margiela Replica Sailing Day EDT"] },
  { image: IMG(4), parts: ["Montblanc Legend EDT", "Valentino Uomo Born In Roma EDT", "Jean Paul Gaultier Le Male EDT"] },
  { image: IMG(5), parts: ["Versace Eros Parfum", "Azzaro The Most Wanted Parfum", "Terre d'Hermès EDT"] },
  { image: IMG(6), parts: ["Dolce & Gabbana Pour Homme EDT", "Rabanne Invictus EDT", "Emporio Armani Stronger With You Intensely EDP"] },
  { image: IMG(7), parts: ["Montblanc Legend EDT", "Yves Saint Laurent Y EDP", "Moncler Pour Homme EDP"] },
  { image: IMG(8), parts: ["Versace Eros EDP", "Jean Paul Gaultier Le Male Elixir Parfum", "Dolce & Gabbana Pour Homme EDT"] },
];
