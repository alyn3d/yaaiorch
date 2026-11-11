/** Split `arr` into consecutive groups of `size` items; the last group may be shorter. */
export function chunk(arr, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Add up a list of numbers. */
export function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}
