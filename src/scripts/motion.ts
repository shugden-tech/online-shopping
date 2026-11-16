// Page motion: tags the main blocks of each page for the scroll reveal in shell.ts (fade + rise +
// un-blur, staggered within a group), so the markup of every component does not need data-reveal.
// Runs before shell.ts's own astro:page-load handler (it is imported first), so initReveal() then
// observes these elements too. Nothing is hidden without JS: the attribute is only added here.
import "../styles/motion.css";

/** [group selector, item selector inside it (or "" for the group itself), stagger in ms] */
const GROUPS: Array<[string, string, number]> = [
  [".promo", ":scope > *", 120],
  [".coll", ".h-sec", 0],
  [".coll__rail", "", 0], // the rail scrolls sideways: reveal it as one block so off-screen items are never left hidden
  [".gtiles", ":scope > *", 110],
  [".tabs-sec", ".tabs", 0],
  [".tabs__panel:not([hidden]) .grid", ":scope > li", 70],
  [".top3", ":scope > *", 0],
  [".reviews", ".h-sec, :scope > h2, :scope > header", 0],
  [".reviews__grid", ":scope > *", 90],
  [".brands", "", 0],
  [".about", ":scope > *", 100],
  [".info__in", ":scope > li", 100],
  [".ftr__top", ":scope > *", 80],
  // shop and product pages
  [".shop-grid, .shop__grid, [data-shop-grid]", ":scope > *", 40],
  [".pdp", ":scope > *", 100],
];

const MAX_STAGGER = 8; // after this many items in a group, the rest share the last delay

function tag() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const [groupSel, itemSel, step] of GROUPS) {
    document.querySelectorAll<HTMLElement>(groupSel).forEach((group) => {
      const items = itemSel ? group.querySelectorAll<HTMLElement>(itemSel) : [group];
      items.forEach((el, i) => {
        if (el.hasAttribute("data-reveal")) return;
        el.setAttribute("data-reveal", "");
        el.dataset.motion = "";
        if (step) el.style.setProperty("--delay", `${Math.min(i, MAX_STAGGER) * step}ms`);
      });
    });
  }
}

document.addEventListener("astro:page-load", tag);

// Tabs on the home page show a hidden panel: reveal its cards when it opens.
document.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement | null)?.closest?.('[role="tab"]');
  if (!tab) return;
  requestAnimationFrame(() => {
    document.querySelectorAll<HTMLElement>('.tabs__panel:not([hidden]) .grid > li').forEach((li, i) => {
      li.classList.remove("is-in");
      li.setAttribute("data-reveal", "");
      li.style.setProperty("--delay", `${Math.min(i, MAX_STAGGER) * 60}ms`);
      requestAnimationFrame(() => li.classList.add("is-in"));
    });
  });
});
