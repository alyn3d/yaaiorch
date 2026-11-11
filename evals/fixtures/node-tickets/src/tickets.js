import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { systemClock } from "./clock.js";

export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const STATUSES = ["open", "closed"];

function checkTitle(title) {
  if (typeof title !== "string" || !title.trim()) throw new ValidationError("title is required");
  if (title.trim().length > 200) throw new ValidationError("title is longer than 200 characters");
  return title.trim();
}

function checkAssignee(assignee) {
  if (assignee === null || assignee === undefined) return null;
  if (typeof assignee !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(assignee)) throw new ValidationError("invalid assignee");
  return assignee;
}

/** Business rules for tickets. */
export function createTicketService({ store, clock = systemClock }) {
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

    /** Tickets in id order, optionally filtered by status and/or assignee. */
    list({ status, assignee } = {}) {
      if (status !== undefined && !STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
      return store.all().filter((t) => (status === undefined || t.status === status) && (assignee === undefined || t.assignee === assignee));
    },

    assign(id, assignee) {
      mustGet(id);
      return store.update(id, { assignee: checkAssignee(assignee) });
    },

    close(id) {
      const ticket = mustGet(id);
      if (ticket.status === "closed") throw new ConflictError(`ticket ${id} is already closed`);
      return store.update(id, { status: "closed" });
    },
  };
}
