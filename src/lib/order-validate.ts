// Client-side order form validation (no zod: keeps the checkout island small).
// The server re-validates everything with the zod schema in ./order-schema.ts using the same rules.
import { districts } from "../data/settings.json";

export const PHONE_RE = /^[6-9]\d{7}$/;
export const DISTRICT_IDS: readonly string[] = districts.map((d) => d.id);
export const CITIES = ["ub", "countryside"] as const;
export const PAYMENTS = ["bank", "qpay", "wire"] as const;
export type City = (typeof CITIES)[number];
export type Payment = (typeof PAYMENTS)[number];

export const LIMITS = {
  name: [2, 80],
  province: [2, 80],
  khoroo: 40,
  address: [5, 300],
  note: 300,
  items: [1, 30],
  qty: [1, 10],
} as const;

/** Keys of `checkout.errors.*` that a field can show. */
export type FieldErrorKey =
  | "required" | "name" | "phone" | "district" | "province" | "address" | "tooLong" | "payment"
  | "turnstile" | "turnstileMissing" | "paymentDisabled";

export interface OrderFormValues {
  name: string;
  phone: string;
  phone2: string;
  city: string;
  district: string;
  khoroo: string;
  address: string;
  note: string;
  payment: string;
}
export type OrderField = keyof OrderFormValues;
export type FormErrors = Partial<Record<OrderField | "turnstile", FieldErrorKey>>;

/** Field order, used to focus the first invalid one. */
export const FIELD_ORDER: (OrderField | "turnstile")[] = [
  "name", "phone", "phone2", "city", "district", "khoroo", "address", "note", "payment", "turnstile",
];

/** Returns `{ field: errorKey }` for every invalid field (empty object = valid). */
export function validateOrderForm(v: OrderFormValues): FormErrors {
  const e: FormErrors = {};
  const name = v.name.trim();
  if (!name) e.name = "required";
  else if (name.length < LIMITS.name[0]) e.name = "name";
  else if (name.length > LIMITS.name[1]) e.name = "tooLong";

  const phone = v.phone.trim();
  if (!phone) e.phone = "required";
  else if (!PHONE_RE.test(phone)) e.phone = "phone";

  const phone2 = v.phone2.trim();
  if (phone2 && !PHONE_RE.test(phone2)) e.phone2 = "phone";

  if (!(CITIES as readonly string[]).includes(v.city)) e.city = "required";

  const district = v.district.trim();
  if (v.city === "ub") {
    if (!DISTRICT_IDS.includes(district)) e.district = "district";
  } else if (v.city === "countryside") {
    if (district.length < LIMITS.province[0]) e.district = "province";
    else if (district.length > LIMITS.province[1]) e.district = "tooLong";
  }

  if (v.khoroo.trim().length > LIMITS.khoroo) e.khoroo = "tooLong";

  const address = v.address.trim();
  if (address.length < LIMITS.address[0]) e.address = "address";
  else if (address.length > LIMITS.address[1]) e.address = "tooLong";

  if (v.note.trim().length > LIMITS.note) e.note = "tooLong";

  if (!(PAYMENTS as readonly string[]).includes(v.payment)) e.payment = "payment";
  return e;
}
