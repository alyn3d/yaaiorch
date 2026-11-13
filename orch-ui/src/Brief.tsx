import { useEffect, useState } from "react";
import type { Proposal } from "./useOrch";

/** A goal being edited: `key` stays the same through edits and moves; `after` holds the keys of goals it needs. */
type Draft = { key: number; goal: string; after: number[] };
let nextKey = 1;

const draftKey = (repo: string) => `yaaiorch.brief:${repo}`;
const loadDraft = (repo: string) => {
  try {
    return localStorage.getItem(draftKey(repo)) ?? "";
  } catch {
    return "";
  }
};

/**
 * A big brief: the architect splits it into goals (`orch split --propose`), you edit the list, then queue it, or queue
 * it and start the loop. The brief is kept in .orchestrator/spec.md for every goal's architect and a coverage check.
 */
export function BriefBox({
  repo,
  busy,
  disabled,
  proposal,
  call,
  opts,
}: {
  repo: string;
  busy: boolean;
  disabled: boolean;
  proposal?: Proposal;
  call: (path: string, body?: Record<string, unknown>) => Promise<boolean>;
  opts: Record<string, unknown>;
}) {
  const [brief, setBrief] = useState(() => loadDraft(repo));
  const [goals, setGoals] = useState<Draft[]>([]);
  const [shownAt, setShownAt] = useState<number | null>(null);
  const [working, setWorking] = useState(false);

  // A new proposal from the architect replaces the list being edited.
  useEffect(() => {
    if (proposal && proposal.at !== shownAt) {
      const keys = proposal.goals.map(() => nextKey++);
      // `after` from orch: 1-based positions of the goals each one needs.
      setGoals(proposal.goals.map((goal, i) => ({ key: keys[i], goal, after: (proposal.after?.[i] ?? []).map((p) => keys[p - 1]).filter(Boolean) })));
      setShownAt(proposal.at);
    }
  }, [proposal, shownAt]);

  const save = (text: string) => {
    setBrief(text);
    try {
      localStorage.setItem(draftKey(repo), text);
    } catch {
      /* storage blocked: the draft lives until reload */
    }
  };
  const edit = (i: number, text: string) => setGoals(goals.map((g, j) => (j === i ? { ...g, goal: text } : g)));
  const remove = (i: number) => {
    const gone = goals[i].key;
    setGoals(goals.filter((_, j) => j !== i).map((g) => ({ ...g, after: g.after.filter((k) => k !== gone) })));
  };
  /** Positions (1-based) of the goals `g` needs that come before it in the list as it is now. */
  const needsOf = (g: Draft, list: Draft[]) => g.after.map((k) => list.findIndex((x) => x.key === k) + 1).filter((p) => p > 0 && p < list.indexOf(g) + 1);
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= goals.length) return;
    const next = [...goals];
    [next[i], next[j]] = [next[j], next[i]];
    setGoals(next);
  };
  const kept = goals.filter((g) => g.goal.trim());
  const clean = kept.map((g) => ({ goal: g.goal.trim(), after: needsOf(g, kept) }));
  const queue = async (start: boolean) => {
    setWorking(true);
    const ok = await call("split-accept", { brief, goals: clean });
    if (ok) {
      setGoals([]);
      if (start) await call("loop", { ...opts, untilEmpty: true });
    }
    setWorking(false);
  };

  return (
    <details className="brief-box" open={!!goals.length || undefined}>
      <summary>Big brief</summary>
      <p className="muted">
        Paste a whole brief or spec. The architect splits it into goals in build order; you edit the list, then queue it. Every goal's architect also reads the
        brief, and when the queue runs dry a coverage check queues what is still missing.
      </p>
      <textarea rows={8} placeholder="What should be built, in as much detail as you have" value={brief} onChange={(e) => save(e.target.value)} />
      <div className="row">
        <button
          disabled={busy || disabled || !brief.trim()}
          title="One read-only architect call at this power tier; it reads the repo and proposes goals. Nothing is queued yet."
          onClick={() => call("split", { brief, ...opts })}
        >
          Split into goals
        </button>
        {proposal && <span className="muted">{proposal.goals.length} goals proposed</span>}
      </div>
      {goals.length > 0 && (
        <div className="proposal">
          <ol>
            {goals.map((g, i) => (
              <li key={g.key}>
                <span className="num">{i + 1}.</span>
                <span className="goal">
                  <textarea rows={2} value={g.goal} onChange={(e) => edit(i, e.target.value)} />
                  {needsOf(g, goals).length > 0 && (
                    <span className="muted" title="Not run if one of these fails">
                      after {needsOf(g, goals).join(", ")}
                    </span>
                  )}
                </span>
                <span className="moves">
                  <button title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button title="Later" disabled={i === goals.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button title="Remove" onClick={() => remove(i)}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="row">
            <button onClick={() => setGoals([...goals, { key: nextKey++, goal: "", after: goals.map((g) => g.key) }])}>+ Add goal</button>
            <button onClick={() => setGoals([])}>Discard</button>
            <span className="spacer" />
            <button disabled={working || !clean.length} onClick={() => queue(false)}>
              Queue {clean.length} goals
            </button>
            <button
              className="primary"
              disabled={working || busy || disabled || !clean.length}
              title="Queue them and run the queue until it is empty, with the run settings above"
              onClick={() => queue(true)}
            >
              Queue and start
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
