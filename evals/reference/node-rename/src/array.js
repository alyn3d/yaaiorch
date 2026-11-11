/** Split `arr` into consecutive groups of `size` items. */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i + size <= arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Add up a list of numbers. */
export function total(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

/** @deprecated Use total. */
export const sum = total;
