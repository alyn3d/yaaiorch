import { tax } from "./pricing.js";
import { salesReport } from "./report.js";

/** The standard catalog, as the shop starts. The module-level API in catalog.js is the default shop. */
const STANDARD = {
  "TEA-01": { name: "Green tea", price: 450, stock: 20 },
  "MUG-01": { name: "Mug", price: 1299, stock: 5 },
  "PEN-01": { name: "Pen", price: 199, stock: 100 },
};

/** An independent shop: its own stock, orders and order ids. */
export function createShop(products = STANDARD) {
  const catalog = structuredClone(products);
  const orders = [];
  let nextId = 1;

  const getProduct = (sku) => {
    if (!Object.hasOwn(catalog, sku)) throw new Error(`unknown sku: ${sku}`);
    return catalog[sku];
  };

  class ShopCart {
    #lines = new Map();
    add(sku, qty = 1) {
      if (!Number.isInteger(qty) || qty < 1) throw new RangeError("qty must be a positive integer");
      getProduct(sku);
      this.#lines.set(sku, qty);
    }
    remove(sku) {
      this.#lines.delete(sku);
    }
    isEmpty() {
      return this.#lines.size === 0;
    }
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

  return {
    getProduct,
    listProducts: () => Object.entries(catalog).map(([sku, p]) => ({ sku, ...p })),
    newCart: () => new ShopCart(),
    placeOrder(cart) {
      if (cart.isEmpty()) throw new Error("cart is empty");
      const lines = cart.items();
      for (const { sku, qty } of lines) if (getProduct(sku).stock < qty) throw new Error(`not enough stock for ${sku}`);
      for (const { sku, qty } of lines) getProduct(sku).stock -= qty;
      const subtotal = cart.subtotal();
      const t = tax(subtotal);
      const order = { id: nextId++, lines, subtotal, tax: t, total: subtotal + t };
      orders.push(order);
      return order;
    },
    listOrders: () => [...orders],
    salesReport: () => salesReport(orders),
  };
}
