import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "./useOrch";
import type { AgentCommand } from "./types";
import { baseName } from "./repoStatus";
import { transport } from "./transport";
import { parseMarkdown, type Inline } from "./markdown";
import { openExternal } from "./links";
import "./AgentM.scss";

/** Inline spans as elements; links open in the system browser (desktop) or a new tab. */
function Spans({ inline }: { inline: Inline[] }) {
  return (
    <>
      {inline.map((s, i) =>
        s.kind === "bold" ? (
          <strong key={i}>{s.text}</strong>
        ) : s.kind === "italic" ? (
          <em key={i}>{s.text}</em>
        ) : s.kind === "code" ? (
          <code key={i}>{s.text}</code>
        ) : s.kind === "link" ? (
          <a key={i} href={s.href} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, s.href)}>
            {s.text}
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** Agent M's answer, rendered from its Markdown as React elements (no HTML is injected). */
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => {
        if (b.kind === "code")
          return (
            <pre key={i}>
              <code>{b.text}</code>
            </pre>
          );
        if (b.kind === "heading") {
          const H = (["h4", "h4", "h5"] as const)[b.level - 1];
          return (
            <H key={i}>
              <Spans inline={b.inline} />
            </H>
          );
        }
        if (b.kind === "list") {
          const L = b.ordered ? "ol" : "ul";
          return (
            <L key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Spans inline={item} />
                </li>
              ))}
            </L>
          );
        }
        return (
          <p key={i}>
            <Spans inline={b.inline} />
          </p>
        );
      })}
    </div>
  );
}

export type CommandDecision = "allow" | "always" | "deny";
type Decide = (repo: string, id: string, decision: CommandDecision) => Promise<boolean>;

const OUTCOME: Record<string, { label: string; tone: string }> = {
  allow: { label: "allowed", tone: "done" },
  always: { label: "always allowed", tone: "done" },
  deny: { label: "denied", tone: "failed" },
  timeout: { label: "no answer, denied", tone: "failed" },
  cancelled: { label: "run stopped", tone: "" },
};

/** Commands still waiting in running runs, oldest first, and the answered ones (newest first). */
export function commandsOf(sessions: Record<string, Session>, order: string[]) {
  const waiting: { repo: string; c: AgentCommand }[] = [];
  const answered: { repo: string; c: AgentCommand }[] = [];
  for (const repo of order) {
    const run = sessions[repo]?.run;
    for (const c of run?.commands ?? []) {
      if (!c.decision && run?.status === "running") waiting.push({ repo, c });
      else answered.push({ repo, c: c.decision ? c : { ...c, decision: "cancelled" } });
    }
  }
  return { waiting, answered: answered.reverse() };
}

