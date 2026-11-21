// Cloudflare Turnstile loader for the checkout island (loaded on demand, out of the initial JS).
/* ---------- Turnstile: load the script once per page session ---------- */
export interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}
let tsLoading: Promise<TurnstileApi> | null = null;
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  tsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => {
      tsLoading = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return tsLoading;
}


/** Renders one widget into `el`; the token (or "" when it expires / fails) goes to `onToken`. */
export async function mount(el: HTMLElement, sitekey: string, locale: string, theme: "dark" | "light", onToken: (t: string) => void) {
  const ts = await loadTurnstile();
  const id = ts.render(el, {
    sitekey,
    theme,
    // Turnstile has no Mongolian; "mn" logs a warning and falls back to en-us anyway
    language: locale === "en" ? "en" : "auto",
    callback: onToken,
    "expired-callback": () => onToken(""),
    "error-callback": () => onToken(""),
  });
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* already gone */
    }
  };
  return { reset: () => safe(() => ts.reset(id)), remove: () => safe(() => ts.remove(id)) };
}
