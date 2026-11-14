// Dev server for this site: `node server.mjs [PORT]` serves public/. "/" is index.html, "/name" is name.html.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "public");
const port = Number(process.argv[2] ?? process.env.PORT ?? 5320);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

/** The file under public/ for a URL path ("/" -> index.html, "/about" -> about.html); a leading ".." is clamped. */
export function fileFor(urlPath) {
  const path = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^([/\\])+/, "");
  if (!path) return "index.html";
  return extname(path) ? path : `${path}.html`;
}

if (process.argv[1] && import.meta.filename === normalize(process.argv[1]))
  createServer(async (req, res) => {
    const file = fileFor(req.url ?? "/");
    try {
      const body = await readFile(join(root, file));
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    }
  }).listen(port, "127.0.0.1", () => console.log(`site on http://127.0.0.1:${port}`));
