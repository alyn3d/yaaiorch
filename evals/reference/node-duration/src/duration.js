const SECONDS = { d: 86400, h: 3600, m: 60, s: 1 };

/** "1h30m" -> 5400. Units d, h, m, s in that order, each at most once. */
export function parseDuration(text) {
  if (typeof text !== "string") throw new Error("duration must be a string");
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!text || !m) throw new Error(`invalid duration: ${JSON.stringify(text)}`);
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * SECONDS.d + Number(h ?? 0) * SECONDS.h + Number(min ?? 0) * SECONDS.m + Number(s ?? 0);
}
