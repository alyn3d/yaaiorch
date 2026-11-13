// Puts the Node.js binary the desktop app ships with into src-tauri/binaries/node-<target triple>[.exe], where Tauri's
// externalBin picks it up and installs it next to the app, so users need no Node.js of their own.
//
//   node scripts/fetch-node.mjs [--target <rust target triple>]
//
// The target comes from --target, else TAURI_ENV_TARGET_TRIPLE (set by `tauri build/dev`), else the host (rustc -vV).
// The official build is downloaded from nodejs.org and checked against its SHASUMS256.txt before it is used.
// universal-apple-darwin also places the x64 and arm64 builds (Tauri's per-architecture builds look for them) and
// fuses them with lipo into the universal one (macOS only). A binary already in place for the
// same version is kept, so repeated builds do not download again.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Node.js release the app bundles (an LTS line). Bump it for security releases. */
const VERSION = "22.14.0";
const DIST = {
  "x86_64-pc-windows-msvc": { name: "win-x64", ext: "zip" },
  "aarch64-pc-windows-msvc": { name: "win-arm64", ext: "zip" },
  "x86_64-apple-darwin": { name: "darwin-x64", ext: "tar.gz" },
  "aarch64-apple-darwin": { name: "darwin-arm64", ext: "tar.gz" },
  "x86_64-unknown-linux-gnu": { name: "linux-x64", ext: "tar.gz" },
  "aarch64-unknown-linux-gnu": { name: "linux-arm64", ext: "tar.gz" },
};

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "src-tauri", "binaries");

function targetTriple() {
  const i = process.argv.indexOf("--target");
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
  if (!host) throw new Error("could not tell the target triple: pass --target");
  return host;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

let sums;
/** The official SHA-256 of a release file, from the release's SHASUMS256.txt. */
async function officialSum(file) {
  sums ??= (await get(`https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt`)).toString("utf8");
  const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${file}`));
  if (!line) throw new Error(`${file} is not in SHASUMS256.txt for v${VERSION}`);
  return line.split(/\s+/)[0];
}

/** Download, verify and extract one platform's node binary into `dest`. */
async function fetchOne(triple, dest) {
  const d = DIST[triple];
  if (!d) throw new Error(`no Node.js build for ${triple}; known: ${Object.keys(DIST).join(", ")}`);
  const base = `node-v${VERSION}-${d.name}`;
  const file = `${base}.${d.ext}`;
  console.log(`fetch-node: downloading ${file}`);
  const data = await get(`https://nodejs.org/dist/v${VERSION}/${file}`);
  const sum = createHash("sha256").update(data).digest("hex");
  const want = await officialSum(file);
  if (sum !== want) throw new Error(`${file}: SHA-256 ${sum} does not match the official ${want}`);
  const tmp = mkdtempSync(join(tmpdir(), "yaaiorch-node-"));
  try {
    const archive = join(tmp, file);
    writeFileSync(archive, data);
    const member = d.ext === "zip" ? `${base}/node.exe` : `${base}/bin/node`;
    // Windows' own bsdtar reads zip files; the tar of Git for Windows (often first on PATH) does not.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", archive, "-C", tmp, member], { stdio: "inherit" });
    copyFileSync(join(tmp, member), dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** binaries/node-<triple>[.exe], downloaded (or fused) unless the same version is already there. */
async function ensure(triple, make) {
  const out = join(binDir, `node-${triple}${triple.includes("windows") ? ".exe" : ""}`);
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
    console.log(`fetch-node: node v${VERSION} for ${triple} is already in place`);
    return out;
  }
  mkdirSync(binDir, { recursive: true });
  await make(out);
  writeFileSync(stamp, VERSION);
  console.log(`fetch-node: node v${VERSION} for ${triple} -> ${out}`);
  return out;
}

const triple = targetTriple();
if (triple === "universal-apple-darwin") {
  // `tauri build --target universal-apple-darwin` builds each architecture on its own first, and each of those
  // builds checks for its own sidecar; the universal app then gets the fused one. So all three must exist.
  const x64 = await ensure("x86_64-apple-darwin", (out) => fetchOne("x86_64-apple-darwin", out));
  const arm = await ensure("aarch64-apple-darwin", (out) => fetchOne("aarch64-apple-darwin", out));
  await ensure("universal-apple-darwin", (out) => {
    execFileSync("lipo", ["-create", x64, arm, "-output", out], { stdio: "inherit" });
    chmodSync(out, 0o755);
  });
} else await ensure(triple, (out) => fetchOne(triple, out));
