# Plan: genzst logo → SVG → web

Executor: Fable. Work only inside `C:\Users\mtemu\Dev\trying things\genzst`. Don't build any other part of the site in this task.

## Inputs (already in the repo)
| File | What it is |
|---|---|
| `assets/brand/genzst-logo-source.png` | The only source: a 251×250 RGB PNG. Gold mark on a near-black background. |
| `assets/reference/NOTES.md` | Design direction: dark-first, a single gold accent, hairline rules. |

Measured from the source:
- **Background:** `#070707`
- **Gold:** `#CC9E48` (flat, with no gradient)
- **Mark bounding box:** x 73–182, y 42–197. The mark is only about 110×155 px, so a direct auto-trace will come out lumpy. Use tracing as a guide only and rebuild the paths cleanly by hand.

Anatomy of the mark, top to bottom:
1. **Cap:** a rounded rectangle, wider than the neck.
2. **Neck:** a short rectangle with a thin collar line.
3. **Bottle body:** the outline is a thick stroke. It forms a square-shouldered bottle that is open on the left and continues down into the bowl of the letter.
4. **"G":** a high-contrast serif G. Its right side and the spur/bar on the lower right form the bottom right of the bottle.
5. **Flame/leaf:** two or three tapered swooshes curving up inside the G's bowl, like hair or a wisp of scent.

## Deliverables
All files go in `assets/brand/`:

| File | Purpose |
|---|---|
| `genzst-mark.svg` | The mark only, gold `#CC9E48`, transparent background, tight viewBox. This is the master file. |
| `genzst-mark-mono.svg` | The same paths using `fill="currentColor"`, so CSS can color it. |
| `genzst-lockup.svg` | The mark plus the wordmark "GENZST" (horizontal and stacked variants are fine as `-h` / `-v`). See step 4. |
| `favicon.svg` | A simplified mark that stays legible at 16px. Drop the thinnest flame strands if needed. |
| `favicon-32.png`, `apple-touch-icon.png` (180), `icon-512.png` | Rasterized from the SVGs, not from the source PNG, with transparent backgrounds. |

> **No background, anywhere.** Every SVG and PNG has a transparent background: no `<rect>` fill, no black square, no alpha matte. The `#070707` from the source PNG is only the photo's backdrop and is **not** part of the logo. When tracing, drop the black completely and keep only the gold.
| `README.md` | The color tokens, which file to use where, a minimum size, and the clear-space rule (the cap height on every side). |
| `preview.html` | Every variant on dark and light backgrounds, at 16, 32, 64, 256 and 512 px, with an overlay toggle that compares against the source PNG. |

## Steps

### 1. Trace a guide (throwaway)
- Upscale the source 8× with a Lanczos filter, threshold it at luminance ~60, and auto-trace it with `potrace` (`npx potrace` or the `potrace` npm package; Python `pypotrace` / `vtracer` also work).
- Save the result to the scratch folder `assets/brand/_work/` and **don't ship it**. Its only use is as an outline to snap to.

### 2. Rebuild clean geometry
Write the master `genzst-mark.svg` by hand on a 0–1000 grid:
- Cap and neck are `<rect rx=…>` primitives.
- The bottle outline is a single path. Use a stroke while designing, then convert it to filled outlines so there are no strokes in the final file.
- For the G, start from a real high-contrast serif G: outline a G from Cormorant Garamond Bold (OFL licensed) with `opentype.js`. Then adjust its weight and terminals to match the source, and merge it with the bottle path. This gives true serif contrast instead of traced lumps.
- Draw the flame as 2–3 cubic Bézier shapes with tapered ends.
- Run a boolean union on the overlapping shapes (`paper.js` or `svgpathtools`) so it becomes a single compound path with no overlaps.

**Acceptance check:** render the SVG at 251×250 with the same framing, then diff it against the source. More than 92% of the mark pixels should match (IoU). Adjust until it passes, and log the score in `_work/fit.txt`.

### 3. Optimize
- Run `npx svgo --multipass` on each SVG.
- Keep `viewBox`, `role="img"`, and `<title>genzst</title>`.
- Use no `<image>`, no embedded raster, and no fonts (text is converted to outlines).
- Limit path coordinates to 1 decimal place.
- Target size: under 4 KB for the mark.

### 4. Wordmark
- Set "GENZST" in Cormorant Garamond 500 in uppercase, with letter-spacing of 0.18em. This matches the head font from the type system.
- Convert the text to outlines with `opentype.js` so the logo doesn't depend on a web font.
- The wordmark's cap height should equal the height of the bottle cap and neck combined.
- In the horizontal lockup, the gap between mark and wordmark should be 0.5× the mark width.

### 5. Rasters
Render the PNGs from the SVGs using `sharp` or `resvg-js`. Check the 16px and 32px favicons by eye, and simplify `favicon.svg` if the G stops being readable.

### 6. Web integration
There is no site scaffold yet. Ship a minimal, framework-agnostic setup that the future site can reuse:
- `web/partials/head-brand.html`, containing:
  ```html
  <link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/brand/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
  <meta name="theme-color" content="#070707">
  ```
- `web/styles/brand.css`:
  ```css
  :root {
    --brand-gold: #CC9E48;
    --brand-ink: #070707;
  }
  .brand-mark {
    color: var(--brand-gold);
    width: 40px;
    height: auto;
  }
  ```
- The header uses an inline `<svg>` built from `genzst-mark-mono.svg` (`fill="currentColor"`), so it can switch to gold on hover or become a light version later.
- Link `preview.html` to `brand.css` so it shows the real usage.

### 7. Verify
Open `assets/brand/preview.html` in the browser pane and check:
- the overlay matches the source
- there's no jagged edge at 512px
- the favicon reads at 16px
- the mark is visible on both dark and light backgrounds
- every file has a transparent background (check the PNG alpha channel, and check that no SVG has a background `<rect>`)

Take a screenshot and save it as `assets/brand/_work/preview.png`.

## Out of scope / notes
- **`decantx/products*.json`** (5,824 products, mostly "Fragrance Decant") is scraped from a competitor. It's fine for planning catalog structure, categories and pricing. Don't publish its descriptions or the `cdn.shopify.com` images on genzst: write your own copy and use your own photography. That belongs to the next task, not this one.
- Don't change the source PNG or anything under `assets/reference/`.
