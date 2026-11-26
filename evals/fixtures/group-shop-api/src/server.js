import http from "node:http";

// API conventions (every endpoint follows them):
// - Bodies are JSON. Money is an integer number of cents (`priceCents`), never a float.
// - Ids are strings with a type prefix: products are "p1", "p2", ...
// - Lists are paginated: `{ items: [...], nextCursor }`, at most PAGE_SIZE items per page. `nextCursor` is null on
//   the last page; otherwise pass it back as `?cursor=` for the next page. Cursors are opaque to clients.
// - Errors are `{ error: { code, message } }` with a machine-readable `code`: "bad_json", "validation_failed",
//   "not_found". The message is for people.

export const PAGE_SIZE = 10;

/** Send `data` as JSON with the given status. */
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Send an error in the API's error shape. */
function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

/** Read and parse a JSON body; undefined when it is not valid JSON. */
async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One page of `list` starting at `cursor` (an index encoded as base64url). Null when the cursor is invalid. */
function paginate(list, cursor) {
  let start = 0;
  if (cursor !== null) {
    start = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(start) || start < 0 || start > list.length) return null;
  }
  const items = list.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < list.length ? Buffer.from(String(start + PAGE_SIZE)).toString("base64url") : null;
  return { items, nextCursor: next };
}

/**
 * Build the API server. Each server has its own in-memory store.
 * @param {{ products?: { id: string, name: string, priceCents: number, stock: number }[] }} [options]
 */
export function createServer(options = {}) {
  const products = (options.products ?? []).map((p) => ({ ...p }));
  let lastId = products.reduce((max, p) => Math.max(max, Number(p.id.slice(1)) || 0), 0);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });

    if (parts[0] === "products" && parts.length === 1) {
      if (req.method === "GET") {
        const page = paginate(products, url.searchParams.get("cursor"));
        if (!page) return sendError(res, 400, "validation_failed", "invalid cursor");
        return sendJson(res, 200, page);
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body === undefined) return sendError(res, 400, "bad_json", "the body is not valid JSON");
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 100) return sendError(res, 400, "validation_failed", "name must be 1 to 100 characters");
        if (typeof body.priceCents !== "number" || body.priceCents < 0)
          return sendError(res, 400, "validation_failed", "priceCents must be a non-negative number");
        const product = { id: `p${++lastId}`, name, priceCents: body.priceCents, stock: 0 };
        products.push(product);
        return sendJson(res, 201, product);
      }
    }

    if (parts[0] === "products" && parts.length === 2 && req.method === "GET") {
      const product = products.find((p) => p.id === parts[1]);
      if (!product) return sendError(res, 404, "not_found", `no product ${parts[1]}`);
      return sendJson(res, 200, product);
    }

    sendError(res, 404, "not_found", "no such route");
  });
}
