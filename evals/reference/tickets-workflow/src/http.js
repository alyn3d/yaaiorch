import http from "node:http";
import { AppError, ValidationError } from "./errors.js";

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

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
}

function idParam(raw) {
  if (!/^[1-9]\d*$/.test(raw)) throw new ValidationError("id must be a positive integer");
  return Number(raw);
}

function routes(service) {
  return [
    ["GET", /^\/tickets$/, (req, url) => {
      const status = url.searchParams.get("status") ?? undefined;
      const assignee = url.searchParams.get("assignee") ?? undefined;
      return [200, service.list({ status, assignee })];
    }],
    ["POST", /^\/tickets$/, async (req) => [201, service.create(await readJson(req))]],
    ["GET", /^\/tickets\/([^/]+)$/, (req, url, id) => [200, service.get(idParam(id))]],
    ["PATCH", /^\/tickets\/([^/]+)$/, async (req, url, id) => {
      const body = await readJson(req);
      return [200, service.assign(idParam(id), body.assignee)];
    }],
    ["POST", /^\/tickets\/([^/]+)\/transitions$/, async (req, url, id) => {
      const body = await readJson(req);
      return [200, service.transition(idParam(id), body.to, body.by)];
    }],
    ["GET", /^\/tickets\/([^/]+)\/history$/, (req, url, id) => [200, service.history(idParam(id))]],
  ];
}

export function createApp({ service }) {
  const table = routes(service);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const [method, pattern, handler] of table) {
        const m = pattern.exec(url.pathname);
        if (m && req.method === method) {
          const [status, data] = await handler(req, url, ...m.slice(1));
          return sendJson(res, status, data);
        }
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof AppError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: "internal error" });
    }
  });
}
