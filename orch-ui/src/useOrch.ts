import { useCallback, useEffect, useState } from "react";
import type { Finding, OrchEvent, RunView, State } from "./types";
import { reduce } from "./reduce";
import { transport } from "./transport";

const stopped = (): OrchEvent => ({ type: "stopped", t: Date.now() });

export function useOrch() {
  const [state, setState] = useState<State | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(
    () =>
      transport.subscribe({
        onInit: (d) => {
          setState(d.state);
          setLog(d.log);
          const replayed = (d.events as OrchEvent[]).reduce<RunView | null>(reduce, null);
          setRun(d.state.running ? replayed : reduce(replayed, stopped()));
        },
        onState: (s) => {
          setState(s);
          // Both backends report the exit only after all output is read, so a run still
          // "running" at this point never got its goal_end.
          if (!s.running) setRun((r) => reduce(r, stopped()));
        },
        onLog: (line) => setLog((l) => [...l.slice(-4999), line]),
        onEvent: (e) => setRun((r) => reduce(r, e)),
        onConnection: setConnected,
      }),
    [],
  );

  const call = useCallback(async (path: string, body?: Record<string, unknown>) => {
    setError("");
    try {
      await transport.call(path, body);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // First-run checks: on connect, on repo change, and whenever a process ends (a run or rollback may
  // have changed the tree or left a checkpoint behind).
  const [findings, setFindings] = useState<Finding[]>([]);
  const repo = state?.repo;
  const busy = !!state?.running;
  useEffect(() => {
    if (!repo || busy) return;
    let live = true;
    transport.doctor().then((f) => live && setFindings(f), (e) => live && setFindings([{ name: "doctor", level: "fail", detail: String(e) }]));
    return () => {
      live = false;
    };
  }, [repo, busy]);

  const pickRepo = useCallback(async () => {
    setError("");
    try {
      await transport.pickRepo();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  return { state, log, run, error, connected, call, pickRepo, canPickRepo: transport.canPickRepo, findings };
}
