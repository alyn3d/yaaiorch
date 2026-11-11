export const TAX_RATE = 0.08;

/** Tax on an amount in cents, rounded half up to a whole cent. */
export function tax(cents) {
  return Math.round(cents * TAX_RATE);
}

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
