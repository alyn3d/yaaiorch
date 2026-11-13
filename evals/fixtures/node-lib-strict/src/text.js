/**
 * Upper-case the first character of a string.
 * @param {string} s The text.
 * @returns {string} The text with its first character upper-cased.
 */
export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Split a string into words on runs of whitespace.
 * @param {string} s The text.
 * @returns {string[]} The words, without empty ones.
 */
export function words(s) {
  return s.split(/\s+/).filter(Boolean);
}
