// Exceptional fallback for a reviewed public photo blocked from Worker egress.
// Source bytes stay in RAM and are piped to R2; no image file is created.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = async p => JSON.parse(await readFile(path.join(root, p), 'utf8'));
const name = process.argv[2];
if (!/^[a-z0-9-]+_back$/.test(name ?? '')) throw Error('Specify a reviewed back-photo name');
const overrides = await read('decantx/back-photo-overrides.json');
const approved = overrides[name];
if (!approved?.reviewed || !approved.bottle_and_box || !/^[a-f0-9]{64}$/.test(approved.sha256)) throw Error('Photo has not been visually approved');
const config = await read('workers/image-importer/wrangler.jsonc');
const response = await fetch(approved.image, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' }, signal: AbortSignal.timeout(45000) });
if (!response.ok) throw Error(`Source HTTP ${response.status}`);
if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw Error('Image exceeds 10 MB');
const bytes = Buffer.from(await response.arrayBuffer());
const hash = b => createHash('sha256').update(b).digest('hex');
if (bytes.length > 10 * 1024 * 1024 || hash(bytes) !== approved.sha256) throw Error('Source bytes differ from the visually approved photo');
if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw Error('This fallback currently accepts JPEG only');
const key = `${name}.jpg`;
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'r2', 'object', 'put', `${config.r2_buckets[0].bucket_name}/${key}`, '--remote', '--pipe', '--content-type', 'image/jpeg', '--cache-control', 'public, max-age=31536000, immutable'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(Error(`Upload exited ${code}`)));
  child.stdin.end(bytes);
});
const url = `${config.vars.PUBLIC_IMAGE_BASE_URL.replace(/\/+$/, '')}/${key}`;
const verify = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!verify.ok || hash(Buffer.from(await verify.arrayBuffer())) !== approved.sha256) throw Error('Public R2 verification failed');
const mapping = await read('decantx/catalog-r2-images.json');
mapping[name] = { name, key, source: approved.image, url, sha256: approved.sha256, verified_at: new Date().toISOString(), reused: false, transfer: 'memory-relay' };
const catalog = await read('decantx/selected-1000.json');
catalog.find(p => p.id === name.slice(0, -5)).images.back = url;
for (const [file, value] of [['decantx/catalog-r2-images.json', mapping], ['decantx/selected-1000.json', catalog]]) {
  const target = path.join(root, file);
  await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${target}.tmp`, target);
}
console.log(JSON.stringify({ uploaded: key, verified: true, imageFileCreated: false, url }, null, 2));
