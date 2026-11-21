// Header account badge: with a session (hint cookie gz_in=1) shows the customer's avatar, or the initial of the
// name, and the first name next to the profile icon. Loaded lazily by shell.ts; the account API code is only
// fetched when the hint cookie exists. The profile page dispatches `gz-account-change` after sign-in / out / saves.
import type { Me } from "./account-api";

function paint(me: Me | null) {
  const first = me ? (me.displayName || me.name).trim().split(/\s+/)[0] ?? "" : "";
  document.querySelectorAll<HTMLElement>("[data-acct-name]").forEach((el) => (el.textContent = first));
  document.querySelectorAll<HTMLElement>("[data-acct-avatar]").forEach((el) => {
    el.replaceChildren();
    el.closest(".hdr__acct")?.toggleAttribute("data-in", !!me);
    if (!me) return;
    if (me.avatarUrl) {
      const img = document.createElement("img");
      img.src = me.avatarUrl;
      img.alt = "";
      img.width = 28;
      img.height = 28;
      img.decoding = "async";
      el.append(img);
    } else el.textContent = (first[0] ?? "•").toUpperCase();
  });
}

const hinted = () => /(?:^|;\s*)gz_in=1(?:;|$)/.test(document.cookie);

async function sync() {
  if (!hinted()) return paint(null);
  const { getMe } = await import("./account-api");
  paint(await getMe());
}

void sync();
document.addEventListener("astro:page-load", () => void sync());
document.addEventListener("gz-account-change", (e) => paint((e as CustomEvent<Me | null>).detail ?? null));
