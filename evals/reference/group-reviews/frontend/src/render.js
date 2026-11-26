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
 * A product's rating for people: "★ 4.5 (12 reviews)", or "No reviews yet".
 * @param {{ averageRating: number | null, reviewCount: number }} product
 */
export function renderRating(product) {
  if (!product.reviewCount) return "No reviews yet";
  return `★ ${product.averageRating.toFixed(1)} (${product.reviewCount} ${product.reviewCount === 1 ? "review" : "reviews"})`;
}
