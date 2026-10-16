// Serves the static export (out/) like FastAPI does: real files first, index.html for everything else.
// /api/* is never served here; the tests mock it per page.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] || "out");
const port = Number(process.argv[3] || 4173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".txt": "text/plain", ".json": "application/json" };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/api/")) { res.writeHead(404).end(); return; }
  let file = normalize(join(root, path));
  try { if (!file.startsWith(root) || !statSync(file).isFile()) file = join(root, "index.html"); }
  catch { file = join(root, "index.html"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on :${port}`));
