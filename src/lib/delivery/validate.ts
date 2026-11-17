// Request body schemas for the delivery admin routes (server-only: imports zod).
import { z } from "astro/zod";
import { SHIPMENT_STATUSES } from "../contracts";
import { PROVIDER_ID_RE } from "./registry";

const ORDER_NO_RE = /^GZ-\d{6}-[A-Z2-9]{4}$/;

export const createSchema = z
  .object({
    orderNo: z.string().trim().toUpperCase().regex(ORDER_NO_RE),
    provider: z.string().regex(PROVIDER_ID_RE).optional(),
  })
  .strict();

const trackingNo = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 ._/-]+$/).nullable();
const trackingUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith("https://"), "https only")
  .nullable();

export const patchSchema = z
  .object({
    status: z.enum(SHIPMENT_STATUSES).optional(),
    trackingNo: trackingNo.optional(),
    trackingUrl: trackingUrl.optional(),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "empty" });

/** zod issues -> { field: code } for fail(). */
export function zodErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[String(i.path[0] ?? "form")] ??= i.code === "unrecognized_keys" ? "unknown" : "invalid";
  return out;
}
