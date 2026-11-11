import http from "node:http";

/** Send `data` as JSON with the given status. */
function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}

const ALLOWED = new Set(["done", "limit", "offset"]);
const intIn = (s, min, max) => (/^\d+$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

/** Parse ?done, ?limit, ?offset; returns { error } or { done, limit, offset }. */
function listQuery(params) {
  for (const key of params.keys()) if (!ALLOWED.has(key)) return { error: `unknown parameter: ${key}` };
  let done;
  if (params.has("done")) {
    const v = params.get("done");
    if (v !== "true" && v !== "false") return { error: "done must be true or false" };
    done = v === "true";
  }
  let limit = Infinity;
  if (params.has("limit")) {
    limit = intIn(params.get("limit"), 1, 100);
    if (limit === null) return { error: "limit must be an integer from 1 to 100" };
  }
  let offset = 0;
  if (params.has("offset")) {
    offset = intIn(params.get("offset"), 0, Number.MAX_SAFE_INTEGER);
    if (offset === null) return { error: "offset must be an integer of 0 or more" };
  }
  return { done, limit, offset };
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
      const q = listQuery(url.searchParams);
      if (q.error) return sendJson(res, 400, { error: q.error });
      const matching = todos.filter((t) => q.done === undefined || t.done === q.done).sort((a, b) => a.id - b.id);
      const page = matching.slice(q.offset, q.offset + q.limit);
      return sendJson(res, 200, page, { "x-total-count": String(matching.length) });
    }
    sendJson(res, 404, { error: "not found" });
  });
}
