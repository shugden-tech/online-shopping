// Server-side order schema (zod). Same rules as validateOrderForm() in ./order-validate.ts.
// Error messages ARE the `checkout.errors.*` keys, so the API can return them as-is.
// Do not import this file from an island: it would bundle zod into the browser.
import { z } from "astro/zod";
import { CITIES, DISTRICT_IDS, LIMITS, PAYMENTS, PHONE_RE } from "./order-validate";

const req = { required_error: "required", invalid_type_error: "required" };
const optionalText = (max: number) => z.string(req).trim().max(max, "tooLong").optional().default("");

const item = z.object({
  slug: z.string(req).trim().min(1).max(100),
  ml: z.number(req).int().positive().max(1000),
  qty: z.number(req).int().min(LIMITS.qty[0]).max(LIMITS.qty[1]),
  // anything else the client sends (price, name, ...) is stripped and ignored
});

export const orderSchema = z
  .object({
    name: z.string(req).trim().min(1, "required").min(LIMITS.name[0], "name").max(LIMITS.name[1], "tooLong"),
    phone: z.string(req).trim().min(1, "required").regex(PHONE_RE, "phone"),
    phone2: z
      .string(req)
      .trim()
      .optional()
      .default("")
      .refine((v) => v === "" || PHONE_RE.test(v), "phone"),
    city: z.enum(CITIES, { errorMap: () => ({ message: "required" }) }),
    district: z.string(req).trim().max(LIMITS.province[1], "tooLong"),
    khoroo: optionalText(LIMITS.khoroo),
    address: z.string(req).trim().min(LIMITS.address[0], "address").max(LIMITS.address[1], "tooLong"),
    note: optionalText(LIMITS.note),
    payment: z.enum(PAYMENTS, { errorMap: () => ({ message: "payment" }) }),
    locale: z.enum(["mn", "en"], { errorMap: () => ({ message: "required" }) }),
    items: z.array(item, req).min(LIMITS.items[0], "items").max(LIMITS.items[1], "items"),
    turnstileToken: z.string({ required_error: "turnstileMissing", invalid_type_error: "turnstileMissing" }).min(1, "turnstileMissing").max(4096, "turnstile"),
    website: z.string().optional().default(""), // honeypot: checked by the API after validation
  })
  .superRefine((v, ctx) => {
    if (v.city === "ub" && !DISTRICT_IDS.includes(v.district)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["district"], message: "district" });
    }
    if (v.city === "countryside" && v.district.length < LIMITS.province[0]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["district"], message: "province" });
    }
  });

export type OrderInput = z.infer<typeof orderSchema>;

const KNOWN = new Set([
  "required", "name", "phone", "district", "province", "address", "tooLong", "payment",
  "turnstile", "turnstileMissing", "items",
]);

/** zod issues -> `{ field: errorKey }`; item problems become `{ form: "items" }`. */
export function issuesToErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const top = String(issue.path[0] ?? "form");
    const msg = KNOWN.has(issue.message) ? issue.message : "required";
    if (top === "items") {
      out.form ??= "items";
      continue;
    }
    const field = top === "turnstileToken" ? "turnstile" : top;
    out[field] ??= msg;
  }
  return out;
}
