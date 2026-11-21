# Products

Each perfume is **one JSON file** in this folder. The file name is the product's URL slug:
`baccarat-rouge-540.json` becomes `/delguur/baccarat-rouge-540/` (and `/en/shop/baccarat-rouge-540/`).

> The 100 files here were generated from `decantx/merged.json` by
> `node scripts/import-merged-products.mjs --write` (the first 100 perfumes with a front photo that
> could be mapped). Re-running it **deletes and rewrites every product file**, so hand edits are lost.
> Prices are converted from USD with `USD_TO_MNT` in that script.

## Add or edit a product

1. Copy an existing file and rename it (lowercase letters, digits and dashes only).
2. Edit the fields below. `slug` must be exactly the file name without `.json`.
3. Run `npm run build`. If anything is wrong (unknown note, missing field, bad price) the
   build stops and tells you which file and which field, so a broken product never reaches the site.

| Field | Meaning |
|---|---|
| `slug` | Same as the file name. |
| `brand`, `name` | As printed on the bottle. |
| `concentration` | `EDT`, `EDP`, `Parfum`, `Extrait` or `Cologne`. |
| `gender` | `women`, `men` or `unisex`. |
| `family` | `amber`, `woody`, `floral`, `citrus`, `chypre`, `fresh`, `gourmand` or `aromatic`. Sets the liquid colour of the bottle art. |
| `notes.top / heart / base` | Lists of note ids (a tier may be empty; empty tiers and an empty pyramid are hidden) from `src/data/notes.json`. To use a new note, add it there first (`"id": { "mn": "…", "en": "…" }`; add `"image": "woods"` to group it under one of the 11 note photos). |
| `description.mn / .en` | 1–3 sentences **in your own words**, in both languages. |
| `sizes` | One entry per size: `{ "ml": 2, "price": 15000, "inStock": true }`. Allowed sizes: 2, 5, 10, 30. Price is in ₮ (whole number). Set `inStock` to `false` to show the size struck through. |
| `bottleShape` | `classic`, `tall`, `round` or `square` — the silhouette of the illustrated bottle. |
| `image` *(optional)* | A real photo, e.g. `"./photos/baccarat-rouge-540.jpg"` (path relative to this folder; create `photos/`). When set, the photo replaces the illustrated bottle. Use a portrait image on a dark background, at least 800 px wide. |
| `photos` *(optional)* | Remote photos: `{ "front": "https://…", "back": "https://…" }`. `front` is the bottle, `back` the bottle with its box; either may be left out. Cards show the front and fade to the back on hover/focus; the product page shows front then back. Filled by the import script. Ignored when `image` is set. |
| `featured` *(optional)* | `true` puts it in the home-page slider and first in the shop. |
| `isNew` *(optional)* | `true` shows the “New” flag and puts it in “New arrivals”. |
| `intensity` | 1 (very soft) to 5 (very strong). Used by filters and the Scent Finder. |
| `season` | Any of `spring`, `summer`, `autumn`, `winter`. |
| `occasion` | Any of `day`, `night`, `office`, `date`. |

Prices are always re-read from these files on the server when an order is placed, so the
price a customer pays is the price written here at the time of the last deploy.

## Full bottle

To sell the full retail bottle, add it to `sizes` with `"full": true` (15–500 ml, one per product):

```json
{ "ml": 100, "price": 250000, "inStock": true, "full": true }
```

The product card's main **Add to cart** button then adds the full bottle, and the decants (5 / 10 ml) move into
the small square picker next to it. Without a full bottle the main button adds the smallest decant in stock.

## Curated catalog and demo inventory (2026-11-15)

The catalog now contains 207 products: the previous 100 plus 107 new entries from the reviewed 108-product selection (one was already present). All 28 home-page logo searches have matching products. The additive importer is `scripts/import-curated-catalog.mjs`; its source and photo audit reports are in `decantx/curated-*-report.json` and `decantx/curated-catalog-sources.json`. Local product photos are served from `public/product-photos/`.

`scripts/set-demo-inventory.mjs` sets deterministic demo quantities in each size's optional `stock` field. Currently 190 products are available with 1–5 units per size, and 17 are sold out with `stock: 0`. `inStock` must agree with `stock > 0`. Cart quantities and order validation respect this limit. These quantities are static demo data; orders do not decrement them.

Missing prices received demo placeholders: 2 ml 20,000 MNT, 5 ml 45,000 MNT, 10 ml 80,000 MNT, 30 ml 200,000 MNT. Existing positive reference prices were retained. None of these establish real business prices or availability. The pre-change catalog backup and all counts are recorded in `decantx/demo-inventory-report.json`.

Flat published fragrance-note lists use the optional `notes.key` field and appear as “Fragrance notes”, without inventing a top/heart/base assignment. New note labels have Mongolian translations; photos for individual notes remain a separate task.
