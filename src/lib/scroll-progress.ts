// Scroll progress helpers (the "useTrackScrollProgress" of animation1.md).
// Everything is read in one requestAnimationFrame per frame — never in the scroll event itself.

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Map `v` from [from, to] to 0–1 (clamped). ramp(0.03, 0.015, 0.05) ≈ 0.43 */
export const ramp = (v: number, from: number, to: number) => clamp01((v - from) / (to - from));

type Stop = () => void;

/**
 * Progress of a scroll container: 0 at the top, 1 at the very end.
 * Used by the layering slider's mask.
 */
export function trackScrollProgress(scroller: HTMLElement, onChange: (progress: number) => void): Stop {
  let frame = 0;
  let last = -1;
  const read = () => {
    frame = 0;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const p = max > 0 ? clamp01(scroller.scrollTop / max) : 0;
    if (p !== last) {
      last = p;
      onChange(p);
    }
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(read);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  const ro = "ResizeObserver" in window ? new ResizeObserver(onScroll) : null;
  ro?.observe(scroller);
  read();
  return () => {
    scroller.removeEventListener("scroll", onScroll);
    ro?.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}

/**
 * Progress of elements through the viewport: 0 when the element's top reaches the bottom
 * of the screen, 1 when its bottom leaves the top. Only elements on screen are measured.
 */
export function trackViewportProgress(els: Iterable<HTMLElement>, onChange: (el: HTMLElement, progress: number) => void): Stop {
  const active = new Set<HTMLElement>();
  let frame = 0;
  const read = () => {
    frame = 0;
    const vh = window.innerHeight;
    active.forEach((el) => {
      const r = el.getBoundingClientRect();
      onChange(el, clamp01((vh - r.top) / (vh + r.height)));
    });
  };
  const schedule = () => {
    if (!frame && active.size) frame = requestAnimationFrame(read);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) active.add(e.target as HTMLElement);
      else active.delete(e.target as HTMLElement);
    }
    schedule();
  });
  for (const el of els) io.observe(el);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  return () => {
    io.disconnect();
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
