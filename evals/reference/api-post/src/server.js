import http from "node:http";

/** Send `data` as JSON with the given status. */
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

/**
 * Build the API server. Each server has its own store.
 * @param {{ todos?: { id: number, title: string, done: boolean }[] }} [options]
 */
export function createServer(options = {}) {
  const todos = [...(options.todos ?? [])];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/todos") {
      return sendJson(res, 200, todos);
    }
    if (req.method === "POST" && url.pathname === "/todos") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: "body must be valid JSON" });
      }
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 200) return sendJson(res, 400, { error: "title must be 1 to 200 characters" });
      const todo = { id: Math.max(0, ...todos.map((t) => t.id)) + 1, title, done: false };
      todos.push(todo);
      return sendJson(res, 201, todo);
    }
    sendJson(res, 404, { error: "not found" });
  });
}
