import http from "node:http";

/** Send `data` as JSON with the given status. */
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

class BadRequest extends Error {}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      if (!s) return resolve({});
      try {
        const v = JSON.parse(s);
        if (v === null || typeof v !== "object" || Array.isArray(v)) return reject(new BadRequest("body must be a JSON object"));
        resolve(v);
      } catch {
        reject(new BadRequest("body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function checkTitle(title) {
  if (typeof title !== "string" || !title.trim()) throw new BadRequest("title is required");
  if (title.trim().length > 100) throw new BadRequest("title is longer than 100 characters");
  return title.trim();
}

/**
 * Build the API server. Each server has its own store.
 * @param {{ todos?: { id: number, title: string, done: boolean }[] }} [options]
 */
export function createServer(options = {}) {
  const todos = [...(options.todos ?? [])].map((t) => ({ ...t }));
  let lastId = Math.max(0, ...todos.map((t) => t.id));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });

      if (url.pathname === "/todos") {
        if (req.method === "GET") {
          const done = url.searchParams.get("done");
          if (done !== null && done !== "true" && done !== "false") throw new BadRequest("done must be true or false");
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
          return sendJson(
            res,
            200,
            todos.filter((t) => (done === null || t.done === (done === "true")) && (!q || t.title.toLowerCase().includes(q))),
          );
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          const todo = { id: ++lastId, title: checkTitle(body.title), done: false };
          todos.push(todo);
          return sendJson(res, 201, todo);
        }
      }

      const m = /^\/todos\/([^/]+)$/.exec(url.pathname);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        if (!/^[1-9]\d*$/.test(m[1])) throw new BadRequest("id must be a positive integer");
        const i = todos.findIndex((t) => t.id === Number(m[1]));
        if (i < 0) return sendJson(res, 404, { error: "todo not found" });
        if (req.method === "DELETE") {
          todos.splice(i, 1);
          res.writeHead(204);
          return res.end();
        }
        const body = await readJson(req);
        if (body.title === undefined && body.done === undefined) throw new BadRequest("nothing to update: give title and/or done");
        if (body.done !== undefined && typeof body.done !== "boolean") throw new BadRequest("done must be a boolean");
        const next = { ...todos[i] };
        if (body.title !== undefined) next.title = checkTitle(body.title);
        if (body.done !== undefined) next.done = body.done;
        todos[i] = next;
        return sendJson(res, 200, next);
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
      sendJson(res, 500, { error: "internal error" });
    }
  });
}
