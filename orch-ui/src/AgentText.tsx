// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { parseMarkdown, structureText, type Block, type Inline } from "./markdown";
import { openExternal } from "./links";

/** Inline spans as elements; links open in the system browser (desktop) or a new tab. */
export function Spans({ inline }: { inline: Inline[] }) {
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

function Blocks({ blocks, className }: { blocks: Block[]; className?: string }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      {blocks.map((b, i) => {
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

/** Markdown as React elements (no HTML is injected), exactly as written: Agent M's answers. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <Blocks blocks={parseMarkdown(text)} className={className} />;
}

/**
 * Text an agent wrote (a plan, a goal, a contract, a report, a failure): its Markdown rendered, and a long single
 * paragraph split into one bullet per sentence (`structureText`). Text that stays one paragraph renders inline, so it
 * can follow a label on the same line; anything longer becomes blocks.
 */
export function AgentText({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(structureText(text));
  if (blocks.length === 1 && blocks[0].kind === "paragraph")
    return (
      <span className={`md-inline${className ? ` ${className}` : ""}`}>
        <Spans inline={blocks[0].inline} />
      </span>
    );
  return <Blocks blocks={blocks} className={className} />;
}
