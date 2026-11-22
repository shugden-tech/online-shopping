// Images move source -> Cloudflare Worker -> R2, never through this process.
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} requires a value`);
  return args[i + 1];
};
const catalogFile = path.join(root, 'decantx/selected-1000.json');
const mapFile = path.join(root, 'decantx/catalog-r2-images.json');
const output = path.join(root, 'output/r2-image-upload');
const config = path.join(root, 'workers/image-importer/wrangler.jsonc');
const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};
const atomicJson = async (file, value) => {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  // Windows indexers/scanners can briefly hold the destination without delete sharing.
  for (let attempt = 0; ; attempt++) {
    try { await rename(`${file}.tmp`, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 11) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
};
const catalog = await readJson(catalogFile);
if (catalog.length !== 1000 || new Set(catalog.map(p => p.id)).size !== 1000) throw Error('Expected 1,000 unique catalog products');
const mapping = await readJson(mapFile, {});
const photoOverrides = await readJson(path.join(root, 'decantx/back-photo-overrides.json'), {});
const manifest = [];
let missing = 0;
for (const p of catalog) for (const kind of ['front', 'back']) {
  const name = `${p.id}_${kind}`;
  const override = photoOverrides[name];
  if (override && (!override.reviewed || !override.bottle_and_box || !/^[a-f0-9]{64}$/.test(override.sha256))) throw Error(`Unreviewed photo override: ${name}`);
  const current = override?.image ?? p.images[kind];
  if (!current) { missing++; continue; }
  const previous = mapping[name];
  const source = override?.image ?? (previous?.url === current ? previous.source : current);
  const u = new URL(source);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error(`Invalid source: ${name}`);
  if (!/^[a-z0-9-]+_(front|back)$/.test(name)) throw Error(`Invalid image name: ${name}`);
  manifest.push({ name, source, ...(override ? { expected_sha256: override.sha256 } : {}) });
}
console.log(JSON.stringify({ products: catalog.length, availableImages: manifest.length, missingImages: missing, verifiedMappings: Object.keys(mapping).length }, null, 2));

if (args.includes('--prepare')) {
  await atomicJson(path.join(root, 'workers/image-importer/manifest.json'), manifest);
  console.log('Prepared Cloudflare source manifest; no image files downloaded.');
}
if (args.includes('--set-token')) {
  await mkdir(output, { recursive: true });
  const tokenFile = path.join(output, 'token');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { flag: 'wx' });
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'MIGRATION_TOKEN', '--config', config], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`Secret setup failed (${code})`)));
    child.stdin.end(token);
  });
}
if (!args.includes('--write')) process.exit(0);
const endpoint = option('--worker-url');
const base = option('--base-url')?.replace(/\/+$/, '');
const limit = Number(option('--limit') ?? Infinity);
const concurrency = Number(option('--concurrency') ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('--concurrency must be between 1 and 4');
if (!endpoint || !base || !(limit > 0) || (Number.isFinite(limit) && !Number.isInteger(limit))) throw Error('--write requires --worker-url and --base-url, and a positive --limit if specified');
for (const value of [endpoint, base]) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('Use public HTTPS URLs without credentials/query/hash');
}
const token = process.env.R2_MIGRATION_TOKEN || (await readFile(path.join(output, 'token'), 'utf8')).trim();
if (!token) throw Error('Migration token is missing');
await mkdir(output, { recursive: true });
await copyFile(catalogFile, path.join(output, `catalog-backup-${Date.now()}.json`));
// Recover the catalog if a previous run stopped between mapping and catalog writes.
for (const p of catalog) for (const kind of ['front', 'back']) {
  const saved = mapping[`${p.id}_${kind}`];
  if (saved?.source === p.images[kind] && saved.url?.startsWith(base + '/')) p.images[kind] = saved.url;
}
await atomicJson(catalogFile, catalog);
const jobs = manifest.filter(row => mapping[row.name]?.source !== row.source || !mapping[row.name]?.url?.startsWith(base + '/')).slice(0, limit);
const failures = [];
let uploaded = 0;
let nextJob = 0;
let stopped = false;
let checkpoints = Promise.resolve();
async function runQueue() {
while (!stopped && nextJob < jobs.length) {
  const i = nextJob++;
  const row = jobs[i];
  try {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(new URL('/import', endpoint), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name: row.name }), signal: AbortSignal.timeout(100000),
        });
        break;
      } catch (error) {
        if (attempt === 2) throw Error(`STOP: Worker connection failed (${error.cause?.code || error.message})`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
    const result = await response.json();
    if (!response.ok) {
      if ([401, 403, 503].includes(response.status)) throw Error(`STOP: ${result.error || response.status}`);
      throw Error(result.error || `Worker HTTP ${response.status}`);
    }
    if (result.name !== row.name || result.source !== row.source || !/^[a-f0-9]{64}$/.test(result.sha256) || result.url !== `${base}/${result.key}` || !result.key.startsWith(row.name + '.')) throw Error('Worker result did not match the requested image');
    // Only requests overlap. JSON checkpoints are serialized to avoid lost updates.
    checkpoints = checkpoints.then(async () => {
      mapping[row.name] = result;
      const kind = row.name.endsWith('_front') ? 'front' : 'back';
      const id = row.name.slice(0, -(kind.length + 1));
      catalog.find(p => p.id === id).images[kind] = result.url;
      try {
        await atomicJson(mapFile, mapping);
        await atomicJson(catalogFile, catalog);
      } catch (error) { throw Error(`STOP: JSON checkpoint failed: ${error.message}`); }
    });
    await checkpoints;
    uploaded++;
    console.log(`[${i + 1}/${jobs.length}] ${result.reused ? 'verified existing' : 'uploaded'} ${result.key}`);
  } catch (error) {
    failures.push({ name: row.name, error: error.message });
    console.error(`[${i + 1}/${jobs.length}] ${row.name}: ${error.message}`);
    if (error.message.startsWith('STOP:')) stopped = true;
  }
}
}
await Promise.all(Array.from({ length: concurrency }, () => runQueue()));
await atomicJson(path.join(output, 'failures.json'), failures);
console.log(JSON.stringify({ uploadedThisRun: uploaded, failedThisRun: failures.length, verifiedTotal: Object.keys(mapping).length, missingSourceImages: missing }, null, 2));
if (failures.length) process.exitCode = 1;
