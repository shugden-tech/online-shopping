# Reference notes

Captured 2026-11-12. These screenshots are a **private moodboard only**. The brand photos and logos are copyrighted and must not ship on a published site.

## dolcegabbana-velvet (beautytools.dolcegabbana.com/en-mn/velvet)
Main motion reference and the source of `animation1.md`.
- **Intro (01–03):** a fully scroll-driven sequence on a near-black (#0b0b0b to #2a2a2a) background. It starts with a top spotlight and dust particles, with the D&G wordmark and the gold "VELVET COLLECTION" line in the center. Scrolling fades the logo out, the particles drift, and the bottle pyramid rises out of a reflective liquid floor. The hint text reads "SCROLL TO BEGIN".
- **Hub (03):** a numbered menu, "01 Discover the collection" and "02 Customize your scent", in small, widely tracked uppercase. There is a hamburger menu on the left and a sound toggle on the right.
- **Quiz (04–05):** opens with a "DG" monogram loader between hairline gold rules. Each question then gets a full-bleed color wash in its own mood (sage and green here) with light rays. A vertical gold slider picks between two poles (LUMINOUS / OPULENT). BACK and NEXT sit on a hairline, and the inactive option is dimmed.
- **Type:** Futura LT Pro (UI), Walbaum (display serif), Roboto Mono (small labels). Our substitutes are Montserrat and Cormorant Garamond.
- **Takeaways:** dark-first design, one accent (muted gold), hairline rules, wide tracking, slow opacity fades, and particles plus light rays for atmosphere.

## jeanpaulgaultier (jeanpaulgaultier.com/ww/en/fragrances)
- Full-bleed campaign hero with a black text card in the lower left. The headline is a heavy condensed sans in uppercase ("LA FAVORITE GAME").
- Body copy is set in a **monospace** font, which gives an editorial and slightly irreverent feel.
- Asymmetric product grid: a large lifestyle image beside a solid-color product tile (red, teal), each labeled "NEW". There is a giant outline-style headline ("THAT'S NOT OVER") above a row of colored product cards.
- Takeaway: the poster-like headline scale and solid-color product tiles.

## decantx (decantx.com)
- Retail and decant layout: promo hero, warm autumn product photography, and a "Featured Collections" row of 6 square tiles.
- The product card pattern applies directly to our build: brand line, name, price, **size chips (2ml / 5ml / 10ml)**, ADD TO CART button, wishlist heart, and star rating.
- There is a row of brand wordmarks and trust badges (shipping, authenticity, payment) above the footer.
- Takeaway: the size-chip UX, which suits a decant or sample business.

## luckyscent (luckyscent.com)
- Classic serif section headings ("Featured Collections", "New and Noteworthy") on a white background, with horizontal carousels that show a peek of the next card and an arrow.
- Product cards stack brand (tiny), name, concentration and price range (e.g. "$6 – $195"), which works well for sample-to-full-bottle pricing.
- Has "Discovery Sets" and "Featured Brands" rails, plus an email-capture modal (10% off).
- Takeaway: the shop-by-rails structure and price ranges.

## scentbird (scentbird.com) — not captured
The site served a Cloudflare bot check to the headless browser. I didn't try to get around it. To add it, open the site in your own browser and save screenshots to `reference/scentbird/`.

## Gaps
- The `.slider-list` element from `animation1.md` wasn't found on the quiz page. It's likely on the quiz results or collection view, which is only reachable after answering the quiz.
- Logos are pending a Brandfetch client ID. See `assets/logos/`.
