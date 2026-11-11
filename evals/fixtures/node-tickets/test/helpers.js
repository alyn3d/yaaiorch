import { createStore } from "../src/store.js";
import { createTicketService } from "../src/tickets.js";
import { createApp } from "../src/http.js";
import { fixedClock } from "../src/clock.js";

/** A service on a fresh store with a fixed clock. */
export function makeService({ seed = [], now = "2026-03-02T10:00:00.000Z" } = {}) {
  return createTicketService({ store: createStore(seed), clock: fixedClock(now) });
}

/** Start the app on a free port, run fn(base, service), then close it. */
export async function withApp(fn, options) {
  const service = makeService(options);
  const server = createApp({ service });
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, service);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

export const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
