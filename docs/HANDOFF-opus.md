# Handoff: genzst website → Opus

The previous builder (Fable 5.2) stopped on a usage limit. **Opus now owns the build.** This guide covers three things:
- what already exists, so you don't redo it
- the open issues, each with a diagnosis hint
- the improvements to make next

Read this first, then `PROGRESS.md` (phases 1–6 in detail) and `VERIFY.md` (the final verification run and its failures). `PLAN-website.md` is still the spec, and its decisions are fixed unless this guide says otherwise.

Working directory: `C:\Users\mtemu\Dev\trying things\genzst`. It's Windows with Git Bash, Node 24 and npm 11. It is **not** a git repo, so don't run `git init`.

---

## 1. State: what's done

| Phase (PLAN §8) | Status |
|---|---|
| 1 Scaffold: Astro 5.18, Preact, Cloudflare adapter, fonts, i18n, shell | ✅ gate passed |
| 2 Data: zod schema, 24 seed products, notes, settings, BottleArt | ✅ gate passed |
| 3 Shop and product pages | ✅ gate passed (`scripts/e2e-shop.mjs`) |
| 4 Cart | ✅ gate passed |
| 5 Home: hero, families, Layering Slider, notes, explainer, rail | ✅ gate passed (`scripts/e2e-home.mjs`) |
| 6 Scent Finder | ✅ gate passed (`scripts/e2e-finder.mjs`). Two visual fixes are still queued; see 3.9. |
| 7 Checkout and API | Built (`CheckoutForm.tsx`, `api/orders.ts`, D1, Turnstile, rate limit). `e2e-checkout` has **1 failure**. **No PROGRESS.md entry yet.** |
| 8 Simple pages, SEO, 404 | Built. The link check passes (63 pages, 0 problems). **No PROGRESS.md entry yet.** |
| 9 Polish and verify | The verification ran (`VERIFY.md`). It has **open failures** and its "Reason / fix" fields are blank. |

**Lighthouse** (mobile, production): home 98/100/100/100, shop 99/95/100/100, product 100/97/100/100. CLS is 0 on all three.

**Useful scripts** (`scripts/`): `e2e-shop|home|finder|checkout|keyboard.mjs` (set `BASE=http://localhost:8788`), `shot.mjs` (screenshots), `js-budget.mjs`, `check-links.mjs`, `lh-summary.mjs`, `make-icons.mjs`, `build-fonts.py`.

**Run it like production:** `npm run build`, then `npx wrangler dev --port 8788`. Before placing orders, run `npx wrangler d1 migrations apply genzst --local` once.

**Deliberate deviations already made** (keep them; the reasons are in PROGRESS.md):
- **Fonts:** merged into one subset file per face, because Mongolian needs basic Cyrillic and ₮.
- **Signals:** `@preact/signals-core` plus a `useSig` hook.
- **Cart drawer:** loaded on first intent.
- **Product page motion:** uses CSS and IntersectionObserver instead of GSAP.
- **Logo:** the PNG backdrop was keyed to transparent by `make-icons.mjs`.

---

## 2. Rules (unchanged)
- Don't read or use `decantx/`, which is copyrighted third-party data. Don't modify `assets/`, `animation1.md` or `PLAN-*.md`.
- Don't deploy, don't log in to Cloudflare, and don't create remote resources. Use `npx wrangler` locally only.
- Verify every fix in a real browser: Edge through playwright-core, or the built-in browser pane. A fix that only compiles isn't done.
- After each fix group, update `PROGRESS.md` and fill in the blank "Reason / fix" fields in `VERIFY.md`.
- The user cares about **tokens and efficiency**:
  - Don't re-read whole files you don't need, and don't re-run the full suite after every one-line change.
  - Batch the checks.
  - Optionally, hand Mongolian/English copy reviews to a `sonnet` subagent and mechanical work (screenshots, link checks, Lighthouse runs) to a `haiku` subagent, each with a short exact brief. Do the hard code yourself.

---

## 3. Open issues to fix (in this order)

### 3.1 The home hero may be blank (check this first)
In `docs/screens/final-home-1440.png` (a full-page capture), the hero area, roughly the first 1,700 px, is **completely black**. There's no headline, CTAs or bottles. It could be one of two things:
- **A capture artifact:** the pinned ScrollTrigger hero is at its faded "end" state in a full-page shot, or the entrance fade never ran in headless mode.
- **A real bug:** the hero content stays invisible.

**To check:**
1. Load `/` at 1440×900 in a normal (not full-page) screenshot, both before and after scrolling.
2. Also test with JS disabled and with `prefers-reduced-motion`.

The headline "Үнэрээ ол." and the CTAs **must be visible on first paint without JS**. Treat the animation as an enhancement only, starting from visible content and not from `opacity:0` set in CSS. If the real page is fine, set a `data-shot` flag in `shot.mjs` so full-page captures reset the pin, and say so in VERIFY.md.

### 3.2 e2e-checkout: "API: bad JSON → 400" fails
The test sends `{nope` from `IP_TAMPER`, but **that IP has already used up its 5-order rate limit** earlier in the same script. So the API most likely answers 429 before it parses the body.

1. Print `r7.status` to confirm.
2. Decide the correct order of checks in `src/pages/api/orders.ts`:
   1. method and content-type
   2. size limit (reject bodies over 32 KB)
   3. JSON parse, returning **400** on failure
   4. zod, returning **422**
   5. honeypot
   6. Turnstile
   7. rate limit, returning **429**
   8. insert

   Parsing before the rate limit is cheap and correct. The rate limit must still run before any D1 write.
3. Also make the test use a fresh IP for each case, so the tests don't depend on each other.

