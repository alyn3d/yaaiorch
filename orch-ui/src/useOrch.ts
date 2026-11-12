import { useCallback, useEffect, useState } from "react";
import type { Finding, OrchEvent, RunView, State } from "./types";
import { reduce } from "./reduce";
import { transport, type SessionInit } from "./transport";

/** Everything the UI knows about one repo. */
export type Session = { state: State; log: string[]; run: RunView | null };

const stopped = (): OrchEvent => ({ type: "stopped", t: Date.now() });
const MAX_LOG = 5000;

function fromInit(s: SessionInit): Session {
  const replayed = (s.events as OrchEvent[]).reduce<RunView | null>(reduce, null);
  return { state: s.state, log: s.log, run: s.state.running ? replayed : reduce(replayed, stopped()) };
}

/** Sessions for every open repo, keyed by repo path, plus the order of the tabs. */
export function useOrch() {
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [maxParallel, setMaxParallelState] = useState(2);
  const [connected, setConnected] = useState(false);

  useEffect(
    () =>
      transport.subscribe({
        onInit: (d) => {
          setSessions(Object.fromEntries(d.sessions.map((s) => [s.state.repo, fromInit(s)])));
          setOrder(d.sessions.map((s) => s.state.repo));
          setMaxParallelState(d.maxParallel);
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
        onEvent: (repo, e) => setSessions((all) => (all[repo] ? { ...all, [repo]: { ...all[repo], run: reduce(all[repo].run, e) } } : all)),
        onConnection: setConnected,
      }),
    [],
  );

  const setMaxParallel = useCallback(async (n: number) => {
    await transport.setMaxParallel(n);
  }, []);

  return { sessions, order, maxParallel, setMaxParallel, connected, canPickRepo: transport.canPickRepo };
}

/** Doctor findings for one repo: on open, and whenever its process ends. */
export function useFindings(repo: string, busy: boolean) {
  const [findings, setFindings] = useState<Finding[]>([]);
  useEffect(() => {
    if (busy) return;
    let live = true;
    transport.doctor(repo).then((f) => live && setFindings(f), (e) => live && setFindings([{ name: "doctor", level: "fail", detail: String(e) }]));
    return () => {
      live = false;
    };
  }, [repo, busy]);
  return findings;
}
