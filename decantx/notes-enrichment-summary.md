# Perfume note enrichment

Updated `merged.json` using the original backup as the source of truth. The backup is `merged.backup-20261115-003000.json` (SHA-256 `0c6fbbcc7b648479209d08e927f61ab41e8ec2d435028c0e3c53355c87b44ae1`).

## Results

- 4,062 products; every product now has at least one note.
- 3,648 products have top, middle, and base notes.
- 407 have sourced flat note lists, stored in `key` rather than guessed into a pyramid.
- 7 have a partial pyramid. Their unlisted tiers remain empty when a reliable source did not assign notes to those tiers.
- `key` is populated for all 4,062 products.
- 4,057 products had a notes or notes source-text change. All non-note fields, product order, and names were verified unchanged from the backup.

## Method and audit

The enrichment uses exact product and brand matches across public fragrance datasets, DecantX product descriptions, and individually researched product or manufacturer pages. Ambiguous product variants are not automatically matched. Known incorrect product descriptions were replaced only where a better product-specific source was found. Notes are not assigned to top, middle, or base based on guesswork. Flat published lists stay in `key`.

Every recorded modification and its available source links are in `notes-enrichment-report.json`. Supporting matched records, curated corrections, and supplementary research are in `notes-matched-sources.json`, `notes-researched-overrides.json`, and `notes-additional-research.json`. Source response cache is in `notes-source-cache/`.

Public datasets used include:

- Parfumo data from [fragrance-analysis](https://github.com/JennyIseev/fragrance-analysis) (dataset attribution states CC0).
- [Scento perfume dataset](https://github.com/Scento-com/perfume-dataset) (CC BY 4.0; attribution to Scento, https://www.scento.com/perfume-database).
- [FragRec fragrance dataset](https://github.com/prthm-rt/FragRec), a public Fragrantica-derived snapshot; refer to its repository for origin and terms.

## Validation

Run `python scripts/validate-enriched-data.py` to check product count/order, the backup hash, unchanged non-note fields, valid note arrays, no products without notes, and selected source corrections. The last run passed. Output `merged.json` SHA-256: `6246acd1db8e91648b82c776ff7464a25082c5ea3b66aa9fb5d9fbb4204c70d7`.
