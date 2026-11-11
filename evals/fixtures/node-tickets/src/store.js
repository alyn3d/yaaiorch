/** In-memory ticket storage. Returns copies so callers cannot change stored tickets by accident. */
export function createStore(seed = []) {
  const tickets = new Map(seed.map((t) => [t.id, { ...t }]));
  let lastId = Math.max(0, ...seed.map((t) => t.id));

  return {
    all: () => [...tickets.values()].map((t) => ({ ...t })).sort((a, b) => a.id - b.id),
    get: (id) => (tickets.has(id) ? { ...tickets.get(id) } : undefined),
    insert(fields) {
      const ticket = { ...fields, id: ++lastId };
      tickets.set(ticket.id, ticket);
      return { ...ticket };
    },
    update(id, patch) {
      const current = tickets.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, id };
      tickets.set(id, next);
      return { ...next };
    },
  };
}