/** One command an agent wants to run: who asks, why, the exact command, and (while it waits) the answers. */
export function CommandCard({ repo, command, showRepo, onDecide }: { repo: string; command: AgentCommand; showRepo?: boolean; onDecide?: Decide }) {
  const [busy, setBusy] = useState(false);
  const decide = async (d: CommandDecision) => {
    setBusy(true);
    if (!(await onDecide?.(repo, command.id, d))) setBusy(false);
  };
  const outcome = command.decision ? (OUTCOME[command.decision] ?? { label: command.decision, tone: "" }) : null;
  return (
    <div className={`approval command-card ${outcome ? "answered" : ""}`}>
      <div className="row">
        <strong>
          {showRepo && `${baseName(repo)} · `}
          {command.agent}
          {command.round ? ` · Round ${command.round}` : ""}
        </strong>
        <span className={`badge ${outcome ? outcome.tone : "warn"}`}>{outcome ? outcome.label : "waiting for you"}</span>
      </div>
      {command.description && <p>{command.description}</p>}
      <pre className="command-line" aria-label={`${command.tool} command`}>
        <span className="muted">{command.tool === "PowerShell" ? "PS> " : "$ "}</span>
        {command.command}
      </pre>
      {!outcome && onDecide && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => decide("allow")}>
            Allow
          </button>
          {!command.noAlways && (
            <button
              disabled={busy}
              onClick={() => decide("always")}
              title="Allow it now, and this exact command in later runs of this repo without asking (config.json allow)."
            >
              Always allow
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => decide("deny")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** One line of the Agent M conversation. */
export type ChatMessage = { role: "you" | "agent"; text: string; cost?: number; error?: boolean };

/** The conversation with Agent M, kept by the app so it survives switching pages. */
export function useAgentMChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const session = useRef<string | undefined>(undefined);
  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q) return;
    setMessages((m) => [...m, { role: "you", text: q }]);
    setBusy(true);
    try {
      const r = await transport.agentMAsk(q, session.current);
      session.current = r.session ?? session.current;
      setMessages((m) => [...m, { role: "agent", text: r.answer, cost: r.cost }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "agent", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => {
    session.current = undefined;
    setMessages([]);
  }, []);
  return { messages, busy, ask, reset };
}
export type AgentMChat = ReturnType<typeof useAgentMChat>;

const SUGGESTIONS = ["Which MCP servers are connected?", "Why did the last run fail?", "What is left in my queues?", "Is my setup ready to run agents?"];

function Chat({ chat }: { chat: AgentMChat }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  // A block body: scrollIntoView returns a Promise in newer browsers, and React would call a returned value as the cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [chat.messages.length, chat.busy]);
  const send = (q: string) => {
    if (!q.trim() || chat.busy) return;
    setText("");
    void chat.ask(q);
  };
  return (
    <section className="card agent-m-chat" aria-label="Ask Agent M">
      <div className="card-head">
        <h3>Ask Agent M</h3>
        {chat.messages.length > 0 && (
          <button className="ghost" disabled={chat.busy} onClick={chat.reset}>
            New conversation
          </button>
        )}
      </div>
      <div className="agent-m-messages" aria-live="polite">
        {chat.messages.length === 0 && (
          <div className="agent-m-suggestions">
            <p className="muted">Questions about your setup, tools, plugins, MCP servers, repos, queues and runs.</p>
            <div className="row">
              {SUGGESTIONS.map((s) => (
                <button key={s} disabled={chat.busy} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.messages.map((m, i) => (
          <div key={i} className={`agent-m-msg ${m.role} ${m.error ? "error" : ""}`}>
            <span className="who">{m.role === "you" ? "You" : "Agent M"}</span>
            {m.role === "agent" && !m.error ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            {m.cost !== undefined && m.cost > 0 && <span className="muted cost">${m.cost.toFixed(3)}</span>}
          </div>
        ))}
        {chat.busy && (
          <div className="agent-m-msg agent">
            <span className="who">Agent M</span>
            <p className="muted">Looking at your repos…</p>
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="agent-m-ask"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          aria-label="Question for Agent M"
          placeholder="Ask about your setup or repos (Enter sends, Shift+Enter for a new line)"
          rows={2}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        <button className="primary" type="submit" disabled={chat.busy || !text.trim()}>
          {chat.busy ? "Thinking…" : "Ask"}
        </button>
      </form>
      <p className="muted small">Haiku reads your repos to answer and never changes them. Its cost counts toward the daily budget.</p>
    </section>
  );
}

/** Agent M: answers questions about the setup and repos, and every repo's agents ask here before a shell command runs (--commands). */
export function AgentMPanel({
  sessions,
  order,
  decide,
  chat,
}: {
  sessions: Record<string, Session>;
  order: string[];
  /** Sends the answer; throws when orch refuses it (already answered, run gone). */
  decide: (repo: string, id: string, decision: CommandDecision) => Promise<void>;
  chat: AgentMChat;
}) {
  const { waiting, answered } = commandsOf(sessions, order);
  const [error, setError] = useState("");
  // Gather the machine status now, while the user reads or types, so the first answer does not wait for it.
  useEffect(() => {
    transport.agentMWarm().catch(() => {
      /* only a head start: asking still works without it */
    });
  }, []);
  const onDecide: Decide = async (repo, id, decision) => {
    setError("");
    try {
      await decide(repo, id, decision);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <div className="agent-m-page">
      <header className="page-head">
        <div className="page-title">
          <h2>Agent M</h2>
          <p className="muted">Ask about your setup and repos, and allow or deny the shell commands your agents want to run.</p>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {waiting.length > 0 && (
        <section className="agent-m-list" aria-label="Commands waiting for you">
          <h3>Waiting for you</h3>
          {waiting.map(({ repo, c }) => (
            <CommandCard key={`${repo}:${c.id}`} repo={repo} command={c} showRepo onDecide={onDecide} />
          ))}
        </section>
      )}

      <Chat chat={chat} />

      <section className="agent-m-list" aria-label="Commands">
        {waiting.length === 0 && (
          <p className="muted small">
            No command is waiting. Agents ask here when a run has <strong>Commands via Agent M</strong> on (run settings, or <code>--commands</code>). Only
            implementers ask; the architect, QA and reviewers stay read-only. An unanswered command is denied after 10 minutes.
          </p>
        )}
        {answered.length > 0 && (
          <details>
            <summary>Answered commands ({answered.length})</summary>
            <div className="agent-m-list">
              {answered.slice(0, 20).map(({ repo, c }) => (
                <CommandCard key={`${repo}:${c.id}`} repo={repo} command={c} showRepo />
              ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
