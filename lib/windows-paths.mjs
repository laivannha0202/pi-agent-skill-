// Windows path namespace bridge.
//
// A model that learned its workspace path from a Git-Bash `pwd` sees
// `/d/Code/repo`. Node's `path` on Windows reads that leading "/" as
// drive-root-relative, so `path.resolve(root, "/d/Code/repo/lib/a.mjs")` becomes
// `D:\d\Code\repo\lib\a.mjs` and every containment check reports "escapes
// workspace root" for a file that is inside the workspace. That is a false red
// error the model cannot fix by retrying.
//
// The bridge is deliberately narrow and deterministic:
//   * only on win32,
//   * only for `/x/...` and `/cygdrive/x/...` drive forms (single letter),
//   * `/tmp/...` and `/var/tmp/...` are left untouched (their namespace is
//     handled by the portable temp-path guard, not remapped),
//   * a drive-form string always maps, so the same input resolves the same way
//     whether or not the file exists (a missing mapped file then fails with a
//     real "no such file" error instead of a bogus containment error).
//
// Windows containment is also case-insensitive: `D:\Code\Repo` and
// `d:\code\repo` are the same directory, and comparing bytes rejected the
// second one.

import path from "node:path"

const MSYS_DRIVE = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/

function platformName(platform) {
  return String(platform || process.platform || "").toLowerCase()
}

export function toNativePath(value, platform = process.platform) {
  const raw = String(value ?? "")
  if (!raw || platformName(platform) !== "win32") return raw
  const match = MSYS_DRIVE.exec(raw)
  if (!match) return raw
  const drive = match[1].toUpperCase() + ":"
  const rest = raw.slice(match[0].length)
  if (!rest) return drive + "\\"
  return drive + rest.replaceAll("/", "\\")
}

export function insideWorkspace(root, target, platform = process.platform) {
  const rawBase = String(root || "")
  const rawTarget = String(target || "")
  if (!rawBase || !rawTarget) return false
  const caseInsensitive = platformName(platform) === "win32"
  const base = caseInsensitive ? rawBase.toLowerCase() : rawBase
  const value = caseInsensitive ? rawTarget.toLowerCase() : rawTarget
  // A drive root ("D:\\") or the POSIX root ("/") keeps its separator, so the
  // comparison prefix must not become "\\\\".
  const trimmed = base.replace(/[\\/]+$/, "")
  if (!trimmed) return value.startsWith(base)
  if (value === trimmed) return true
  return value.startsWith(trimmed + "/") || value.startsWith(trimmed + "\\")
}

// Resolve a model-supplied path against a workspace root. Returns the absolute
// request plus the MSYS source string when a mapping was adopted, so callers can
// report the normalized path in their evidence instead of the raw one.
export function resolveWorkspaceTarget(root, relative, options = {}) {
  const platform = options.platform || process.platform
  const base = path.resolve(root)
  const raw = String(relative ?? "")
  const native = toNativePath(raw, platform)
  if (native !== raw) return { base, requested: path.resolve(native), msysPath: raw }
  return { base, requested: path.resolve(base, raw), msysPath: null }
}
