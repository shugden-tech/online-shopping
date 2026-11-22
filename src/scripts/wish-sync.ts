// Wishlist ⇄ account sync (loaded by wishlist.ts only when the gz_in hint cookie exists).
//   once per tab session (and right after sign-in): PUT mode "merge" = local ∪ server, written back to localStorage
//   after every local add / remove: PUT mode "replace" (debounced)
// Signed out, nothing here runs and the wishlist stays browser-only.
import { call, hinted } from "./account-api";

const KEY = "gz_wish";
const DONE = "gz-wish-merged";

const local = (): unknown[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

let merging: Promise<void> | null = null;
let inflight = false;

export function mergeNow(): Promise<void> {
  if (inflight && merging) return merging;
  inflight = true;
  merging = (async () => {
    const r = await call<{ items: unknown[] }>("wishlist", { method: "PUT", body: { items: local(), mode: "merge" } });
    if (!r.ok || !Array.isArray(r.data.items)) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(r.data.items));
      sessionStorage.setItem(DONE, "1");
    } catch {
      /* storage blocked */
    }
    document.dispatchEvent(new Event("gz-wish-reload"));
  })().finally(() => (inflight = false));
  return merging;
}

let timer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("gz-wish-change", () => {
  if (!hinted()) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await merging;
    void call("wishlist", { method: "PUT", body: { items: local(), mode: "replace" } });
  }, 500);
});

let done = false;
try {
  done = sessionStorage.getItem(DONE) === "1";
} catch {
  /* storage blocked */
}
if (!done && hinted()) void mergeNow();
