import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EDITORS, editorUrl, fileManager, type EditorId } from "./editorLinks";
import { isTauri, transport } from "./transport";

const EDITOR_KEY = "yaaiorch.editor";
const FILES = fileManager(navigator.userAgent);

function savedEditor(): EditorId {
  try {
    const v = localStorage.getItem(EDITOR_KEY);
    return EDITORS.some((e) => e.id === v) ? (v as EditorId) : "vscode";
  } catch {
    return "vscode";
  }
}

/** "Open in VS Code" (the editor last used) plus a menu with the other editors and the system file manager. */
export function OpenIn({ repo }: { repo: string }) {
  const [editor, setEditor] = useState<EditorId>(savedEditor);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const label = EDITORS.find((e) => e.id === editor)!.label;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const openEditor = async (id: EditorId) => {
    setOpen(false);
    setError("");
    setEditor(id);
    try {
      localStorage.setItem(EDITOR_KEY, id);
    } catch {
      /* remembered for this session only */
    }
    const url = editorUrl(id, repo);
    // The editor's URL scheme does the work; nothing happens when that editor is not installed.
    if (isTauri) await openUrl(url).catch((e) => setError(`could not open ${url}: ${e}`));
    else window.location.href = url;
  };
  const reveal = async () => {
    setOpen(false);
    setError("");
    await transport.revealRepo(repo).catch((e: Error) => setError(e.message));
  };
  const keys = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      setOpen(false);
      toggle.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };

  return (
    <div className="open-in" ref={wrap}>
      <div className="split-button">
        <button title={`Open this folder in ${label}`} onClick={() => openEditor(editor)}>
          Open in {label}
        </button>
        <button ref={toggle} aria-label="More ways to open this repo" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="menu" role="menu" ref={menu} onKeyDown={keys}>
          {EDITORS.map((e) => (
            <button key={e.id} role="menuitem" onClick={() => openEditor(e.id)}>
              Open in {e.label}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={reveal}>
            Show in {FILES}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
