// Readiness checks use the actual bindings, never static preview fixtures.
import type { APIRoute } from "astro";
import { json } from "../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime?.env;
  const checks = await Promise.allSettled([
    env?.DB
      ? env.DB.prepare("SELECT (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM store_settings) AS settings").first()
      : Promise.reject(new Error("Missing DB binding")),
    env?.MEDIA ? env.MEDIA.head("catalog.json") : Promise.reject(new Error("Missing MEDIA binding")),
  ]);
  const database = checks[0].status === "fulfilled" && checks[0].value !== null;
  const media = checks[1].status === "fulfilled" && checks[1].value !== null;
  return json(database && media ? 200 : 503, { ok: database && media, services: { database, media } });
};
