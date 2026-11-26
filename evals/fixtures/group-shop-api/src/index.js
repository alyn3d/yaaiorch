import { createServer } from "./server.js";

// Demo data so the shop has something to show: more products than fit on one page.
const products = Array.from({ length: 14 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `Product ${i + 1}`,
  priceCents: 500 + i * 125,
  stock: i % 4 === 0 ? 0 : 3 + i,
}));

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);
createServer({ products }).listen(port, () => console.log(`shop API listening on http://localhost:${port}`));
