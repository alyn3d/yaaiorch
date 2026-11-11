# node-shop

A tiny in-memory shop: catalog with stock, carts, orders with tax, and a sales report. ESM, no
dependencies, Node 20+. All money is in integer cents. Tests use `node:test`; run `npm test`.

| module | what |
|---|---|
| `src/catalog.js` | products (`TEA-01`, `MUG-01`, `PEN-01`), prices, stock |
| `src/cart.js` | `Cart`: add/remove lines, subtotal |
| `src/pricing.js` | tax (8 %, rounded half up to a cent), money formatting |
| `src/orders.js` | `placeOrder(cart)`: checks and takes stock, computes tax and total |
| `src/report.js` | `salesReport(orders)`: order count, revenue, units per SKU |
| `src/index.js` | re-exports everything |
