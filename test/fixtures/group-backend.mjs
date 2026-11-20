// A tiny backend for the repo-group integration scenarios: answers every request with 200 "ok".
// Port from the PORT env var, else the first argument.
import { createServer } from "node:http";

const port = Number(process.env.PORT || process.argv[2]);
if (!port) {
  console.error("usage: node group-backend.mjs <port> (or PORT=<port>)");
  process.exit(2);
}
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}).listen(port, () => console.log(`group backend listening on http://localhost:${port}`));
