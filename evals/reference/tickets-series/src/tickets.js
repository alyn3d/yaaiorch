import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { systemClock } from "./clock.js";

export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const STATUSES = ["open", "closed"];
export const MAX_TAGS = 10;
const TAG = /^[a-z][a-z0-9-]{0,19}$/;

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

/** Trimmed, lower-cased and valid, or a ValidationError. */
function checkTag(tag) {
  const t = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  if (!TAG.test(t)) throw new ValidationError(`invalid tag: ${JSON.stringify(tag)}`);
  return t;
}

function checkTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new ValidationError("tags must be an array");
  const out = [];
  for (const tag of tags) {
    const t = checkTag(tag);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new ValidationError(`at most ${MAX_TAGS} tags`);
  return out;
}

/** Tickets stored before tags existed have none. */
const withTags = (t) => (t && !Array.isArray(t.tags) ? { ...t, tags: [] } : t);

/** Business rules for tickets. */
export function createTicketService({ store, clock = systemClock }) {
  const mustGet = (id) => {
    const ticket = store.get(id);
    if (!ticket) throw new NotFoundError(`ticket ${id} not found`);
    return withTags(ticket);
  };

  return {
    create({ title, priority = "normal", assignee = null, tags } = {}) {
      if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
      return store.insert({
        title: checkTitle(title),
        priority,
        status: "open",
        assignee: checkAssignee(assignee),
        tags: checkTags(tags),
        createdAt: clock.now().toISOString(),
      });
    },

    get: (id) => mustGet(id),

    /** Tickets in id order, optionally filtered by status, assignee and/or tag. */
    list({ status, assignee, tag } = {}) {
      if (status !== undefined && !STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
      const wanted = tag === undefined ? undefined : checkTag(tag);
      return store
        .all()
        .map(withTags)
        .filter((t) => (status === undefined || t.status === status) && (assignee === undefined || t.assignee === assignee) && (wanted === undefined || t.tags.includes(wanted)));
    },

    assign(id, assignee) {
      mustGet(id);
      return withTags(store.update(id, { assignee: checkAssignee(assignee) }));
    },

    close(id) {
      const ticket = mustGet(id);
      if (ticket.status === "closed") throw new ConflictError(`ticket ${id} is already closed`);
      return withTags(store.update(id, { status: "closed" }));
    },

    addTag(id, tag) {
      const ticket = mustGet(id);
      const t = checkTag(tag);
      if (ticket.tags.includes(t)) return ticket;
      if (ticket.tags.length >= MAX_TAGS) throw new ValidationError(`at most ${MAX_TAGS} tags`);
      return store.update(id, { tags: [...ticket.tags, t] });
    },

    removeTag(id, tag) {
      const ticket = mustGet(id);
      const t = checkTag(tag);
      return store.update(id, { tags: ticket.tags.filter((x) => x !== t) });
    },

    /** [{ tag, open, total }] for every tag in use: by total descending, then tag ascending. */
    tagStats() {
      const stats = new Map();
      for (const t of store.all().map(withTags))
        for (const tag of t.tags) {
          const s = stats.get(tag) ?? { tag, open: 0, total: 0 };
          s.total++;
          if (t.status === "open") s.open++;
          stats.set(tag, s);
        }
      return [...stats.values()].sort((a, b) => b.total - a.total || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    },
  };
}
