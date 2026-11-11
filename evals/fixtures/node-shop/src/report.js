/** Summary of a list of orders: { count, revenue, bySku: { sku: units } }. Revenue includes tax. */
export function salesReport(orders) {
  const bySku = {};
  let revenue = 0;
  for (const order of orders) {
    revenue += order.total;
    for (const line of order.lines) bySku[line.sku] = (bySku[line.sku] ?? 0) + line.qty;
  }
  return { count: orders.length, revenue, bySku };
}
