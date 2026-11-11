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
    const del = /^\/todos\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && del) {
      if (!/^[1-9]\d*$/.test(del[1])) return sendJson(res, 400, { error: "id must be a positive integer" });
      const i = todos.findIndex((t) => t.id === Number(del[1]));
      if (i < 0) return sendJson(res, 404, { error: "todo not found" });
      todos.splice(i, 1);
      res.writeHead(204);
      return res.end();
    }
    sendJson(res, 404, { error: "not found" });
  });
}
