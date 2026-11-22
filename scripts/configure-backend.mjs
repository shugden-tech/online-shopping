// Configures an existing D1 binding without creating/deleting any remote resources.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMasterCatalog } from "../src/lib/catalog/master.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const config = JSON.parse(read("src/data/backend.json"));
const catalog = validateMasterCatalog(JSON.parse(read("data/catalog/catalog.json")), config.mediaBase);
const file = new URL("wrangler.jsonc", root);
let wrangler = readFileSync(file, "utf8");
const databaseId = option("--database-id");
const databaseName = option("--database-name");
if (args.includes("--database-id") && (!databaseId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId))) throw new Error("Provide a real Cloudflare D1 database UUID.");
if (args.includes("--database-name") && (!databaseName || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(databaseName))) throw new Error("Invalid D1 database name.");
if (databaseName && !databaseId) throw new Error("Provide --database-id with --database-name.");
if (databaseId) {
  if (!/"database_id"\s*:\s*"[^"]+"/.test(wrangler)) throw new Error("DB binding not found.");
  wrangler = wrangler.replace(/("database_id"\s*:\s*)"[^"]+"/, `$1"${databaseId}"`);
  if (databaseName) wrangler = wrangler.replace(/("database_name"\s*:\s*)"[^"]+"/, `$1"${databaseName}"`);
  writeFileSync(file, wrangler);
  console.log("D1 binding saved locally. Remote resources have not been changed.");
}
const configuredId = /"database_id"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
const bucket = /"bucket_name"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
const mediaBase = /"PUBLIC_MEDIA_BASE"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
const products = readdirSync(new URL("src/content/products/", root)).filter((name) => name.endsWith(".json"));
const ids = new Set(catalog.map((p) => p.id));
console.log(JSON.stringify({
  catalogProducts: catalog.length,
  catalogFrontPhotos: catalog.filter((p) => p.images.front).length,
  catalogBackPhotos: catalog.filter((p) => p.images.back).length,
  storefrontProducts: products.length,
  exactR2Matches: products.filter((file) => ids.has(file.slice(0, -5))).length,
  mediaBucketAligned: bucket === config.mediaBucket,
  mediaBaseAligned: mediaBase === config.mediaBase,
  databaseConfigured: Boolean(configuredId && !/^0+-0+-0+-0+-0+$/.test(configuredId)),
}, null, 2));
if (bucket !== config.mediaBucket || mediaBase !== config.mediaBase) process.exitCode = 1;
if (!configuredId || /^0+-0+-0+-0+-0+$/.test(configuredId)) {
  console.error("D1 is not connected. Supply its ID: npm.cmd run backend:configure -- --database-id UUID [--database-name NAME]");
  process.exitCode = 2;
}
