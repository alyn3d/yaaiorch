import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { systemClock } from "./clock.js";
import { addBusinessHours, SLA_HOURS } from "./sla.js";

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

function checkPriority(priority) {
  if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return priority;
}

const dueAt = (createdAt, priority) => addBusinessHours(new Date(createdAt), SLA_HOURS[priority]).toISOString();

export function createTicketService({ store, clock = systemClock }) {
  const mustGet = (id) => {
    const ticket = store.get(id);
    if (!ticket) throw new NotFoundError(`ticket ${id} not found`);
    return ticket;
  };

  return {
    create({ title, priority = "normal", assignee = null } = {}) {
      checkPriority(priority);
      const createdAt = clock.now().toISOString();
      return store.insert({
        title: checkTitle(title),
        priority,
        status: "open",
        assignee: checkAssignee(assignee),
        createdAt,
        dueAt: dueAt(createdAt, priority),
      });
    },

    get: (id) => mustGet(id),

    list({ status, assignee, overdue } = {}) {
      if (status !== undefined && !STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
      if (overdue !== undefined && typeof overdue !== "boolean") throw new ValidationError("overdue must be true or false");
      const now = clock.now().getTime();
      const isOverdue = (t) => t.status === "open" && new Date(t.dueAt).getTime() < now;
      return store
        .all()
        .filter((t) => (status === undefined || t.status === status) && (assignee === undefined || t.assignee === assignee))
        .filter((t) => overdue === undefined || isOverdue(t) === overdue);
    },

    assign(id, assignee) {
      mustGet(id);
      return store.update(id, { assignee: checkAssignee(assignee) });
    },

    setPriority(id, priority) {
      const ticket = mustGet(id);
      checkPriority(priority);
      return store.update(id, { priority, dueAt: dueAt(ticket.createdAt, priority) });
    },

    close(id) {
      const ticket = mustGet(id);
      if (ticket.status === "closed") throw new ConflictError(`ticket ${id} is already closed`);
      return store.update(id, { status: "closed" });
    },
  };
}
