/** Thrown when a removal asks for more than is in stock. */
export class InsufficientStockError extends Error {
  constructor(sku, requested, available) {
    super(`not enough ${sku}: requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
    this.sku = sku;
    this.requested = requested;
    this.available = available;
  }
}

const SKU = /^[A-Z0-9-]{3,20}$/;

function sku(value) {
  const s = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!SKU.test(s)) throw new TypeError(`invalid SKU: ${String(value)}`);
  return s;
}

function qty(value) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`quantity must be a positive integer, got ${String(value)}`);
  return value;
}

export class Inventory {
  #stock = new Map();

  add(s, q) {
    const key = sku(s);
    const n = (this.#stock.get(key) ?? 0) + qty(q);
    this.#stock.set(key, n);
    return n;
  }

  remove(s, q) {
    const key = sku(s);
    const want = qty(q);
    const have = this.#stock.get(key) ?? 0;
    if (want > have) throw new InsufficientStockError(key, want, have);
    const left = have - want;
    if (left === 0) this.#stock.delete(key);
    else this.#stock.set(key, left);
    return left;
  }

  quantity(s) {
    return this.#stock.get(sku(s)) ?? 0;
  }

  list() {
    return [...this.#stock].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([sku, qty]) => ({ sku, qty }));
  }

  total() {
    let t = 0;
    for (const n of this.#stock.values()) t += n;
    return t;
  }
}
