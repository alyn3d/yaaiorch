import { takeStock } from "./catalog.js";
import { tax } from "./pricing.js";

const orders = [];
let nextId = 1;

/** Turn a cart into an order: takes stock, adds tax. Returns { id, lines, subtotal, tax, total }. */
export function placeOrder(cart) {
  if (cart.isEmpty()) throw new Error("cart is empty");
  const lines = cart.items();
  takeStock(lines);
  const subtotal = cart.subtotal();
  const t = tax(subtotal);
  const order = { id: nextId++, lines, subtotal, tax: t, total: subtotal + t };
  orders.push(order);
  return order;
}

export function listOrders() {
  return [...orders];
}
