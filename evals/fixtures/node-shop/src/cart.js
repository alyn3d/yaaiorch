import { getProduct } from "./catalog.js";

export class Cart {
  /** sku -> quantity */
  #lines = new Map();

  add(sku, qty = 1) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError("qty must be a positive integer");
    getProduct(sku); // throws for an unknown sku
    this.#lines.set(sku, qty);
  }

  remove(sku) {
    this.#lines.delete(sku);
  }

  isEmpty() {
    return this.#lines.size === 0;
  }

  /** Lines with current prices: { sku, name, qty, unitPrice, lineTotal }. */
  items() {
    return [...this.#lines].map(([sku, qty]) => {
      const p = getProduct(sku);
      return { sku, name: p.name, qty, unitPrice: p.price, lineTotal: p.price * qty };
    });
  }

  subtotal() {
    return this.items().reduce((sum, line) => sum + line.lineTotal, 0);
  }
}
