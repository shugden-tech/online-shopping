# R2 and D1 connection

R2 already holds the public facts-only master catalog and photos in `genzst-images`.
`src/data/backend.json` records its public origin. The storefront uses the validated
snapshot in `data/catalog/catalog.json` to select photos by exact catalog ID.
Unknown legacy identities keep their original photos; concentrations are never
substituted. Existing routes, prices and stock remain separate from catalog facts.

The snapshot contains 1,000 records, while the current storefront has 207 legacy
products with 84 exact ID matches. The remaining catalog entries are imported as
drafts in D1. They do not automatically gain storefront pages or become sellable.

## Connect a separate preview database

From the project folder, with Wrangler authenticated:

```powershell
node node_modules/wrangler/bin/wrangler.js d1 create genzst-preview
npm.cmd run backend:configure -- --database-id REAL_UUID --database-name genzst-preview
node node_modules/wrangler/bin/wrangler.js d1 migrations apply genzst-preview --remote
node scripts/import-catalog.mjs --apply remote --db genzst-preview
```

The importer inserts missing rows only. Re-running does not overwrite owner prices,
stock or orders. SKU prices start at NULL. Do not apply demo-price SQL remotely.
The database name in Wrangler/npm migration commands must match the selected DB.

For an existing preview database, skip creation and use its actual name and ID.
Do not point this workflow at production without reviewing its migration state.
`backend:configure` changes local configuration only and does not contact Cloudflare.

For local D1 instead:

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply genzst-preview --local
node scripts/import-catalog.mjs --apply local --db genzst-preview
npm.cmd run build
npm.cmd run preview -- --port 8788
```

The project uses Node directly for Wrangler from its importer so this works in
Windows PowerShell without executing `npx.ps1` or spawning `npx` as an executable.
An unavailable/crashing Workers runtime must be resolved before local D1 can run.

## Check the actual connection

`npm.cmd run backend:check` validates the snapshot and local R2/D1 configuration.
`GET /api/health` checks that the running Worker can read the migrated D1 tables
and find `catalog.json` in its bound R2 bucket. It returns 503 until both work.
The static admin UI preview is separate and does not connect to a real database.

After provisioning a preview Worker, set its own admin/Turnstile secrets before
testing real API flows. Local `.dev.vars` values are never production credentials.
QPay and delivery require their provider credentials and configuration separately.

The snapshot is refreshed explicitly with `node scripts/import-catalog.mjs --fetch`.
Downloads have a timeout and must validate before replacing the last good snapshot.
Builds use that snapshot; commerce prices/stock still come from D1 at runtime.
