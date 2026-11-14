# Products

Each perfume is **one JSON file** in this folder. The file name is the product's URL slug:
`baccarat-rouge-540.json` becomes `/delguur/baccarat-rouge-540/` (and `/en/shop/baccarat-rouge-540/`).

> The 24 files here are **sample data** (real perfume names, placeholder prices and our own
> descriptions). Replace them with the real catalog before launch.

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
| `notes.top / heart / base` | Lists of note ids from `src/data/notes.json`. To use a new note, add it there first (`"id": { "mn": "…", "en": "…" }`; add `"image": "woods"` to group it under one of the 11 note photos). |
| `description.mn / .en` | 1–3 sentences **in your own words**, in both languages. |
| `sizes` | One entry per size: `{ "ml": 2, "price": 15000, "inStock": true }`. Allowed sizes: 2, 5, 10, 30. Price is in ₮ (whole number). Set `inStock` to `false` to show the size struck through. |
| `bottleShape` | `classic`, `tall`, `round` or `square` — the silhouette of the illustrated bottle. |
| `image` *(optional)* | A real photo, e.g. `"./photos/baccarat-rouge-540.jpg"` (path relative to this folder; create `photos/`). When set, the photo replaces the illustrated bottle. Use a portrait image on a dark background, at least 800 px wide. |
| `featured` *(optional)* | `true` puts it in the home-page slider and first in the shop. |
| `isNew` *(optional)* | `true` shows the “New” flag and puts it in “New arrivals”. |
| `intensity` | 1 (very soft) to 5 (very strong). Used by filters and the Scent Finder. |
| `season` | Any of `spring`, `summer`, `autumn`, `winter`. |
| `occasion` | Any of `day`, `night`, `office`, `date`. |

Prices are always re-read from these files on the server when an order is placed, so the
price a customer pays is the price written here at the time of the last deploy.
