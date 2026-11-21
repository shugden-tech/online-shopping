# Upload selected images without local image files

The migration Worker fetches source image bytes on Cloudflare, stores them in
R2 and verifies the public R2 response against a SHA-256 hash. The local script
only sends image names and receives JSON results. It never downloads image
bytes or writes image files.

Object names are `<product-id>_front.<actual-extension>` and
`<product-id>_back.<actual-extension>`, for example
`dior-sauvage-edp_front.jpg`. Original raster formats are retained; PNG/WebP
bytes are never mislabeled as JPEG. Each source image is limited to 10 MB.

## Setup after signing in and enabling R2

1. `node scripts/upload-catalog-images.mjs --prepare`
2. Create/select the bucket named in `workers/image-importer/wrangler.jsonc`.
3. Configure the bucket's public domain and put the real HTTPS base URL in
   that config's `PUBLIC_IMAGE_BASE_URL`. Production should use a custom domain.
4. Deploy the dedicated importer:
   `npx wrangler deploy --config workers/image-importer/wrangler.jsonc`
5. Set its authentication token without printing it:
   `node scripts/upload-catalog-images.mjs --set-token`
6. Test one image using the actual Worker and public bucket URLs:

```powershell
node scripts/upload-catalog-images.mjs --write --worker-url https://YOUR-WORKER.workers.dev --base-url https://YOUR-PUBLIC-IMAGE-HOST --limit 1
```

Remove `--limit 1` to continue through all available front/back images. An
absent source remains null; an HTTP failure does not generate a fake R2 URL.
The uploader runs four requests concurrently by default (use `--concurrency 1`
through `4`). JSON checkpoints are serialized and transient Windows file locks
are retried before the run stops to preserve progress.

The Worker only accepts images embedded in the prepared manifest, requires a
secret bearer token and refuses to overwrite an existing named object from a
different source. Errors such as an HTML access-denied page are not stored as
photos. A repeated run reuses already verified objects.

## Results and resuming

- `decantx/catalog.json`: public export containing only verified R2 image URLs
  or null. Build it after migration with `node scripts/export-r2-catalog.mjs`,
  then upload this JSON file to the bucket as `catalog.json`.
- `decantx/r2-upload-report.json`: export totals and missing image slots.
- `decantx/selected-1000.json`: each successfully verified image URL is replaced
  immediately with its R2 URL. Failed source URLs remain here for retries.
  Other product fields are preserved. Use `catalog.json` as the public file.
- `decantx/catalog-r2-images.json`: internal verification map. Catalog rebuilds
  use this map, so they preserve uploaded image URLs. This is not a public
  catalog and does not need to be uploaded.
- `output/r2-image-upload/`: catalog backups, the private migration token and
  the latest failure report. This entire directory is excluded from Git.

Both local JSON files are checkpointed after each success. If the process is
interrupted between those writes, rerunning restores mapped URLs and resumes.
Normal image viewing uses the public R2 URLs directly and does not call the
importer. These source photos were selected from the existing catalog; migration
does not establish that every photo depicts the correct perfume/concentration.

## Verification

`node --test workers/image-importer/core.test.mjs` covers authenticated access,
remote copy/public verification, resuming, actual-format naming, rejecting HTML
and avoiding overwrites of a different source.

`npx wrangler deploy --dry-run --config workers/image-importer/wrangler.jsonc --outdir output/image-importer-build`
checks that the Worker and manifest bundle correctly without deployment.

## Reviewed bottle-and-box replacements

`decantx/back-photo-overrides.json` holds visually approved source photos for
the 50 previously missing back slots. `scripts/review-boxed-photos.py` renders
contact sheets in memory for inspection; no downloaded photo files are saved.
The review checks the named fragrance, edition, visible bottle and matching box.
Unboxed images, placeholder graphics and wrong editions are rejected. Review
metadata stays in `output/back-photo-research/`, outside the public catalog.

Preparing the manifest incorporates approved replacement URLs and SHA-256
hashes. The Worker refuses to store bytes differing from the reviewed file.
Catalog rebuilds apply these replacements before resolving the verified R2 map.

For a reviewed public source that rejects Cloudflare egress, the exceptional
`node scripts/relay-reviewed-photo.mjs IMAGE_NAME_back` command verifies the
approved SHA-256, pipes the JPEG directly from RAM to Wrangler/R2, verifies its
public response and updates the mapping. It creates no image file on disk.
This fallback was used for the official Dior Sauvage Extrait boxed photo.
