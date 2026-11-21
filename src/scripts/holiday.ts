// Holiday (Christmas) mode: a theme switch like dark mode. The choice is kept in this browser only.
// The stored theme is applied before first paint by the inline script in Base.astro, so no flash.
const KEY = "gz-theme";
const THEME = "christmas";
const FLAKES = 26;
const FLAKE_IMG = `${import.meta.env.BASE_URL}holiday/snowflake.png`;

function read(): boolean {
  try { return localStorage.getItem(KEY) === THEME; } catch { return false; }
}
function write(on: boolean) {
  try { on ? localStorage.setItem(KEY, THEME) : localStorage.removeItem(KEY); } catch { /* private mode */ }
}

function snowLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "holiday-snow";
  layer.setAttribute("aria-hidden", "true");
  for (let n = 0; n < FLAKES; n++) {
    const f = document.createElement("i");
    const size = 10 + Math.random() * 12;
    f.innerHTML = `<img src="${FLAKE_IMG}" alt="" draggable="false" />`;
    f.style.left = `${Math.random() * 100}%`;
    f.style.width = f.style.height = `${size}px`;
    f.style.animationDuration = `${9 + Math.random() * 10}s`;
    f.style.animationDelay = `${-Math.random() * 15}s`; // start mid-fall so the screen is never empty
    layer.appendChild(f);
  }
  return layer;
}

function render(on: boolean) {
  const root = document.documentElement;
  if (on) root.dataset.theme = THEME; else delete root.dataset.theme;
  document.querySelectorAll<HTMLButtonElement>("[data-theme-switch]").forEach((button) => {
    button.setAttribute("aria-checked", String(on));
  });
  document.querySelector(".holiday-snow")?.remove();
  if (on) document.body.appendChild(snowLayer());
}

function init() {
  render(read());
  document.querySelectorAll<HTMLButtonElement>("[data-theme-switch]").forEach((button) => {
    if (button.dataset.themeBound) return;
    button.dataset.themeBound = "true";
    button.addEventListener("click", () => {
      const on = document.documentElement.dataset.theme !== THEME;
      write(on);
      render(on);
    });
  });
}

document.addEventListener("astro:page-load", init);
init();
