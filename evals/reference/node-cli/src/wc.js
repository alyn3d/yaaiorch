/** Count newlines, whitespace-separated words and Unicode code points. */
export function count(text) {
  return {
    lines: (text.match(/\n/g) ?? []).length,
    words: (text.match(/\S+/g) ?? []).length,
    chars: [...text].length,
  };
}
