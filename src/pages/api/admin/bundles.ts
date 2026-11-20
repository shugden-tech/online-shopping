// GET  /api/admin/bundles   [catalog.read]   -> { ok, items: BundleView[] }   (all statuses, by sort)
// POST /api/admin/bundles   [catalog.write]  create -> 201 { ok, bundle } | 409 { id: "taken" }
// Contract: docs/CONTRACTS.md §9 (0005).
import { adminRoute } from "../../../lib/catalog/route";
import { bundleCreateSchema, bundleErrors, createBundle } from "../../../lib/bundles/admin";
import { listBundles } from "../../../lib/bundles/store";
import { fail, json, readJson } from "../../../lib/server";
import { getSettings } from "../../../lib/settings";

export const prerender = false;

export const GET = adminRoute("admin/bundles", "catalog.read", async (_ctx, env) => {
  const settings = await getSettings(env.DB);
  const items = await listBundles(env.DB, { checkoutOpen: settings["checkout.open"] === true });
  return json(200, { ok: true, items });
});

export const POST = adminRoute("admin/bundles", "catalog.write", async ({ request }, env, s) => {
  const body = await readJson(request, 32 * 1024);
  if (body instanceof Response) return body;
  const parsed = bundleCreateSchema(env.PUBLIC_MEDIA_BASE).safeParse(body.value);
  if (!parsed.success) return fail(400, bundleErrors(parsed.error.issues));
  const r = await createBundle(env.DB, s.actor, parsed.data);
  if ("conflict" in r) return fail(409, { id: "taken" });
  return json(201, { ok: true, bundle: r.bundle });
});
