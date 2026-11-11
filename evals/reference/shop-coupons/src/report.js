/** Summary of orders: { count, revenue, bySku, discounts, byCoupon }. Revenue includes tax. */
export function salesReport(orders) {
  const bySku = {};
  const byCoupon = {};
  let revenue = 0;
  let discounts = 0;
  for (const order of orders) {
    revenue += order.total;
    discounts += order.discount ?? 0;
    if (order.coupon) byCoupon[order.coupon] = (byCoupon[order.coupon] ?? 0) + 1;
    for (const line of order.lines) bySku[line.sku] = (bySku[line.sku] ?? 0) + line.qty;
  }
  return { count: orders.length, revenue, bySku, discounts, byCoupon };
}
