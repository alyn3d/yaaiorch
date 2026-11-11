/** Summary of orders: count, revenue (with tax), refunds, netRevenue, and net units per SKU. */
export function salesReport(orders) {
  const bySku = {};
  let revenue = 0;
  let refunds = 0;
  for (const order of orders) {
    revenue += order.total;
    refunds += order.refunded ?? 0;
    for (const line of order.lines) bySku[line.sku] = (bySku[line.sku] ?? 0) + line.qty;
    for (const r of order.refunds ?? []) bySku[r.sku] -= r.qty;
  }
  return { count: orders.length, revenue, bySku, refunds, netRevenue: revenue - refunds };
}
