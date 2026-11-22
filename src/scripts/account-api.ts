// Browser side of the customer account API (/api/account/*). Tiny on purpose: the header badge, the wishlist sync
// and the checkout prefill import it lazily, and only when the `gz_in=1` hint cookie says a session may exist.
// The session itself is an HttpOnly cookie this code never sees.

export interface Me {
  id: number;
  phone: string | null;
  name: string;
  displayName: string;
  showOnBoard: boolean;
  avatarUrl: string | null;
  email: string | null;
  google: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface ApiRes<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T & { ok?: boolean; errors?: Record<string, string> };
}

/** The non-secret hint cookie the server sets next to the session cookie. */
export const hinted = () => /(?:^|;\s*)gz_in=1(?:;|$)/.test(document.cookie);

export function dropHint() {
  try {
    document.cookie = "gz_in=; Path=/; Max-Age=0; Secure; SameSite=Lax";
  } catch {
    /* ignore */
  }
}

export async function call<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<ApiRes<T>> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  try {
    const res = await fetch(`/api/account/${path}`, { method: init.method ?? "GET", headers, body, credentials: "same-origin", cache: "no-store" });
    let data = {} as ApiRes<T>["data"];
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401) dropHint();
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} as ApiRes<T>["data"] };
  }
}

const ME_SLOT = "gz-me";
export const ME_EVENT = "gz-account-change";

/** The signed-in customer (cached for this tab for 2 minutes), or null. */
export async function getMe(fresh = false): Promise<Me | null> {
  if (!hinted()) return null;
  if (!fresh) {
    try {
      const c = JSON.parse(sessionStorage.getItem(ME_SLOT) ?? "null") as { at: number; me: Me } | null;
      if (c && Date.now() - c.at < 120_000) return c.me;
    } catch {
      /* storage blocked */
    }
  }
  const r = await call<{ customer: Me | null }>("me");
  const me = r.ok ? r.data.customer ?? null : null;
  if (r.ok && !me) dropHint();
  setMe(me, false);
  return me;
}

/** Updates the tab cache and tells the header (and other listeners) that the account changed. */
export function setMe(me: Me | null, notify = true) {
  try {
    if (me) sessionStorage.setItem(ME_SLOT, JSON.stringify({ at: Date.now(), me }));
    else sessionStorage.removeItem(ME_SLOT);
  } catch {
    /* storage blocked */
  }
  if (notify) document.dispatchEvent(new CustomEvent(ME_EVENT, { detail: me }));
}
