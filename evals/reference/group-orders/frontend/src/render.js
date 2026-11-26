import { formatPrice } from "./money.js";

/** Escape text for HTML. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The product list as HTML.
 * @param {{ id: string, name: string, priceCents: number, stock: number }[]} products
 */
export function renderProductList(products) {
  if (!products.length) return `<p class="empty">No products yet.</p>`;
  const rows = products.map(
    (p) =>
      `<li data-id="${escapeHtml(p.id)}"><span class="name">${escapeHtml(p.name)}</span> ` +
      `<span class="price">${formatPrice(p.priceCents)}</span>${p.stock === 0 ? ` <span class="sold-out">Sold out</span>` : ""}</li>`,
  );
  return `<ul class="products">${rows.join("")}</ul>`;
}

/**
 * What to tell the customer when placing an order failed.
 * @param {unknown} error what placeOrder rejected with
 */
export function renderOrderError(error) {
  if (error?.name === "ApiError" && error.code === "out_of_stock") return error.message;
  if (error?.name === "ApiError" && error.status === 404) return "This product no longer exists.";
  return "Something went wrong, please try again.";
}