### 3.3 JS budget: home total is 116.4 KB, against a 90 KB budget (same for `/en/`)
The lazy chunks are GSAP 27.3 + ScrollTrigger 17.8 + Swiper 19.2 KB. **Preferred fix: remove Swiper.**
- The creative effect in `animation1.md` §C is just "neighbors translate ±7.5% and fade to opacity 0 by distance from center, over 700 ms".
- Re-implement it in `LayeringSlider.tsx` as a CSS scroll-snap track, with transforms computed from each slide's offset (about 2 KB). Keep arrows, keyboard arrows, swipe, focus management and `aria-roledescription="carousel"`.
- That brings home to about 97 KB.

Then cut the rest:
- **Option A (preferred):** drive the hero pin with `position: sticky` plus the existing `src/lib/scroll-progress.ts` (writing CSS variables in rAF), and drop GSAP/ScrollTrigger from home entirely. That gets the total to about 50 KB.
- **Option B:** if the GSAP feel is clearly better, keep GSAP core and lazy-load ScrollTrigger only after the first scroll input, and document it.

Whichever you choose, re-measure smoothness with `e2e-home.mjs` (p95 frame time ≤ 17 ms) and confirm reduced motion still downloads no animation JS.

### 3.4 JS budget: Scent Finder (21.5 KB) and checkout (22.2 KB) are over the 20 KB "other pages" budget
These are island-heavy pages, so the plan's 20 KB budget for them was a planning mistake.
1. First look for real waste. Is the cart-drawer code or the i18n dictionary for both languages bundled into the initial chunk? Ship only the current locale's strings (`src/i18n/lite.ts` exists for this).
2. If they're still over, **set their budget to 25 KB** in `scripts/js-budget.mjs` with a comment, and record it as a plan correction in VERIFY.md.

Make the budget script treat `/en/` exactly like `/` (home uses the total rule).

### 3.5 Shop accessibility is at 95, the threshold
Two audits fail:
- "Select elements do not have associated label elements": the sort `<select>`. Give it a real `<label>`, visually hidden if needed.
- "Elements with visible text labels do not have matching accessible names" (label-in-name): find each one in `docs/lighthouse/shop-r2.report.json` (`label-content-name-mismatch`). An `aria-label` must **contain** the visible text, so remove or rewrite it.

Target ≥ 98.

### 3.6 Product page contrast (accessibility 97)
Find the failing nodes in `product-r2.report.json` (`color-contrast`). The likely culprits are `--text-dim` on `--ink-2`, or small gold text. Fix the token value or the specific use; don't just make everything brighter. Keep the luxury feel, and aim for 4.5:1 on body-size text.

### 3.7 Keyboard check fails on `/zahialga/` and `/tuslamj/`
This is most likely a false positive. Focus lands on `<body>` only when it wraps past the last element of the document. Fix the **test** so a body stop directly before wrapping to the first stop (the skip link) counts as normal. Before closing it, confirm by hand that there's no focus loss in the middle of the page.

### 3.8 Missing PROGRESS.md entries
Write the phase 7, 8 and 9 entries in the same style as phases 1–6: what was done, the gate result, and any deviations. Phase 7's gate list is in PLAN §8. Run `scripts/e2e-checkout.mjs` and cite its output.

### 3.9 Queued from phase 6 (Scent Finder at 360 px)
- The mood-band ingredient strips are cropped to their right end. Center them, or scale them down to fit.
- The bottom nav labels (Back / Next) touch each other. Add a gap, or shorten the labels to arrows plus a label.

Verify with `scripts/shot-finder.mjs` at 360 px.

---

## 4. Improvements after the fixes (quality pass)

Look at the screenshots like a designer. The site already looks premium, so polish it rather than redesign it.

1. **Home rhythm:** above the scent-family bands there's about 1,700 px of black. Even when the hero works, check that the pin length (about 100vh) doesn't feel like dead scroll on mobile. Shorten it on small screens if so.
2. **Layering Slider:** only one product shows at a time, with a lot of empty space. On desktop, show the neighbors partly faded (that's the ±7.5% look) so it reads as a carousel. Add a progress hairline under the slide counter.
3. **Notes grid:** the label sits over a dark photo. Add a subtle bottom gradient to the tile so labels stay readable over bright images (white flowers, saffron).
4. **Product cards:** check that the size chips and price line align across cards with long names (e.g. Maison Francis Kurkdjian).
5. **Copy quality:** have a `sonnet` subagent review every Mongolian string (`src/i18n/mn.json` and the product `description.mn` fields). Ask for natural, correct, luxury-tone Mongolian with correct ө/ү and no literal translation from English. It should return a diff for you to apply. Keep the `[[TODO owner]]` markers.
6. **Empty and error states:**
   - checkout with an empty cart
   - an API network failure, where the cart must survive
   - a 404 in English
7. **README:** check that it covers running, editing products, secrets (Turnstile, Telegram), D1 (local and remote), deploying with `wrangler`, and the owner TODO list (PLAN §10).

---

## 5. Definition of done
- Every 3.x item is fixed, or justified in VERIFY.md with its reason.
- `npm run build`, `npm run check`, `npm run linkcheck` and `npm run budget` all exit 0.
- All five e2e scripts pass against `wrangler dev`.
- Lighthouse mobile on home, shop and product: Performance ≥ 90, all other categories ≥ 98 where possible (95 minimum), and CLS < 0.05.
- PROGRESS.md has entries for phases 7–9 plus a "Handoff fixes (Opus)" entry. VERIFY.md has no blank "Reason / fix" fields.
- Final report to the main session:
  - what changed
  - before and after numbers (budgets and Lighthouse)
  - any deviations
  - anything unverified
