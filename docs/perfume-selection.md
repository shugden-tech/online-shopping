# 1,000 perfume shortlist

`python scripts/select-popular-perfumes.py` rebuilds the selection without
changing `decantx/merged.json`, the shop's product files, or Cloudflare.

## Files

- `decantx/selected-1000.json`: exactly 1,000 selected products in the strict
  public catalog schema. No pricing, decant variants or source/research links.
  Missing values are explicit; this is a cleaned draft pending content research
  and image review/migration, not a completely verified production catalog.
- `decantx/catalog-cleanup-report.json`: missing fields and cleanup decisions,
  kept separate from the public catalog.
- `decantx/catalog-field-overrides.json`: individually researched full bottle
  sizes. These override only the exact selected source name.
- `decantx/selected-1000-list.md`: readable list of selected names.
- `decantx/selected-1000-audit.json`: per-product evidence, vote counts,
  selection score, original index, source URLs, source hashes and limitations.
- `decantx/selection-excluded.json`: excluded candidates and reasons.
- `decantx/selection-ambiguous.json`: source identity conflicts rejected during
  matching. An entry here can still be selected using a different clear source.
- `decantx/popularity-parfumo-20261116.json`: 1,500 ranking rows captured from
  the current Parfumo community Top 500 pages for Men, Women and Unisex.

## Meaning of popular

There is no verified global sales Top 1,000 in the available data. This shortlist
uses the number of community ratings as a proxy for how widely known a perfume
is. A high average rating alone does not qualify a perfume. The candidate pool
is the 4,062 merged records and 21 supplementary identities from the previously
curated catalog (including Chanel, Louis Vuitton and Lattafa). It is not a
complete census of every fragrance worldwide.

Sources are the cached Fragrantica/FragRec CSV, cached Parfumo CSV, and current
Parfumo category pages checked on 2026-11-16. The CSV capture dates are unknown;
their counts are historical. Current category rankings represent that community,
not verified worldwide sales. Independently fetched pages can shift slightly.

The score is the maximum of `log(1 + votes) / log(1 + platform_max_votes)` across
compatible sources. The historical and current Parfumo counts share a denominator.
We do not sum overlapping communities. Price, brand prestige, inventory, note
completeness and photo availability do not increase the score. No gender quota
is imposed. EDT, EDP, Parfum and Extrait are separate products when supported.

Matching uses normalized house and product names, compatible concentrations,
explicit genders and release years. Distinct flankers (Intense, Elixir, Sport,
Absolu, etc.) are preserved. Unlabelled source concentrations are rejected when
the catalog has multiple possible concentrations. Multiple conflicting snapshot
product IDs are rejected. Duplicate catalog identities or identical matched
snapshot product IDs are counted once. No fuzzy match silently assigns evidence.

## Public schema and rebuilding

The public catalog contains only ID, brand, product name, concentration,
full bottle sizes in ml, release year, top/heart/base notes and front/back image
URLs. Prices, decant sizes, inventory, orders and source links are excluded.

`python scripts/build_cloudflare_catalog.py` rebuilds the cleaned catalog from
the existing selection audit and original records without changing which 1,000
identities were chosen. The selection script also calls this normalization,
so rerunning selection cannot reintroduce decant variants or commercial fields.

`bottle_sizes_ml: null` means factory bottle sizes have not been confirmed.
Only explicitly typed `full_bottle` variants and reviewed overrides qualify;
the script never promotes decant sizes, price options or arbitrary image URL
numbers to factory bottle sizes. Manufacturer minis, travel sprays, refill
containers and gift-set components are excluded from the reviewed main-bottle
size lists. Arrays contain confirmed sizes, not a guarantee of every historical
or regional presentation.

Notes prefer the exact source product IDs already accepted by the selection
audit. `middle` becomes `heart`. Flat note lists are not split into invented
tiers. Invalid prose fragments are removed. Conflicting release years remain
null. Audit/research files stay local and are not part of the public upload.

Image identity and HTTP availability still need review. Missing values must
remain missing until sourced. Original image links are retained until the R2
migration; catalog normalization preserves verified mappings from
`decantx/catalog-r2-images.json` and does not upload or invent storage URLs.
See [R2 image upload](r2-image-upload.md) for the remote migration workflow.
