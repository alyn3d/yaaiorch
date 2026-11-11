/** In-memory product catalog. Prices are integer cents. */
const PRODUCTS = {
  "TEA-01": { name: "Green tea", price: 450, stock: 20 },
  "MUG-01": { name: "Mug", price: 1299, stock: 5 },
  "PEN-01": { name: "Pen", price: 199, stock: 100 },
};

export function getProduct(sku) {
  const p = PRODUCTS[sku];
  if (!p) throw new Error(`unknown sku: ${sku}`);
  return p;
}

export function listProducts() {
  return Object.entries(PRODUCTS).map(([sku, p]) => ({ sku, ...p }));
}

/** Throws (and takes nothing) if any line asks for more than is in stock. */
export function takeStock(lines) {
  for (const { sku, qty } of lines) {
    if (getProduct(sku).stock < qty) throw new Error(`not enough stock for ${sku}`);
  }
  for (const { sku, qty } of lines) getProduct(sku).stock -= qty;
}

/** Put refunded units back. */
export function returnStock(sku, qty) {
  getProduct(sku).stock += qty;
}
