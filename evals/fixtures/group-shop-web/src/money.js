/**
 * A dollar amount as typed in a form ("12.50", "3", "0.99") in cents.
 * @param {string} text
 * @returns {number}
 */
export function toCents(text) {
  const [whole, fraction = ""] = String(text).trim().split(".");
  return Number(whole) * 100 + Number(fraction || 0);
}

/**
 * Cents as a price for people: 1250 is "$12.50", 123456 is "$1,234.56".
 * @param {number} cents
 * @returns {string}
 */
export function formatPrice(cents) {
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}
