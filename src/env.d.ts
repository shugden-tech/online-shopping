/// <reference path="../.astro/types.d.ts" />

type D1Database = import("@cloudflare/workers-types").D1Database;

interface Env {
  DB: D1Database;
  TURNSTILE_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Bearer token for /api/admin/* and the /admin page (Worker secret, at least 24 characters) -> role "owner". */
  ADMIN_TOKEN?: string;
  /** Optional second token -> role "staff" (fewer permissions, see ROLE_PERMISSIONS). */
  STAFF_TOKEN?: string;
  /** Public site origin, e.g. https://genzst.mn — used to build payment callback URLs. */
  PUBLIC_SITE_URL?: string;
  /** R2 bucket for product photos uploaded from the admin (front/back). */
  MEDIA?: import("@cloudflare/workers-types").R2Bucket;
  /** Public base URL of the MEDIA bucket, e.g. https://pub-xxxx.r2.dev (no trailing slash). */
  PUBLIC_MEDIA_BASE?: string;
  /** QPay merchant API v2. Base URL is a var (sandbox or production); the rest are secrets. */
  QPAY_BASE_URL?: string;
  QPAY_USERNAME?: string;
  QPAY_PASSWORD?: string;
  QPAY_INVOICE_CODE?: string;
  /** HMAC key that signs the callback URL given to QPay (the callback is still verified with payment/check). */
  QPAY_CALLBACK_SECRET?: string;
  /** Delivery company API (adapter chosen by the `delivery.provider` setting). */
  DELIVERY_BASE_URL?: string;
  DELIVERY_API_KEY?: string;
  DELIVERY_WEBHOOK_SECRET?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
