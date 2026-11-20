const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const MAX_BYTES = 10 * 1024 * 1024;
const json = (value, status = 200) => Response.json(value, { status });
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');

function imageType(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return 'png';
  const start = new TextDecoder().decode(b.slice(0, 32));
  if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') return 'webp';
  if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) return 'gif';
  if (start.slice(4, 8) === 'ftyp' && /avif|avis/.test(start.slice(8))) return 'avif';
  throw Error('Source bytes are not a supported raster image');
}

async function boundedBytes(response) {
  if (!response.ok) { await response.body?.cancel(); throw Error(`Image HTTP ${response.status}`); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel(); throw Error('Image exceeds 10 MB');
  }
  if (!response.body) throw Error('Empty image response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error('Image exceeds 10 MB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

/** Sources are embedded at deployment. Requests cannot supply arbitrary URLs. */
export function createImporter(manifest, fetchImage = fetch) {
  const allowed = new Map(manifest.map(row => [row.name, row]));
  return {
    async fetch(request, env) {
      if (!env.MIGRATION_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MIGRATION_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/import') return json({ error: 'Use POST /import' }, 405);
      let input;
      try { input = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!input || typeof input.name !== 'string') return json({ error: 'Missing image name' }, 400);
      const row = allowed.get(input.name);
      if (!row) return json({ error: 'Image is not in the selected catalog' }, 404);
      const base = env.PUBLIC_IMAGE_BASE_URL?.replace(/\/+$/, '');
      if (!base || !base.startsWith('https://')) return json({ error: 'Public image URL is not configured' }, 503);
      try {
        // Reuse only an object belonging to this exact catalog source.
        let key, digest, reused = false;
        for (const ext of ['jpg', 'png', 'webp', 'gif', 'avif']) {
          const candidate = `${row.name}.${ext}`;
          const existing = await env.IMAGES.head(candidate);
          if (!existing) continue;
          if (existing.customMetadata?.source !== row.source) return json({ error: `Existing object has a different source: ${candidate}` }, 409);
          key = candidate;
          digest = existing.customMetadata?.sha256;
          if (!digest) return json({ error: 'Existing object has no verification hash' }, 409);
          reused = true;
          break;
        }
        if (!key) {
          const response = await fetchImage(row.source, { signal: AbortSignal.timeout(45000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' } });
          const bytes = await boundedBytes(response);
          const type = imageType(bytes);
          key = `${row.name}.${type === 'jpeg' ? 'jpg' : type}`;
          digest = await sha256(bytes);
          if (row.expected_sha256 && row.expected_sha256 !== digest) throw Error('Image bytes differ from the visually reviewed candidate');
          await env.IMAGES.put(key, bytes, {
            httpMetadata: { contentType: TYPES[type], cacheControl: 'public, max-age=31536000, immutable' },
            customMetadata: { source: row.source, sha256: digest },
          });
        }
        // Verification also runs on Cloudflare; image bytes never pass through the PC.
        const url = `${base}/${key}`;
        const published = await boundedBytes(await fetchImage(url, { signal: AbortSignal.timeout(30000) }));
        if (await sha256(published) !== digest) throw Error('Public image does not match the uploaded bytes');
        return json({ name: row.name, key, url, source: row.source, sha256: digest, reused, verified_at: new Date().toISOString() });
      } catch (error) {
        return json({ name: row.name, error: error.message }, 502);
      }
    },
  };
}
