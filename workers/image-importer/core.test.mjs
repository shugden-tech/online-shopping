import test from 'node:test';
import assert from 'node:assert/strict';
import { createImporter } from './core.mjs';

function fixture(sourceBytes = Uint8Array.from([255, 216, 255, 224, 0, 16, 0, 1]), expectedHash) {
  const objects = new Map();
  let reads = 0, writes = 0;
  const source = 'https://source.example/image.jpg';
  const base = 'https://images.example';
  const worker = createImporter([{ name: 'dior-sauvage-edp_front', source, expected_sha256: expectedHash }], async url => {
    reads++;
    if (url === source) return new Response(sourceBytes, { headers: { 'content-type': 'image/jpeg' } });
    const object = objects.get(new URL(url).pathname.slice(1));
    return object ? new Response(object.bytes) : new Response('missing', { status: 404 });
  });
  const env = { MIGRATION_TOKEN: 'test-token', PUBLIC_IMAGE_BASE_URL: base, IMAGES: {
    async head(key) { return objects.get(key) ?? null; },
    async put(key, bytes, options) { writes++; objects.set(key, { bytes: bytes.slice(0), ...options }); },
  } };
  const request = (name = 'dior-sauvage-edp_front', token = 'test-token') => new Request('https://worker.example/import', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  return { worker, env, request, objects, counts: () => ({ reads, writes }) };
}

test('copies source bytes remotely, names correctly, verifies public URL, and resumes', async () => {
  const f = fixture();
  const first = await f.worker.fetch(f.request(), f.env);
  assert.equal(first.status, 200);
  const data = await first.json();
  assert.equal(data.key, 'dior-sauvage-edp_front.jpg');
  assert.equal(data.url, 'https://images.example/dior-sauvage-edp_front.jpg');
  assert.match(data.sha256, /^[a-f0-9]{64}$/);
  const second = await f.worker.fetch(f.request(), f.env);
  assert.equal((await second.json()).reused, true);
  assert.deepEqual(f.counts(), { reads: 3, writes: 1 });
});

test('rejects unauthorized or unlisted sources before any fetch/write', async () => {
  const f = fixture();
  assert.equal((await f.worker.fetch(f.request(undefined, 'wrong-token'), f.env)).status, 401);
  assert.equal((await f.worker.fetch(f.request('arbitrary-image_front'), f.env)).status, 404);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('rejects an HTML error page even when it claims to be a JPEG', async () => {
  const f = fixture(new TextEncoder().encode('<html>Access denied</html>'));
  assert.equal((await f.worker.fetch(f.request(), f.env)).status, 502);
  assert.equal(f.counts().writes, 0);
});

test('uses actual PNG bytes for the file extension instead of the source URL', async () => {
  const f = fixture(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
  assert.equal((await (await f.worker.fetch(f.request(), f.env)).json()).key, 'dior-sauvage-edp_front.png');
});

test('does not overwrite an existing object from another source', async () => {
  const f = fixture();
  f.objects.set('dior-sauvage-edp_front.jpg', { customMetadata: { source: 'https://other.example/different.jpg' } });
  assert.equal((await f.worker.fetch(f.request(), f.env)).status, 409);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('does not store image bytes that differ from the reviewed source', async () => {
  const f = fixture(undefined, '0'.repeat(64));
  const response = await f.worker.fetch(f.request(), f.env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /visually reviewed/);
  assert.equal(f.counts().writes, 0);
});
