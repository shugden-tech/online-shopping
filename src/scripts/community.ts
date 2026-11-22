// Home page "Top 3 customers": period tabs (7 days / month / all time).
// Runs on first load and again after each view-transition swap; each root is bound once.
const KEYS = ["ArrowLeft", "ArrowRight"];

function bind(root: HTMLElement) {
  if (root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];

  const select = (i: number, focus = false) => {
    const n = tabs.length;
    const idx = (i + n) % n;
    tabs.forEach((t, j) => {
      const on = j === idx;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    panels.forEach((p, j) => (p.hidden = j !== idx));
  };

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(i));
    t.addEventListener("keydown", (e) => {
      if (!KEYS.includes(e.key)) return;
      e.preventDefault();
      const cur = tabs.findIndex((x) => x.getAttribute("aria-selected") === "true");
      select(cur + (e.key === "ArrowRight" ? 1 : -1), true);
    });
  });
}

function init() {
  document.querySelectorAll<HTMLElement>("[data-community]").forEach(bind);
}

init();
let listening = false;
if (!listening) {
  listening = true;
  document.addEventListener("astro:page-load", init);
}

export {};
