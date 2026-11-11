import { useCallback, useEffect, useState } from "react";
import type { OrchEvent, RunView, State } from "./types";
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

  const pickRepo = useCallback(async () => {
    setError("");
    try {
      await transport.pickRepo();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  return { state, log, run, error, connected, call, pickRepo, canPickRepo: transport.canPickRepo };
}
