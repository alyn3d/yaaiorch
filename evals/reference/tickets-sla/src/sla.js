/** Business hours: Monday to Friday, 09:00 to 17:00 UTC (17:00 itself is outside). */
export const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 40 };

const OPEN = 9;
const CLOSE = 17;
const HOUR = 3_600_000;
const isWeekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
const at = (d, hour) => {
  const t = new Date(d);
  t.setUTCHours(hour, 0, 0, 0);
  return t;
};

/** The instant itself if it is within business hours, else the next opening. */
function nextBusinessInstant(d) {
  if (isWeekday(d) && d >= at(d, OPEN) && d < at(d, CLOSE)) return new Date(d);
  if (isWeekday(d) && d < at(d, OPEN)) return at(d, OPEN);
  const t = at(d, OPEN);
  do t.setUTCDate(t.getUTCDate() + 1);
  while (!isWeekday(t));
  return t;
}

/** `hours` business hours after `start`; a deadline that falls at 17:00 stays at 17:00. */
export function addBusinessHours(start, hours) {
  let t = nextBusinessInstant(start);
  let remaining = hours * HOUR;
  for (;;) {
    const available = at(t, CLOSE) - t;
    if (remaining <= available) return new Date(t.getTime() + remaining);
    remaining -= available;
    t = nextBusinessInstant(at(t, CLOSE));
  }
}
