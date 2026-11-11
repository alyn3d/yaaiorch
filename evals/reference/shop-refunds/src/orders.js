import { takeStock, returnStock } from "./catalog.js";
import { tax } from "./pricing.js";

const orders = [];
let nextId = 1;

/** Turn a cart into an order: takes stock, adds tax. */
export function placeOrder(cart) {
  if (cart.isEmpty()) throw new Error("cart is empty");
  const lines = cart.items();
  takeStock(lines);
  const subtotal = cart.subtotal();
  const t = tax(subtotal);
  const order = { id: nextId++, lines, subtotal, tax: t, total: subtotal + t, refunds: [], refunded: 0 };
  orders.push(order);
  return order;
}

export function listOrders() {
  return [...orders];
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Refund qty units of one line; the last refund of a whole order returns the rest of its tax. */
export function refund(orderId, sku, qty) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`unknown order: ${orderId}`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error("qty must be a positive integer");
  const line = order.lines.find((l) => l.sku === sku);
  if (!line) throw new Error(`order ${orderId} has no ${sku}`);
  const already = sum(order.refunds.filter((r) => r.sku === sku).map((r) => r.qty));
  if (already + qty > line.qty) throw new Error(`only ${line.qty - already} ${sku} left to refund`);

  const priceOf = (s) => order.lines.find((l) => l.sku === s).unitPrice;
  const taxRefunded = sum(order.refunds.map((r) => r.amount - priceOf(r.sku) * r.qty));
  const unitsLeft = sum(order.lines.map((l) => l.qty)) - sum(order.refunds.map((r) => r.qty));
  const lineAmount = line.unitPrice * qty;
  const taxShare = qty === unitsLeft ? order.tax - taxRefunded : Math.round((order.tax * lineAmount) / order.subtotal);

  returnStock(sku, qty);
  const entry = { sku, qty, amount: lineAmount + taxShare };
  order.refunds.push(entry);
  order.refunded += entry.amount;
  return { ...entry };
}
