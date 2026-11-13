/** Editors a repo can be opened in, through the URL scheme each one registers when installed (no process spawned). */
export const EDITORS = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "windsurf", label: "Windsurf" },
  { id: "vscode-insiders", label: "VS Code Insiders" },
] as const;
export type EditorId = (typeof EDITORS)[number]["id"];

/** `vscode://file/D:/code/my%20app`: the folder opens in a new window of that editor. */
export function editorUrl(editor: EditorId, repo: string): string {
  const p = repo.replace(/\\/g, "/");
  return `${editor}://file${encodeURI(p.startsWith("/") ? p : `/${p}`).replace(/[?#]/g, encodeURIComponent)}`;
}

/** What the system file manager is called on this platform. */
export function fileManager(platform: string): string {
  return /win/i.test(platform) && !/darwin/i.test(platform) ? "Explorer" : /mac|darwin/i.test(platform) ? "Finder" : "file manager";
}
