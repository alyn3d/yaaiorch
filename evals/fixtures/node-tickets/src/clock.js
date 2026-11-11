/** The real clock. Services take a clock so tests can fix the time. */
export const systemClock = { now: () => new Date() };

/** A clock stuck at one instant, for tests. */
export const fixedClock = (iso) => ({ now: () => new Date(iso) });
