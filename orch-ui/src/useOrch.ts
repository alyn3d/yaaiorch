import { useCallback, useEffect, useRef, useState } from "react";
import type { Finding, Global, OrchEvent, RunView, State } from "./types";
import { reduce } from "./reduce";
import { transport, type SessionInit } from "./transport";
import { notify } from "./notify";
import { notificationFor } from "./notifyText";
import { baseName } from "./repoStatus";

/** The architect's split of a big brief (`split_proposal`), waiting to be edited and queued. */
export type Proposal = { goals: string[]; at: number };
/** Everything the UI knows about one repo. */
export type Session = { state: State; log: string[]; run: RunView | null; proposal?: Proposal };

const proposalOf = (e: OrchEvent): Proposal | undefined =>
  e.type === "split_proposal" && Array.isArray(e.goals) ? { goals: e.goals.filter((g: unknown) => typeof g === "string"), at: e.t } : undefined;

const stopped = (): OrchEvent => ({ type: "stopped", t: Date.now() });
const MAX_LOG = 5000;

function fromInit(s: SessionInit): Session {
  const replayed = (s.events as OrchEvent[]).reduce<RunView | null>(reduce, null);
  const proposal = (s.events as OrchEvent[]).map(proposalOf).filter(Boolean).at(-1);
  return { state: s.state, log: s.log, run: s.state.running ? replayed : reduce(replayed, stopped()), proposal };
}

/** Sessions for every open repo, keyed by repo path, plus the order of the tabs. */
export function useOrch() {
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [maxParallel, setMaxParallelState] = useState(2);
  const [connected, setConnected] = useState(false);
  const [global, setGlobal] = useState<Global>({
    usageLimit: null,
    budget: { limit: null, spent: 0, day: "" },
    usage: {},
    usageCap: { fiveHour: null, week: null },
  });

  /** The goal each repo is running, for notification texts (live events only; replays never notify). */
  const goals = useRef(new Map<string, string>());

  useEffect(
    () =>
      transport.subscribe({
        onInit: (d) => {
          setSessions(Object.fromEntries(d.sessions.map((s) => [s.state.repo, fromInit(s)])));
          setOrder(d.sessions.map((s) => s.state.repo));
          setMaxParallelState(d.maxParallel);
          if (d.global) setGlobal(d.global);
        },
        onSession: (state) =>
          setSessions((all) => {
            const cur = all[state.repo] ?? { state, log: [], run: null };
            // Backends report the exit only after all output is read, so a run still "running"
            // at this point never got its goal_end.
            return { ...all, [state.repo]: { ...cur, state, run: state.running ? cur.run : reduce(cur.run, stopped()) } };
          }),
        onLog: (repo, line) =>
          setSessions((all) => (all[repo] ? { ...all, [repo]: { ...all[repo], log: [...all[repo].log.slice(-(MAX_LOG - 1)), line] } } : all)),
        onEvent: (repo, e) => {
          if (e.type === "goal_start" && typeof e.goal === "string") goals.current.set(repo, e.goal);
          const n = notificationFor(baseName(repo), goals.current.get(repo), e);
          if (n) void notify(n);
          const proposal = proposalOf(e);
          setSessions((all) => (all[repo] ? { ...all, [repo]: { ...all[repo], run: reduce(all[repo].run, e), ...(proposal ? { proposal } : {}) } } : all));
        },
        onGlobal: setGlobal,
        onConnection: setConnected,
      }),
    [],
  );

  const setMaxParallel = useCallback(async (n: number) => {
    await transport.setMaxParallel(n);
  }, []);

  return { sessions, order, maxParallel, setMaxParallel, global, connected, canPickRepo: transport.canPickRepo };
}

/** Doctor findings for one repo: on open, and whenever its process ends. */
export function useFindings(repo: string, busy: boolean) {
  const [findings, setFindings] = useState<Finding[]>([]);
  useEffect(() => {
    if (busy) return;
    let live = true;
    transport.doctor(repo).then(
      (f) => live && setFindings(f),
      (e) => live && setFindings([{ name: "doctor", level: "fail", detail: String(e) }]),
    );
    return () => {
      live = false;
    };
  }, [repo, busy]);
  return findings;
}
