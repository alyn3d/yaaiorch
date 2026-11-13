const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call `fn` until it succeeds, waiting longer after each failure.
 * @param {(attempt: number) => unknown} fn Called with the attempt number (1-based); may be async.
 * @param {{ attempts?: number, delayMs?: number, factor?: number, shouldRetry?: (err: unknown) => boolean }} [options]
 *   attempts: total tries (default 3); delayMs: wait before the second try (default 100); factor: multiplier for
 *   each later wait (default 2); shouldRetry: return false to stop at once.
 * @returns {Promise<unknown>} What `fn` returned on its first success.
 */
export async function retry(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  const { attempts = 3, delayMs = 100, factor = 2, shouldRetry = () => true } = options;
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");
  if (typeof delayMs !== "number" || !(delayMs >= 0)) throw new RangeError("delayMs must be a number >= 0");
  if (typeof factor !== "number" || !(factor >= 1)) throw new RangeError("factor must be a number >= 1");
  let wait = delayMs;
  for (let n = 1; ; n++) {
    try {
      return await fn(n);
    } catch (err) {
      if (n >= attempts || !shouldRetry(err)) throw err;
      await sleep(wait);
      wait *= factor;
    }
  }
}
