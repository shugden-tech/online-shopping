// Header account badge: shows the first word of the signed-in demo account name next to the profile icon.
// The profile page dispatches `gz-account-change` after sign-in, sign-out or a save; other tabs fire `storage`.
import { getAccount } from "../lib/account";

function sync() {
  const first = getAccount()?.name.trim().split(/\s+/)[0] ?? "";
  document.querySelectorAll<HTMLElement>("[data-acct-name]").forEach((el) => {
    el.textContent = first;
  });
}

sync();
document.addEventListener("astro:page-load", sync);
document.addEventListener("gz-account-change", sync);
window.addEventListener("storage", (e) => {
  if (e.key === null || e.key === "gz_account") sync();
});
