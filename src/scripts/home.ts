// Home-page motion: hero scroll sequence (sticky pin + rAF custom properties), gold dust canvas,
// family-strip parallax. Everything is torn down before a view-transition swap and nothing
// runs under prefers-reduced-motion.
import { clamp01, prefersReducedMotion, trackViewportProgress } from "../lib/scroll-progress";

let cleanups: Array<() => void> = [];

function teardown() {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* already gone */
    }
  }
  cleanups = [];
}

/* ---------- gold dust: one canvas, ≤ 60 particles, paused when off-screen or tab hidden ---------- */
function startDust(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const count = Math.min(60, window.innerWidth < 700 ? 34 : 60);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const parts = Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: rand(0.4, 1.9),
    vy: rand(0.006, 0.022), // screen-heights per second, drifting up
    sway: rand(0.004, 0.016),
    phase: rand(0, Math.PI * 2),
    tw: rand(0.4, 1.3),
    a: rand(0.18, 0.75),
  }));

  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  let frame = 0;
  let last = 0;
  let onScreen = true;
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const t = now / 1000;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.y -= p.vy * dt;
      if (p.y < -0.03) {
        p.y = 1.03;
        p.x = Math.random();
      }
      const x = (p.x + Math.sin(t * 0.35 + p.phase) * p.sway) * w;
      const y = p.y * h;
      // brighter under the spotlight (top-centre), fading towards the edges
      const light = Math.max(0.15, 1 - Math.hypot(p.x - 0.5, p.y * 0.9) * 1.25);
      const alpha = p.a * light * (0.6 + 0.4 * Math.sin(t * p.tw + p.phase));
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = "#e2c48a";
      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, 6.2832);
      ctx.fill();
      if (p.r > 1.4) {
        ctx.globalAlpha = Math.max(0, alpha * 0.18);
        ctx.beginPath();
        ctx.arc(x, y, p.r * 3.2, 0, 6.2832);
        ctx.fill();
      }
    }
  };
  const play = () => {
    if (!frame && onScreen && !document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
  };
  const pause = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const io = new IntersectionObserver(([e]) => {
    onScreen = Boolean(e?.isIntersecting);
    onScreen ? play() : pause();
  });
  io.observe(canvas);
  const onVis = () => (document.hidden ? pause() : play());
  document.addEventListener("visibilitychange", onVis);
  play();

  return () => {
    pause();
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  };
}

/* ---------- hero: pinned (position: sticky) for ~100vh; headline drifts up and fades, spotlight widens, bottles rise ----------
   No animation library: one rAF writes a few custom properties from the scroll position. The value is eased
   towards the target (≈0.6 s settle, like a GSAP scrub) so wheel steps still feel smooth. */
const seg = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
const sineIn = (t: number) => 1 - Math.cos((t * Math.PI) / 2);
const sineOut = (t: number) => Math.sin((t * Math.PI) / 2);
const sineInOut = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function startHero(hero: HTMLElement): () => void {
  hero.classList.add("hero--live"); // adds the pin length (CSS) and shows the bottle stage
  const bottles = Array.from(hero.querySelectorAll<HTMLElement>(".hero__bottle"));
  const order = [bottles[1], bottles[0], bottles[2]].filter((b): b is HTMLElement => Boolean(b));
  const set = (el: HTMLElement, k: string, v: number) => el.style.setProperty(k, v.toFixed(4));

  let target = 0;
  let cur = -1;
  let frame = 0;
  let last = 0;
  const measure = () => {
    const r = hero.getBoundingClientRect();
    const run = r.height - window.innerHeight;
    target = run > 0 ? clamp01(-r.top / run) : 0;
  };
  const paint = (p: number) => {
    set(hero, "--hint", 1 - seg(p, 0, 0.12));
    const c = sineIn(seg(p, 0, 0.5));
    set(hero, "--content", c);
    hero.classList.toggle("is-past", c > 0.98); // faded-out CTAs must not take clicks or focus
    set(hero, "--spot", sineInOut(p));
    set(hero, "--floor", seg(p, 0.38, 0.63) * 0.8);
    set(hero, "--sizes", seg(p, 0.72, 0.92));
    order.forEach((b, j) => set(b, "--t", sineOut(seg(p, 0.4 + 0.07 * j, 0.82 + 0.07 * j))));
  };
  const tick = (now: number) => {
    frame = 0;
    measure();
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
    last = now;
    if (cur < 0) cur = target;
    else cur += (target - cur) * (1 - Math.exp(-dt / 0.14));
    if (Math.abs(target - cur) < 0.0008) cur = target;
    paint(cur);
    if (cur !== target) frame = requestAnimationFrame(tick);
    else last = 0;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  schedule();

  return () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    if (frame) cancelAnimationFrame(frame);
    hero.classList.remove("hero--live", "is-past");
    for (const k of ["--hint", "--content", "--spot", "--floor", "--sizes"]) hero.style.removeProperty(k);
    bottles.forEach((b) => b.style.removeProperty("--t"));
  };
}

function init() {
  teardown();
  const hero = document.querySelector<HTMLElement>("[data-hero]");
  if (!hero) return;
  if (prefersReducedMotion()) return; // static hero, no parallax, no particles

  const canvas = hero.querySelector<HTMLCanvasElement>(".hero__dust");
  if (canvas) cleanups.push(startDust(canvas));

  // family strips slide sideways as their band crosses the viewport
  const bands = document.querySelectorAll<HTMLElement>("[data-band]");
  if (bands.length) {
    cleanups.push(
      trackViewportProgress(bands, (el, p) => {
        const dir = el.dataset.dir === "-1" ? -1 : 1;
        const travel = 260;
        const x = dir === 1 ? -40 - p * travel : -40 - (1 - p) * travel;
        el.style.setProperty("--x", `${x.toFixed(1)}px`);
      }),
    );
  }

  cleanups.push(startHero(hero));
}

document.addEventListener("astro:page-load", init);
document.addEventListener("astro:before-swap", teardown);
