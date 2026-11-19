// GET /api/store/info  (public; lead, 0004) -> { ok, contact: { phone, hours_mn, hours_en, instagram, facebook, telegram }, notice: { mn, en } }
// The owner's live contact details and store notice (admin settings). Empty strings = keep the built page's value.
// Cache-Control: public, max-age=60.
import type { APIRoute } from "astro";
import { fail, json } from "../../../lib/server";
import { getSettings } from "../../../lib/settings";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await getSettings(env.DB);
    return json(
      200,
      {
        ok: true,
        contact: {
          phone: s["contact.phone"], hours_mn: s["contact.hours_mn"], hours_en: s["contact.hours_en"],
          instagram: s["contact.instagram"], facebook: s["contact.facebook"], telegram: s["contact.telegram"],
        },
        notice: { mn: s["store.notice_mn"], en: s["store.notice_en"] },
      },
      { "Cache-Control": "public, max-age=60" },
    );
  } catch (err) {
    console.error("[store/info]", err);
    return fail(500, { form: "server" });
  }
};
