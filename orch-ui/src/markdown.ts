// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// A small Markdown subset for Agent M's answers: headings, paragraphs, bullet and numbered lists, fenced code,
// and inline bold, italic, code and links. Pure (no HTML is produced), so the UI renders it as React elements
// and nothing in an answer can inject markup. Unit-tested.

export type Inline = { kind: "text" | "bold" | "italic" | "code"; text: string } | { kind: "link"; text: string; href: string };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; lang: string; text: string };

/** Inline spans: `code` first (its content is literal), then **bold**, *italic* / _italic_, and [text](http… url). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*)\*|(?<![\w])_([^_\s][^_\n]*)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: "bold", text: m[2] ?? m[3] });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ kind: "italic", text: m[4] ?? m[5] });
    else out.push({ kind: "link", text: m[6], href: m[7] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;

/** Blocks of a Markdown text. Unknown syntax stays as plain text; an unclosed code fence runs to the end. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", inline: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: Math.min(3, heading[1].length) as 1 | 2 | 3, inline: parseInline(heading[2]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const prev = blocks.at(-1);
      const item = parseInline((bullet ?? numbered)![1]);
      if (prev?.kind === "list" && prev.ordered === ordered) prev.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    // A wrapped line right after a list item continues that item.
    const prev = blocks.at(-1);
    if (!para.length && prev?.kind === "list" && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1].push({ kind: "text", text: " " }, ...parseInline(line.trim()));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
