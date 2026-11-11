import { ConflictError, ImportError, NotFoundError, ValidationError } from "./errors.js";
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

/** Validated fields for a new ticket (throws ValidationError). */
function newTicketFields({ title, priority = "normal", assignee = null } = {}) {
  if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return { title: checkTitle(title), priority, status: "open", assignee: checkAssignee(assignee) };
}

const titleKey = (title) => String(title ?? "").trim().toLowerCase();

export function createTicketService({ store, clock = systemClock }) {
  const mustGet = (id) => {
    const ticket = store.get(id);
    if (!ticket) throw new NotFoundError(`ticket ${id} not found`);
    return ticket;
  };

  return {
    create(fields) {
      return store.insert({ ...newTicketFields(fields), createdAt: clock.now().toISOString() });
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

    close(id) {
      const ticket = mustGet(id);
      if (ticket.status === "closed") throw new ConflictError(`ticket ${id} is already closed`);
      return store.update(id, { status: "closed" });
    },

    /**
     * All-or-nothing import of rows ({ title, priority?, assignee? }). Throws ImportError listing every
     * invalid row (1-based); skips titles that already exist or appeared earlier; returns { created, skipped }.
     */
    importTickets(rows) {
      const errors = [];
      const valid = rows.map((row, i) => {
        try {
          return newTicketFields(row);
        } catch (e) {
          errors.push({ row: i + 1, error: e.message });
          return null;
        }
      });
      if (errors.length) throw new ImportError(errors);
      const seen = new Set(store.all().map((t) => titleKey(t.title)));
      const created = [];
      let skipped = 0;
      for (const fields of valid) {
        const key = titleKey(fields.title);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        created.push(store.insert({ ...fields, createdAt: clock.now().toISOString() }).id);
      }
      return { created, skipped };
    },
  };
}
