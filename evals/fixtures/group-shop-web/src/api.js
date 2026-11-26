import { toCents } from "./money.js";

/** An error answer from the shop API: the HTTP status, the API's error code and its message. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The web shop's client for the shop API.
 * @param {string} baseUrl where the API runs, e.g. "http://localhost:3000"
 * @param {{ fetch?: typeof fetch }} [options] a fetch to use instead of the global one (tests)
 */
export function createApi(baseUrl, options = {}) {
  const doFetch = options.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");

  /** Call the API; resolves to the parsed body, rejects with an ApiError for an error status. */
  async function call(method, path, body) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "unknown", data?.error?.message ?? `HTTP ${res.status}`);
    return data;
  }

  return {
    /** Every product in the shop. */
    async listProducts() {
      const page = await call("GET", "/products");
      return page.items;
    },

    /** One product by id. */
    getProduct(id) {
      return call("GET", `/products/${encodeURIComponent(id)}`);
    },

    /**
     * Create a product from the admin form.
     * @param {{ name: string, price: string }} input price as typed, in dollars ("12.50")
     */
    createProduct({ name, price }) {
      return call("POST", "/products", { name, priceCents: toCents(price) });
    },
  };
}
