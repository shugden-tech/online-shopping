// Home page: the banner slider (auto-advance, arrows, dots, swipe) and the product tabs.
// Torn down before a view-transition swap; no auto-advance under prefers-reduced-motion.
let cleanups: Array<() => void> = [];

function initSlider(root: HTMLElement) {
  const slides = [...root.querySelectorAll<HTMLElement>("[data-slide]")];
  const dots = [...root.querySelectorAll<HTMLElement>("[data-dot]")];
  if (slides.length < 2) return;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const breakpoint = window.matchMedia("(max-width: 760px)");
  const rotation = root.querySelector<HTMLButtonElement>("[data-rotation]");
  let hovered = false;
  let focused = false;
  let userPaused = false;
  let cur = 0;
  let timer = 0;

  const go = (i: number) => {
    cur = (i + slides.length) % slides.length;
    slides.forEach((el, j) => {
      const on = j === cur;
      el.classList.toggle("is-on", on);
      if (on) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", "true");
      el.inert = !on;
      el.querySelectorAll("a").forEach((a) => (on ? a.removeAttribute("tabindex") : a.setAttribute("tabindex", "-1")));
    });
    dots.forEach((d, j) => (j === cur ? d.setAttribute("aria-current", "true") : d.removeAttribute("aria-current")));
    restart();
  };
  const restart = () => {
    window.clearInterval(timer);
    // Each responsive carousel keeps only its existing timer; the hidden set stays paused.
    if (!motion.matches && !document.hidden && !hovered && !focused && !userPaused && root.getClientRects().length) {
      timer = window.setInterval(() => go(cur + 1), 6500);
    }
  };

  const onClick = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-rotation]")) {
      userPaused = !userPaused;
      rotation?.setAttribute("aria-pressed", String(userPaused));
      restart();
    }
    else if (t.closest("[data-prev]")) go(cur - 1);
    else if (t.closest("[data-next]")) go(cur + 1);
    else {
      const d = t.closest<HTMLElement>("[data-dot]");
      if (d) go(Number(d.dataset.dot));
    }
  };
  let x0: number | null = null;
  let y0 = 0;
  const onStart = (e: TouchEvent) => { x0 = e.touches[0]?.clientX ?? null; y0 = e.touches[0]?.clientY ?? 0; pause(); };
  const onEnd = (e: TouchEvent) => {
    if (x0 === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
    const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(cur + (dx < 0 ? 1 : -1));
    x0 = null;
    restart();
  };
  const pause = () => window.clearInterval(timer);
  const onEnter = () => { hovered = true; pause(); };
  const onLeave = () => { hovered = false; restart(); };
  const onFocus = () => { focused = true; pause(); };
  const onBlur = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
    focused = false; restart();
  };
  const onCancel = () => { x0 = null; restart(); };
  const onVis = () => (document.hidden ? pause() : restart());

  root.addEventListener("click", onClick);
  root.addEventListener("touchstart", onStart, { passive: true });
  root.addEventListener("touchend", onEnd);
  root.addEventListener("touchcancel", onCancel);
  root.addEventListener("mouseenter", onEnter);
  root.addEventListener("mouseleave", onLeave);
  root.addEventListener("focusin", onFocus);
  root.addEventListener("focusout", onBlur);
  document.addEventListener("visibilitychange", onVis);
  motion.addEventListener("change", restart);
  breakpoint.addEventListener("change", restart);
  restart();

  cleanups.push(() => {
    window.clearInterval(timer);
    root.removeEventListener("click", onClick);
    root.removeEventListener("touchstart", onStart);
    root.removeEventListener("touchend", onEnd);
    root.removeEventListener("touchcancel", onCancel);
    root.removeEventListener("mouseenter", onEnter);
    root.removeEventListener("mouseleave", onLeave);
    root.removeEventListener("focusin", onFocus);
    root.removeEventListener("focusout", onBlur);
    document.removeEventListener("visibilitychange", onVis);
    motion.removeEventListener("change", restart);
    breakpoint.removeEventListener("change", restart);
  });
}

function initTabs(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const select = (tab: HTMLElement, focus = false) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  };
  const onClick = (e: Event) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (tab) select(tab);
  };
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    select(tabs[(i + step + tabs.length) % tabs.length]!, true);
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  cleanups.push(() => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKey);
  });
}

function init() {
  teardown();
  document.querySelectorAll<HTMLElement>("[data-slider]").forEach(initSlider);
  const tabs = document.querySelector<HTMLElement>("[data-tabs]");
  if (tabs) initTabs(tabs);
}

function teardown() {
  for (const fn of cleanups) fn();
  cleanups = [];
}

document.addEventListener("astro:page-load", init);
document.addEventListener("astro:before-swap", teardown);
