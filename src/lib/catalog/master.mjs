/** Validate the public, facts-only R2 snapshot before building pages or importing D1. */
export function validateMasterCatalog(value, mediaBase) {
  const origin = new URL(mediaBase).origin;
  const fields = ["id", "brand", "name", "concentration", "bottle_sizes_ml", "release_year", "notes", "images"];
  const concentrations = [null, "EDT", "EDP", "Parfum", "Extrait", "Cologne"];
  const ids = new Set();
  const fail = (id, message) => { throw new Error(`Catalog ${id}: ${message}`); };
  if (!Array.isArray(value) || !value.length) fail("snapshot", "expected a nonempty array");
  for (const p of value) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id) || p.id.length > 120) fail("record", "invalid id");
    if (ids.has(p.id)) fail(p.id, "duplicate id");
    ids.add(p.id);
    if (Object.keys(p).length !== fields.length || fields.some((k) => !Object.hasOwn(p, k))) fail(p.id, "unexpected or missing public fields");
    if (![p.brand, p.name].every((s) => typeof s === "string" && s.trim())) fail(p.id, "brand and name required");
    if (!concentrations.includes(p.concentration)) fail(p.id, "invalid concentration");
    if (p.release_year !== null && (!Number.isInteger(p.release_year) || p.release_year < 1800 || p.release_year > new Date().getUTCFullYear())) fail(p.id, "invalid release year");
    if (p.bottle_sizes_ml !== null && (!Array.isArray(p.bottle_sizes_ml) || !p.bottle_sizes_ml.length || new Set(p.bottle_sizes_ml).size !== p.bottle_sizes_ml.length || !p.bottle_sizes_ml.every((ml) => Number.isInteger(ml) && ml >= 15 && ml <= 2000))) fail(p.id, "invalid retail bottle sizes");
    if (!p.notes || Object.keys(p.notes).sort().join(",") !== "base,heart,top") fail(p.id, "invalid note tiers");
    for (const tier of ["top", "heart", "base"]) {
      const notes = p.notes[tier];
      if (!Array.isArray(notes) || new Set(notes).size !== notes.length || !notes.every((s) => typeof s === "string" && s.trim() && s.length <= 65)) fail(p.id, "invalid notes");
    }
    if (!p.images || Object.keys(p.images).sort().join(",") !== "back,front") fail(p.id, "invalid image slots");
    for (const side of ["front", "back"]) {
      const image = p.images[side];
      if (image === null) continue;
      if (typeof image !== "string") fail(p.id, "invalid image URL");
      let url;
      try { url = new URL(image); } catch { fail(p.id, "invalid image URL"); }
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) fail(p.id, "image is outside the configured R2 host");
    }
  }
  return value;
}

/** Stable IDs only. A different concentration is a different perfume. */
export function catalogPhotos(product, catalogById) {
  const record = catalogById.get(product.slug);
  if (!record || product.image) return product;
  if (record.concentration !== null && record.concentration !== product.concentration) throw new Error(`Catalog concentration mismatch: ${product.slug}`);
  return {
    ...product,
    photos: {
      ...(record.images.front ? { front: record.images.front } : {}),
      ...(record.images.back ? { back: record.images.back } : {}),
    },
  };
}
