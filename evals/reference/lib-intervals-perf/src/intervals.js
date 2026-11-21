/** Throw unless `list` is an array of [start, end] pairs of finite numbers with start < end. */
function check(list, name) {
  if (!Array.isArray(list)) throw new TypeError(`${name} must be an array`);
  for (const iv of list) {
    if (!Array.isArray(iv) || iv.length !== 2) throw new RangeError(`${name}: every interval must be [start, end]`);
    const [s, e] = iv;
    if (typeof s !== "number" || typeof e !== "number" || !Number.isFinite(s) || !Number.isFinite(e) || !(s < e))
      throw new RangeError(`${name}: invalid interval [${s}, ${e}]`);
  }
}

/** Sorted copy with overlapping or touching intervals merged. Assumes a checked list. */
function merged(list) {
  const sorted = list.map(([s, e]) => [s, e]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

/** Merge overlapping or touching [start, end) intervals into a sorted list. */
export function mergeIntervals(list) {
  check(list, "list");
  return merged(list);
}

/** The parts of the intervals in `a` that no interval in `b` covers, merged and sorted. */
export function subtractIntervals(a, b) {
  check(a, "a");
  check(b, "b");
  const A = merged(a);
  const B = merged(b);
  const out = [];
  let j = 0;
  for (const [s0, e] of A) {
    let s = s0;
    while (j < B.length && B[j][1] <= s) j++;
    let k = j;
    while (k < B.length && B[k][0] < e) {
      if (B[k][0] > s) out.push([s, B[k][0]]);
      s = Math.max(s, B[k][1]);
      if (s >= e) break;
      k++;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}
