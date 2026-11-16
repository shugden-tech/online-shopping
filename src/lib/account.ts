// Demo customer account. Browser-only: everything lives in localStorage.
// All storage access goes through this module so it can be swapped for a Cloudflare D1 backend later.
// Every read and write is wrapped in try/catch: blocked or corrupt storage must never break a page.

export interface Account {
  name: string;
  phone: string;
  displayName: string;
  showOnBoard: boolean;
  createdAt: string;
}

export interface OrderItem {
  name: string;
  brand: string;
  ml: number;
  qty: number;
  price: number;
}

export interface Order {
  no: string;
  /** ISO timestamp */
  date: string;
  total: number;
  items: OrderItem[];
}

export const ACCOUNT_KEY = "gz_account";
export const ORDERS_KEY = "gz_orders";
/** Keep the local history bounded; the oldest orders drop off first. */
const MAX_ORDERS = 200;

/* ---------- validation ---------- */

/** Trimmed name, at least 2 characters. Returns the cleaned name or null. */
export function cleanName(input: string): string | null {
  const v = input.trim().replace(/\s+/g, " ");
  return v.length >= 2 && v.length <= 60 ? v : null;
}

/**
 * Mongolian mobile number: 8 digits, optional +976 prefix (spaces and dashes are ignored).
 * Returns the 8-digit form, or null.
 */
export function cleanPhone(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "");
  const digits = compact.startsWith("+976") ? compact.slice(4) : compact;
  return /^\d{8}$/.test(digits) ? digits : null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isAccount(v: unknown): v is Account {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    isStr(a.name) && isStr(a.phone) && isStr(a.displayName) &&
    typeof a.showOnBoard === "boolean" && isStr(a.createdAt)
  );
}

function isOrderItem(v: unknown): v is OrderItem {
  if (!v || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  return isStr(i.name) && isStr(i.brand) && isNum(i.ml) && isNum(i.qty) && isNum(i.price);
}

function isOrder(v: unknown): v is Order {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isStr(o.no) && isStr(o.date) && isNum(o.total) &&
    Array.isArray(o.items) && o.items.every(isOrderItem)
  );
}

/* ---------- raw storage ---------- */

function readRaw(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------- account ---------- */

export function getAccount(): Account | null {
  const v = readRaw(ACCOUNT_KEY);
  return isAccount(v) ? v : null;
}

/** Saves the whole account. Returns false when storage is unavailable. */
export function setAccount(account: Account): boolean {
  return writeRaw(ACCOUNT_KEY, account);
}

/** Removes the account only. The wishlist and order history are left alone. */
export function clearAccount(): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* storage blocked */
  }
}

/* ---------- orders ---------- */

export function getOrders(): Order[] {
  const v = readRaw(ORDERS_KEY);
  return Array.isArray(v) ? v.filter(isOrder) : [];
}

/** Appends one order. Duplicate order numbers are ignored. Never throws. */
export function recordOrder(order: { no: string; total: number; items: OrderItem[] }): boolean {
  try {
    const orders = getOrders();
    if (orders.some((o) => o.no === order.no)) return true;
    const next: Order = {
      no: order.no,
      date: new Date().toISOString(),
      total: order.total,
      items: order.items.filter(isOrderItem),
    };
    return writeRaw(ORDERS_KEY, [...orders, next].slice(-MAX_ORDERS));
  } catch {
    return false;
  }
}

export function clearOrders(): void {
  try {
    localStorage.removeItem(ORDERS_KEY);
  } catch {
    /* storage blocked */
  }
}
