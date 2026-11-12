import type { Session } from "./useOrch";
import { baseName, repoStatus, usd } from "./repoStatus";

const elapsed = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** One row per repo: what it does now, its goal, round, tasks, cost and queue, with Open and Stop. */
export function Overview({ sessions, order, now, onOpen, onStop }: {
  sessions: Record<string, Session>;
  order: string[];
  now: number;
  onOpen(repo: string): void;
  onStop(repo: string): void;
}) {
  return (
    <section className="card overview">
      <h2>All repos</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Status</th>
              <th>Goal</th>
              <th>Round</th>
              <th>Tasks</th>
              <th className="num">Cost</th>
              <th className="num">Queue</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {order.map((repo) => {
              const s = sessions[repo];
              if (!s) return null;
              const st = repoStatus(s, now);
              const run = s.run;
              const live = !!s.state.running;
              const round = run?.rounds.at(-1);
              const tasks = round?.tasks ?? [];
              const done = tasks.filter((t) => t.status !== "queued" && t.status !== "running").length;
              const active = tasks.filter((t) => t.status === "running").map((t) => t.agent);
              const goal = run?.goal ?? s.state.lastRun?.goal ?? "";
              const cost = run?.cost ?? s.state.lastRun?.cost;
              const pending = s.state.queue.filter((i) => i.status === "pending").length;
              const busy = live || !!s.state.queued;
              // The tab's label repeats the goal; here the goal has its own column, so say what phase it is in.
              const phase = !live || st.tone === "warn" ? st.label
                : round?.architect === "running" ? "planning"
                : active.some((a) => a === "qa") || tasks.some((t) => t.phase === "verify" && t.status === "running") ? "verifying"
                : active.length ? "building"
                : round && round.passed === undefined && tasks.length && done === tasks.length ? "checks"
                : "running";
              return (
                <tr key={repo}>
                  <td>
                    <button className="link" onClick={() => onOpen(repo)} title={repo}>
                      <span className={`status ${st.tone}`} aria-hidden /> {baseName(repo)}
                    </button>
                  </td>
                  <td className="muted">
                    {phase}
                    {live && run && run.status === "running" && <> · {elapsed(now - run.startedAt)}</>}
                  </td>
                  <td className="goal" title={goal}>{goal || <span className="muted">—</span>}</td>
                  <td>{round ? `${round.round}/${run!.maxRounds}` : "—"}{round?.mode === "direct" ? " fast" : ""}</td>
                  <td>
                    {tasks.length ? `${done}/${tasks.length}` : "—"}
                    {active.length > 0 && <span className="muted"> ({active.join(", ")})</span>}
                  </td>
                  <td className="num cost">{cost !== undefined ? usd(cost) : "—"}{run?.maxCost ? <span className="muted"> / {usd(run.maxCost)}</span> : null}</td>
                  <td className="num">{pending || "—"}</td>
                  <td className="actions">
                    <button onClick={() => onOpen(repo)}>Open</button>
                    <button className="danger" disabled={!busy} onClick={() => onStop(repo)}>{s.state.queued && !live ? "Cancel" : "Stop"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
