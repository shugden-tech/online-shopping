// Duplicate-order protection for the checkout island (loaded lazily on submit).
// One idempotency key per checkout attempt, kept in sessionStorage so a retry (double click, lost response,
// reload) reuses it and the server answers with the original order instead of storing a second one.
// It is dropped only after a successful order.
const KEY_SLOT = "gz-checkout-key";
/** Last order placed in this tab: lets the success page verify it through /api/orders/lookup. */
const LAST_ORDER_SLOT = "gz-last-order";
let memoryKey: string | null = null; // used when sessionStorage is blocked

function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function checkoutKey(): string {
  try {
    const k = sessionStorage.getItem(KEY_SLOT);
    if (k && /^[A-Za-z0-9_-]{16,100}$/.test(k)) return k;
    const n = newKey();
    sessionStorage.setItem(KEY_SLOT, n);
    return n;
  } catch {
    return (memoryKey ??= newKey());
  }
}

export function orderPlaced(orderNo: string, phone: string): void {
  memoryKey = null;
  try {
    sessionStorage.removeItem(KEY_SLOT);
    sessionStorage.setItem(LAST_ORDER_SLOT, JSON.stringify({ no: orderNo, phone }));
  } catch {
    /* storage blocked: the success page then asks for the phone */
  }
}
