// Flower cursor: a small outlined flower in the logo colours trails the pointer, slowly turning,
// and opens up over anything clickable. A centre dot sits exactly on the pointer so clicks stay
// precise. Only for a real mouse (hover + fine pointer) and never under reduced motion; text
// fields keep the normal text cursor.
const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
const still = window.matchMedia("(prefers-reduced-motion: reduce)");

const PETALS = Array.from({ length: 6 }, (_, i) => {
  const a = i * 60;
  return `<ellipse cx="20" cy="9.5" rx="5" ry="8.5" transform="rotate(${a} 20 20)"/>`;
}).join("");
const SVG = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><g class="fc__petals">${PETALS}</g><circle class="fc__core" cx="20" cy="20" r="3.4"/></svg>`;

const CLICKABLE = 'a, button, [role="tab"], [role="button"], label, summary, select, .pcard__media, [data-size-chip]';
const TEXT = 'input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea, [contenteditable="true"]';

let flower: HTMLDivElement | null = null;
let dot: HTMLDivElement | null = null;
let x = -100, y = -100, fx = -100, fy = -100;
let frame = 0;
let enabled = false;

function ensure() {
  if (!enabled) return;
  if (!flower || !document.body.contains(flower)) {
    flower = document.createElement("div");
    flower.className = "fc";
    flower.innerHTML = SVG;
    dot = document.createElement("div");
    dot.className = "fc-dot";
    document.body.append(flower, dot);
  }
}

function loop() {
  frame = 0;
  if (!flower || !dot) return;
  fx += (x - fx) * 0.2;
  fy += (y - fy) * 0.2;
  flower.style.transform = `translate3d(${fx}px, ${fy}px, 0)`;
  dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  if (Math.abs(x - fx) > 0.2 || Math.abs(y - fy) > 0.2) frame = requestAnimationFrame(loop);
}

function onMove(e: PointerEvent) {
  if (e.pointerType !== "mouse") return;
  x = e.clientX;
  y = e.clientY;
  if (fx < -50) { fx = x; fy = y; } // first move: start on the pointer, no fly-in
  const t = e.target as Element | null;
  const root = document.documentElement;
  root.classList.add("fc-on");
  root.classList.toggle("fc-text", !!t?.closest?.(TEXT));
  root.classList.toggle("fc-bloom", !!t?.closest?.(CLICKABLE));
  if (!frame) frame = requestAnimationFrame(loop);
}

function onDown() { document.documentElement.classList.add("fc-press"); }
function onUp() { document.documentElement.classList.remove("fc-press"); }
function onLeave() { document.documentElement.classList.remove("fc-on"); }

function enable() {
  if (enabled) return;
  enabled = true;
  document.documentElement.classList.add("has-fc");
  ensure();
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
}

function disable() {
  if (!enabled) return;
  enabled = false;
  const root = document.documentElement;
  root.classList.remove("has-fc", "fc-on", "fc-bloom", "fc-press", "fc-text");
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerdown", onDown);
  window.removeEventListener("pointerup", onUp);
  root.removeEventListener("pointerleave", onLeave);
  flower?.remove();
  dot?.remove();
  flower = dot = null;
}

function update() {
  if (fine.matches && !still.matches) enable();
  else disable();
}

fine.addEventListener?.("change", update);
still.addEventListener?.("change", update);
update();
// view transitions replace <body>: put the cursor back after each swap
document.addEventListener("astro:page-load", () => {
  ensure();
  document.documentElement.classList.remove("fc-bloom", "fc-press");
});

export {}; // a module, so shell.ts can import() it lazily
