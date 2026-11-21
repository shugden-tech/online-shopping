// Public export contains only verified R2 image URLs (or null), never failed source URLs.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const catalog = await read('decantx/selected-1000.json');
const mapping = await read('decantx/catalog-r2-images.json');
const config = await read('workers/image-importer/wrangler.jsonc');
const base = config.vars.PUBLIC_IMAGE_BASE_URL.replace(/\/+$/, '');
if (!base.startsWith('https://')) throw Error('Public R2 base URL is missing');
if (catalog.length !== 1000 || new Set(catalog.map(p => p.id)).size !== 1000) throw Error('Expected exactly 1,000 unique products');
const fields = ['id', 'brand', 'name', 'concentration', 'bottle_sizes_ml', 'release_year', 'notes', 'images'];
const missing = [];
let front = 0, back = 0;
for (const p of catalog) {
  if (Object.keys(p).length !== fields.length || fields.some(field => !(field in p))) throw Error(`Unexpected public fields: ${p.id}`);
  for (const kind of ['front', 'back']) {
    const name = `${p.id}_${kind}`;
    const entry = mapping[name];
    const extension = entry?.key?.slice(name.length);
    if (entry && entry.name === name && ['.jpg', '.png', '.webp', '.gif', '.avif'].includes(extension)
      && entry.url === `${base}/${entry.key}` && /^[a-f0-9]{64}$/.test(entry.sha256) && entry.verified_at
      && [entry.source, entry.url].includes(p.images[kind])) {
      p.images[kind] = entry.url;
      if (kind === 'front') front++; else back++;
    } else {
      missing.push({ id: p.id, kind, reason: p.images[kind] ? 'upload_failed' : 'missing_source' });
      p.images[kind] = null;
    }
  }
}
const report = {
  exported_at: new Date().toISOString(), products: catalog.length, public_catalog_url: `${base}/catalog.json`,
  uploaded_images: front + back, front_images: front, back_images: back,
  missing_source_images: missing.filter(p => p.reason === 'missing_source').length,
  failed_upload_images: missing.filter(p => p.reason === 'upload_failed').length,
  missing_images: missing,
};
await writeFile(path.join(root, 'decantx/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
await writeFile(path.join(root, 'decantx/r2-upload-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, missing_images: missing.length }, null, 2));
