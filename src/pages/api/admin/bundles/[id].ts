// GET    /api/admin/bundles/{id}  [catalog.read]   -> { ok, bundle } | 404
// PATCH  /api/admin/bundles/{id}  [catalog.write]  any field of the create body except id (items replaces all parts)
// DELETE /api/admin/bundles/{id}  [catalog.write]  -> { ok } (past orders keep their own copy)
// Contract: docs/CONTRACTS.md §9 (0005).
import { adminRoute, pathParam } from "../../../../lib/catalog/route";
import { bundleErrors, bundlePatchSchema, deleteBundle, patchBundle } from "../../../../lib/bundles/admin";
import { getBundle } from "../../../../lib/bundles/store";
import { BUNDLE_ID_RE } from "../../../../lib/bundles/types";
import { fail, json, readJson } from "../../../../lib/server";
import { getSettings } from "../../../../lib/settings";

export const prerender = false;

const idOf = (v: string | undefined) => {
  const id = pathParam(v);
  return id && BUNDLE_ID_RE.test(id) ? id : null;
};

export const GET = adminRoute("admin/bundles/id", "catalog.read", async ({ params }, env) => {
  const id = idOf(params.id);
  if (!id) return fail(404, { id: "not_found" });
  const settings = await getSettings(env.DB);
  const bundle = await getBundle(env.DB, id, settings["checkout.open"] === true);
  return bundle ? json(200, { ok: true, bundle }) : fail(404, { id: "not_found" });
});

export const PATCH = adminRoute("admin/bundles/id", "catalog.write", async ({ params, request }, env, s) => {
  const id = idOf(params.id);
  if (!id) return fail(404, { id: "not_found" });
  const body = await readJson(request, 32 * 1024);
  if (body instanceof Response) return body;
  const parsed = bundlePatchSchema(env.PUBLIC_MEDIA_BASE).safeParse(body.value);
  if (!parsed.success) return fail(400, bundleErrors(parsed.error.issues));
  const r = await patchBundle(env.DB, s.actor, id, parsed.data);
  if ("notFound" in r) return fail(404, { id: "not_found" });
  if ("errors" in r && r.errors) return fail(400, r.errors);
  return json(200, { ok: true, bundle: r.bundle });
});

export const DELETE = adminRoute("admin/bundles/id", "catalog.write", async ({ params }, env, s) => {
  const id = idOf(params.id);
  if (!id) return fail(404, { id: "not_found" });
  return (await deleteBundle(env.DB, s.actor, id)) ? json(200, { ok: true }) : fail(404, { id: "not_found" });
});
