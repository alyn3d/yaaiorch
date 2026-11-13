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
  const todos = (options.todos ?? []).map((t) => ({ ...t }));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/todos") {
      return sendJson(res, 200, todos);
    }
    const m = /^\/todos\/([^/]+)$/.exec(url.pathname);
    if (req.method === "PATCH" && m) {
      const id = Number(m[1]);
      if (!Number.isInteger(id) || id < 1) return sendJson(res, 400, { error: "id must be a positive integer" });
      const todo = todos.find((t) => t.id === id);
      if (!todo) return sendJson(res, 404, { error: "todo not found" });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: "body must be valid JSON" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "body must be an object" });
      if (!("title" in body) && !("done" in body)) return sendJson(res, 400, { error: "give title and/or done" });
      let title = todo.title;
      if ("title" in body) {
        title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || title.length > 200) return sendJson(res, 400, { error: "title must be 1 to 200 characters" });
      }
      if ("done" in body && typeof body.done !== "boolean") return sendJson(res, 400, { error: "done must be true or false" });
      todo.title = title;
      if ("done" in body) todo.done = body.done;
      return sendJson(res, 200, todo);
    }
    sendJson(res, 404, { error: "not found" });
  });
}
