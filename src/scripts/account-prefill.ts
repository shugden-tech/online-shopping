// Checkout prefill for a signed-in customer (loaded lazily by the checkout island, only with the gz_in hint cookie):
// name and phone from the profile, the delivery fields from the default address. The order is linked to the
// account on the server from the session cookie; nothing here is trusted by the API.
import { call, getMe } from "./account-api";
import type { OrderFormValues } from "../lib/order-validate";

export interface Prefill {
  name: string;
  phone: string;
  city?: "ub" | "countryside";
  district?: string;
  khoroo?: string;
  address?: string;
}

export async function prefill(): Promise<Prefill | null> {
  const me = await getMe();
  if (!me) return null;
  const r = await call<{ items: { city: "ub" | "countryside"; district: string; khoroo: string; address: string; isDefault: boolean }[] }>("addresses");
  const a = r.ok ? r.data.items?.find((x) => x.isDefault) ?? r.data.items?.[0] : undefined;
  return { name: me.name, phone: me.phone ?? "", ...(a ? { city: a.city, district: a.district, khoroo: a.khoroo, address: a.address } : {}) };
}

type Set<T> = (fn: (prev: T) => T) => void;

/** Fills only the fields that are still empty (the customer may have typed already). */
export async function apply(setValues: Set<OrderFormValues>, setUbDistrict: Set<string>, setProvince: Set<string>) {
  const p = await prefill();
  if (!p) return;
  const { city, district = "", ...rest } = p;
  setValues((s) => {
    const n = { ...s };
    for (const [k, v] of Object.entries(rest)) if (v && !n[k as keyof OrderFormValues]) n[k as keyof OrderFormValues] = v;
    if (city) n.city = city;
    return n;
  });
  if (city) (city === "ub" ? setUbDistrict : setProvince)((d) => d || district);
}
