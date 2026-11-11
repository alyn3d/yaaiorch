/** Coupon code -> discount in cents for a subtotal in cents (before rounding and capping). */
export const COUPONS = {
  SAVE10: (subtotal) => subtotal * 0.1,
  FLAT500: (subtotal) => (subtotal >= 2000 ? 500 : 0),
};

/** Discount in cents, rounded half up, never more than the subtotal. */
export function discountFor(code, subtotal) {
  if (!code) return 0;
  return Math.min(subtotal, Math.round(COUPONS[code](subtotal)));
}
