import { takeStock } from "./catalog.js";
import { tax } from "./pricing.js";

const orders = [];
let nextId = 1;

/** Turn a cart into an order: takes stock, applies the coupon, then tax on the discounted subtotal. */
export function placeOrder(cart) {
  if (cart.isEmpty()) throw new Error("cart is empty");
  const lines = cart.items();
  takeStock(lines);
  const subtotal = cart.subtotal();
  const discount = cart.discount();
  const t = tax(subtotal - discount);
  const order = { id: nextId++, lines, subtotal, discount, tax: t, total: subtotal - discount + t, coupon: cart.coupon() };
  orders.push(order);
  return order;
}

export function listOrders() {
  return [...orders];
}
