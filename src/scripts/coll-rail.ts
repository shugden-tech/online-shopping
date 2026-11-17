// Featured collections rail: scrolls slowly from right to left on its own and loops seamlessly.
// The markup renders the group list twice (the second copy is aria-hidden and out of the tab order),
// so when the scroll position passes the first copy it jumps back by exactly one copy's width,
// which looks identical. Hovering, focusing, touching or wheel-scrolling the rail pauses it and it
// resumes from wherever the reader left it. Off entirely when the reader asks for reduced motion.

const SPEED = 36; // px per second, moving right to left
const RESUME_AFTER_TOUCH = 1200; // ms to wait after a touch or wheel before auto-scroll continues

function initRail(rail: HTMLElement) {
  if (rail.dataset.marquee) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const items = rail.querySelectorAll<HTMLElement>(":scope > li");
  const half = items.length / 2;
  if (half < 2 || !Number.isInteger(half)) return;

  rail.dataset.marquee = "1";
  const loop = items[half]!.offsetLeft - items[0]!.offsetLeft; // width of one copy incl. gaps

  let paused = false;
  let resumeTimer = 0;
  const hold = () => {
    paused = true;
    clearTimeout(resumeTimer);
  };
  const release = (delay: number) => {
    clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => (paused = false), delay);
  };

  rail.addEventListener("mouseenter", hold);
  rail.addEventListener("mouseleave", () => release(0));
  rail.addEventListener("focusin", hold);
  rail.addEventListener("focusout", () => release(0));
  rail.addEventListener("pointerdown", hold, { passive: true });
  rail.addEventListener("wheel", () => { hold(); release(RESUME_AFTER_TOUCH); }, { passive: true });
  const endTouch = () => release(RESUME_AFTER_TOUCH);
  document.addEventListener("pointerup", endTouch, { passive: true });
  document.addEventListener("pointercancel", endTouch, { passive: true });

  let pos = rail.scrollLeft;
  let last = performance.now();

  const frame = (now: number) => {
    // Stop quietly once this page has been replaced (the rail left the document).
    if (!rail.isConnected) return;
    const dt = Math.min(now - last, 100) / 1000; // clamp: a background tab must not jump ahead
    last = now;

    if (paused) {
      pos = rail.scrollLeft; // follow the reader's own scrolling
    } else {
      pos += SPEED * dt;
      if (pos >= loop) pos -= loop;
      rail.scrollLeft = pos;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function init() {
  document.querySelectorAll<HTMLElement>(".coll__rail").forEach(initRail);
}

document.addEventListener("astro:page-load", init);
init();

export {}; // a module, so its init() does not clash with other scripts
