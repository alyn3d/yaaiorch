/** Throw unless `list` is an array of [start, end] pairs of finite numbers with start < end. */
function check(fn, list, name) {
  if (!Array.isArray(list)) throw new TypeError(`${fn}: ${name} must be an array`);
  list.forEach((iv, i) => {
    const ok =
      Array.isArray(iv) && iv.length === 2 && typeof iv[0] === "number" && typeof iv[1] === "number" && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[0] < iv[1];
    if (!ok) throw new RangeError(`${fn}: ${name}[${i}] is not a valid interval [start, end] with start < end`);
  });
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

/**
 * Merge overlapping or touching [start, end) intervals.
 * @param {[number, number][]} list intervals in any order
 * @returns {[number, number][]} new intervals, sorted by start, none overlapping or touching
 */
export function mergeIntervals(list) {
  check("mergeIntervals", list, "list");
  return merged(list);
}

/**
 * The parts of the intervals in `a` that no interval in `b` covers.
 * @param {[number, number][]} a intervals to keep parts of
 * @param {[number, number][]} b intervals to cut out
 * @returns {[number, number][]} new intervals, merged and sorted
 */
export function subtractIntervals(a, b) {
  check("subtractIntervals", a, "a");
  check("subtractIntervals", b, "b");
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
