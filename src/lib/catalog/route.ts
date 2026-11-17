// A1 catalog: shared wrapper for admin routes — env check, authorize(permission), error -> 500.
import type { APIContext, APIRoute } from "astro";
import { authorize, type AdminSession } from "../auth";
import type { Permission } from "../contracts";
import { clientIp, fail } from "../server";

export type AdminHandler = (ctx: APIContext, env: Env, session: AdminSession) => Promise<Response>;

export function adminRoute(tag: string, permission: Permission, handler: AdminHandler): APIRoute {
  return async (ctx) => {
    try {
      const env = ctx.locals.runtime?.env;
      if (!env?.DB) throw new Error("D1 binding DB is missing");
      const s = await authorize(ctx.request, env, clientIp(ctx.request, () => ctx.clientAddress), permission);
      if (s instanceof Response) return s;
      return await handler(ctx, env, s);
    } catch (err) {
      console.error(`[${tag}]`, err);
      return fail(500, { form: "server" });
    }
  };
}

/** Decodes a path parameter once ("a%3A5" -> "a:5"); null when it is not valid percent-encoding. */
export function pathParam(v: string | undefined): string | null {
  if (v === undefined) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}
