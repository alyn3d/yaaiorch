import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { systemClock } from "./clock.js";

export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const STATUSES = ["open", "in_progress", "resolved", "closed"];
/** status -> statuses it may move to */
export const TRANSITIONS = {
  open: ["in_progress"],
  in_progress: ["open", "resolved"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

function checkTitle(title) {
  if (typeof title !== "string" || !title.trim()) throw new ValidationError("title is required");
  if (title.trim().length > 200) throw new ValidationError("title is longer than 200 characters");
  return title.trim();
}

const NAME = /^[a-z][a-z0-9_-]{1,31}$/;

function checkAssignee(assignee) {
  if (assignee === null || assignee === undefined) return null;
  if (typeof assignee !== "string" || !NAME.test(assignee)) throw new ValidationError("invalid assignee");
  return assignee;
}

/** Business rules for tickets. */
export function createTicketService({ store, clock = systemClock }) {
  const histories = new Map(); // id -> [{ from, to, by, at }]
  const mustGet = (id) => {
    const ticket = store.get(id);
    if (!ticket) throw new NotFoundError(`ticket ${id} not found`);
    return ticket;
  };

  return {
    create({ title, priority = "normal", assignee = null } = {}) {
      if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
      return store.insert({
        title: checkTitle(title),
        priority,
        status: "open",
        assignee: checkAssignee(assignee),
        createdAt: clock.now().toISOString(),
      });
    },

    get: (id) => mustGet(id),

    list({ status, assignee } = {}) {
      if (status !== undefined && !STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
      return store.all().filter((t) => (status === undefined || t.status === status) && (assignee === undefined || t.assignee === assignee));
    },

    assign(id, assignee) {
      mustGet(id);
      return store.update(id, { assignee: checkAssignee(assignee) });
    },

    transition(id, to, by) {
      if (!STATUSES.includes(to)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
      if (typeof by !== "string" || !NAME.test(by)) throw new ValidationError("by must be a valid name");
      const ticket = mustGet(id);
      if (!TRANSITIONS[ticket.status].includes(to)) throw new ConflictError(`cannot move from ${ticket.status} to ${to}`);
      if (to === "in_progress" && !ticket.assignee) throw new ConflictError("assign the ticket before starting it");
      const updated = store.update(id, { status: to });
      const list = histories.get(id) ?? [];
      list.push({ from: ticket.status, to, by, at: clock.now().toISOString() });
      histories.set(id, list);
      return updated;
    },

    history(id) {
      mustGet(id);
      return [...(histories.get(id) ?? [])];
    },
  };
}
