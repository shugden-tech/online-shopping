import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMasterCatalog, catalogPhotos } from "../src/lib/catalog/master.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const config = read("../src/data/backend.json");
const snapshot = read("../data/catalog/catalog.json");

test("the actual R2 snapshot has unique IDs and only public facts", () => {
  assert.equal(validateMasterCatalog(snapshot, config.mediaBase).length, 1000);
  assert.equal(snapshot.filter((p) => p.images.front).length, 982);
  assert.equal(snapshot.filter((p) => p.images.back).length, 1000);
});
test("reject bad snapshots instead of accepting incorrect catalog data", () => {
  for (const change of [
    (p) => { p.price = 99000; },
    (p) => { p.images.front = "https://other.example/wrong.jpg"; },
    (p) => { p.notes.top = ["one", "one"]; },
    (p) => { p.bottle_sizes_ml = [5]; },
    (p) => { p.concentration = "unknown"; },
  ]) {
    const data = structuredClone(snapshot.slice(0, 1));
    change(data[0]);
    assert.throws(() => validateMasterCatalog(data, config.mediaBase));
  }
  assert.throws(() => validateMasterCatalog([snapshot[0], snapshot[0]], config.mediaBase));
});
test("stable IDs select the right images, preserve nulls and reject concentration changes", () => {
  const p = { slug: "mugler-alien-edp", concentration: "EDP", photos: { front: "/old.jpg" } };
  const map = new Map(snapshot.map((p) => [p.id, p]));
  assert.equal(catalogPhotos(p, map).photos.front, map.get(p.slug).images.front);
  assert.throws(() => catalogPhotos({ ...p, concentration: "EDT" }, map));
  assert.equal(catalogPhotos({ ...p, slug: "missing-product" }, map).photos.front, "/old.jpg");
  const record = structuredClone(map.get(p.slug));
  record.images.front = null;
  const result = catalogPhotos(p, new Map([[p.slug, record]]));
  assert.equal(result.photos.front, undefined);
  assert.equal(result.photos.back, record.images.back);
  assert.equal(catalogPhotos({ ...p, image: "/owner.jpg" }, map).image, "/owner.jpg");
});
