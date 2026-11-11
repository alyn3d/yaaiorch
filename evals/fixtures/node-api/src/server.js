import http from "node:http";

/** Send `data` as JSON with the given status. */
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Build the API server. Each server has its own store.
 * @param {{ todos?: { id: number, title: string, done: boolean }[] }} [options]
 */
export function createServer(options = {}) {
  const todos = [...(options.todos ?? [])];

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/todos") {
      return sendJson(res, 200, todos);
    }
    sendJson(res, 404, { error: "not found" });
  });
}
