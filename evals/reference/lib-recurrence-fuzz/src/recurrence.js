const DAY = 86_400_000;
const HORIZON_YEARS = 100;

/** "YYYY-MM-DD" -> days since 1970-01-01 (UTC), or a RangeError for anything but a real calendar date. */
function toDay(s, what) {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) throw new RangeError(`nextOccurrences: ${what} must be a date "YYYY-MM-DD"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new RangeError(`nextOccurrences: ${what} is not a real date`);
  return t / DAY;
}
const toDate = (day) => new Date(day * DAY).toISOString().slice(0, 10);
const isInt = (x) => typeof x === "number" && Number.isInteger(x);

/** Monday on or before `day` (1970-01-01 was a Thursday). */
const mondayOf = (day) => day - ((((day + 3) % 7) + 7) % 7);

/**
 * The first `count` dates on or after `from` on which `rule` occurs, before January 1 of the start's year + 100.
 * @param {{ start: string, freq: "daily" | "weekly" | "monthly", interval?: number, byWeekday?: number[], byMonthDay?: number }} rule
 * @param {string} from the earliest date to return, "YYYY-MM-DD"
 * @param {number} count how many dates to return at most, 0 to 1000
 * @returns {string[]} dates "YYYY-MM-DD" in order
 */
export function nextOccurrences(rule, from, count) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new TypeError("nextOccurrences: rule must be an object");
  const { start, freq, interval = 1, byWeekday, byMonthDay } = rule;
  const s = toDay(start, "start");
  const f = toDay(from, "from");
  if (!["daily", "weekly", "monthly"].includes(freq)) throw new RangeError('nextOccurrences: freq must be "daily", "weekly" or "monthly"');
  if (!isInt(interval) || interval < 1) throw new RangeError("nextOccurrences: interval must be a positive integer");
  if (!isInt(count) || count < 0 || count > 1000) throw new RangeError("nextOccurrences: count must be an integer from 0 to 1000");
  if (byWeekday !== undefined && freq !== "weekly") throw new RangeError("nextOccurrences: byWeekday is only for weekly rules");
  if (byMonthDay !== undefined && freq !== "monthly") throw new RangeError("nextOccurrences: byMonthDay is only for monthly rules");

  const startDate = new Date(s * DAY);
  let match;
  if (freq === "daily") match = (d) => (d - s) % interval === 0;
  else if (freq === "weekly") {
    const days = byWeekday ?? [startDate.getUTCDay()];
    if (!Array.isArray(days) || !days.length || new Set(days).size !== days.length || !days.every((x) => isInt(x) && x >= 0 && x <= 6))
      throw new RangeError("nextOccurrences: byWeekday must be a non-empty array of distinct weekdays 0 to 6");
    const firstWeek = mondayOf(s);
    match = (d) => days.includes(new Date(d * DAY).getUTCDay()) && ((mondayOf(d) - firstWeek) / 7) % interval === 0;
  } else {
    const md = byMonthDay ?? startDate.getUTCDate();
    if (!isInt(md) || !(md === -1 || (md >= 1 && md <= 31))) throw new RangeError("nextOccurrences: byMonthDay must be 1 to 31, or -1");
    const months = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
    const first = months(startDate);
    match = (d) => {
      const date = new Date(d * DAY);
      if ((months(date) - first) % interval !== 0) return false;
      if (md === -1) return new Date((d + 1) * DAY).getUTCDate() === 1;
      return date.getUTCDate() === md;
    };
  }

  const end = Date.UTC(startDate.getUTCFullYear() + HORIZON_YEARS, 0, 1) / DAY;
  const out = [];
  for (let d = Math.max(s, f); d < end && out.length < count; d++) if (match(d)) out.push(toDate(d));
  return out;
}
