// Which run events deserve a desktop notification, and what it says. Pure, so it can be unit-tested.

type Ev = { type: string; [k: string]: unknown };

/** A notification for this event, or null. `repo`: the repo's folder name; `goal`: the goal being run, if known. */
export function notificationFor(repo: string, goal: string | undefined, e: Ev): { title: string; body: string } | null {
  const what = goal ? goal.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  switch (e.type) {
    case "goal_end":
      if (e.usageLimit) return null; // the waiting event says it better
      return e.passed
        ? { title: `${repo}: goal passed`, body: what || "QA passed." }
        : { title: `${repo}: goal failed`, body: [what, typeof e.error === "string" ? e.error : ""].filter(Boolean).join("\n") || "QA did not pass." };
    case "approval_wait":
      return { title: `${repo}: plan waiting for you`, body: typeof e.summary === "string" && e.summary ? e.summary : "Build it, edit it or send it back." };
    case "waiting": {
      const until = typeof e.until === "number" ? new Date(e.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "later";
      return e.reason === "usage_cap"
        ? { title: `${repo}: paused at your usage cap`, body: `Continues after ${until}.` }
        : { title: `${repo}: Claude usage limit reached`, body: `Waiting until ${until}, then it carries on.` };
    }
    case "loop_stop":
      return e.reason === "budget" ? { title: `${repo}: queue stopped`, body: "The loop budget is used up." } : null;
    default:
      return null;
  }
}
