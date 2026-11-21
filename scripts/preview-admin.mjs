// Local UI preview: static build + in-memory sample API. No Cloudflare, DB or secrets.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMock, OWNER_TOKEN, MEDIA, PNG } from "./lib/admin-preview-fixtures.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
try { await stat(resolve(dist, "admin/index.html")); }
catch { console.error("Run npm.cmd run build first, then npm.cmd run preview:admin."); process.exit(1); }
const mock = makeMock();
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/admin/")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 6 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      await mock.handle({
        request: () => ({
          url: () => url.href, method: () => req.method,
          headers: () => ({ ...req.headers, authorization: `Bearer ${OWNER_TOKEN}` }),
          postDataBuffer: () => chunks.length ? Buffer.concat(chunks) : null,
        }),
        fulfill: ({ status, contentType, headers, body }) => {
          res.writeHead(status, { "Content-Type": contentType, ...headers });
          res.end(body.replaceAll(MEDIA, "/__preview/media"));
        },
      });
      return;
    }
    if (url.pathname.startsWith("/__preview/media/")) { res.writeHead(200, { "Content-Type": "image/png" }).end(PNG); return; }
    if (url.pathname === "/") { res.writeHead(302, { Location: "/admin/" }).end(); return; }
    const file = resolve(dist, "." + decodeURIComponent(url.pathname));
    const rel = relative(dist, file);
    if (rel.startsWith("..") || isAbsolute(rel)) { res.writeHead(403).end(); return; }
    const info = await stat(file);
    const target = info.isDirectory() ? resolve(file, "index.html") : file;
    let data = await readFile(target);
    if (url.pathname === "/admin/" || url.pathname === "/admin" || url.pathname === "/admin/index.html") {
      data = data.toString().replace("<head>", `<head><script>sessionStorage.setItem("gz-admin-token",${JSON.stringify(OWNER_TOKEN)});</script>`)
        .replace(/(<body[^>]*>)/, '$1<aside style="padding:10px 16px;background:#fff0c2;color:#5d4100;font:13px/1.5 sans-serif;text-align:center">UI preview · Жишээ өгөгдөл · DB холболтгүй · Өөрчлөлтүүд серверийг дахин асаахад арилна</aside>');
    }
    res.writeHead(200, { "Content-Type": types[extname(target)] ?? "application/octet-stream" }).end(data);
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
    res.end(err.code === "ENOENT" ? "Not found" : "Preview error");
  }
});
server.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
server.listen(Number(process.env.PORT ?? 8794), "127.0.0.1", () => {
  console.log(`Admin UI preview: http://127.0.0.1:${server.address().port}/admin/`);
  console.log("Sample data only. No database or login required. Ctrl+C to stop.");
});
