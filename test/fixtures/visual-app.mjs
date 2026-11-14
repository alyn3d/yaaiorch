// A tiny app for the browser-check tests: `node visual-app.mjs PORT`. Pages:
//   /        a heading and a tab button that reveals #panel
//   /broken  renders, but throws an uncaught error, logs a console error, loads a missing script and overflows at 375px
//   /blank   an empty body
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.PORT ?? 4599);
const page = (body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title>` +
  `<style>body{font:16px system-ui;margin:24px}@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style>${head}</head><body>${body}</body></html>`;

const pages = {
  "/": page(
    `<h1 id="title">Fixture app</h1><button id="tab" onclick="document.getElementById('panel').hidden=false">Details</button>` +
      `<section id="panel" hidden><p>Panel content</p></section>`,
  ),
  "/broken": page(
    `<h1>Broken</h1><div id="wide" style="width:900px;background:#c33;height:40px"></div>` +
      `<script>console.error("fixture console error"); setTimeout(() => { throw new Error("fixture page error"); });</script>` +
      `<script src="/missing.js"></script>`,
  ),
  "/blank": page(""),
};

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const html = pages[path];
  res.writeHead(html ? 200 : 404, { "content-type": html ? "text/html; charset=utf-8" : "text/plain" });
  res.end(html ?? "not found");
}).listen(port, "127.0.0.1", () => console.log(`fixture app on http://127.0.0.1:${port}`));
