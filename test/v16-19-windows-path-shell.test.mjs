// V16.19.0 WINDOWS RELIABILITY — reproduced environment defects.
//
// Every case below failed BEFORE the fix and is asserted through a shipped
// production entry point, not through a source marker:
//
//   * `lib/windows-paths.mjs` (the shared resolver the Node-side file surfaces
//     use for model-supplied paths),
//   * `readAnchoredCode` / `applyAnchoredFileEdits` (lib/code-intelligence),
//   * `ingestDocument` (lib/document-ingestion),
//   * `startService` containment guard (lib/service-manager),
//   * the shipped Pi extension `tool_result` handler (pi/extensions/ues.ts).
//
// WP-1..WP-5  A model that learned its workspace path from a Git-Bash `pwd`
//             (`/d/Code/repo`) hands that string to a Node tool. `path.resolve`
//             reads the leading "/" as drive-root-relative, so the request
//             resolved to `D:\d\Code\repo\...` and every read/document/edit
//             surface reported "escapes workspace root" — a false red error for
//             a file that is inside the workspace. Windows containment also
//             compared case-sensitively, so `d:\code\repo` failed the same way.
// WS-1..WS-4  Windows predicates exit 1 for "no match / not found":
//             `findstr` (no match) and `where` (not found). They were annotated
//             as IMPLEMENTATION_FAILURE, injecting a false failure delta and
//             feeding the repeated-failure guard.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import process from "node:process"

import { toNativePath, resolveWorkspaceTarget, insideWorkspace } from "../lib/windows-paths.mjs"
import { readAnchoredCode } from "../lib/code-intelligence/index.mjs"
import { ingestDocument } from "../lib/document-ingestion.mjs"
import { startService } from "../lib/service-manager.mjs"

const ROOT = process.cwd()
const EXT = path.join(ROOT, "pi", "extensions", "ues.ts")
const WINDOWS = process.platform === "win32"

// The exact string a Git-Bash `pwd` prints for a Windows path.
function msysPath(native) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(native))
  if (!match) return String(native)
  return "/" + match[1].toLowerCase() + "/" + match[2].replaceAll("\\", "/")
}

async function loadExtension() {
  const temp = path.join(os.tmpdir(), `ues-win-path-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
  let source = stripTypeScriptTypes(readFileSync(EXT, "utf8"), { mode: "strip", sourceUrl: "pi/extensions/ues.ts" })
  source = source.replace(/from "typebox"/g, `from "${pathToFileURL(path.join(ROOT, "node_modules", "typebox", "build", "index.mjs")).href}"`)
  source = source.replace(/from "\.\.\/\.\.\/lib\/([^"]+)"/g, (_, rel) => `from "${pathToFileURL(path.join(ROOT, "lib", rel)).href}"`)
  source = source.replace(/import\("\.\.\/\.\.\/lib\/([^"]+)"\)/g, (_, rel) => `import("${pathToFileURL(path.join(ROOT, "lib", rel)).href}")`)
  writeFileSync(temp, source, "utf8")
  try {
    const mod = await import(pathToFileURL(temp).href)
    return mod.default
  } finally {
    rmSync(temp, { force: true })
  }
}

function fakePi() {
  const handlers = new Map()
  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    getAllTools() { return [] },
    setActiveTools() {},
    getActiveTools() { return [] },
  }
  return {
    pi,
    async fire(event, payload = {}, eventCtx = {}) {
      const out = []
      for (const fn of handlers.get(event) || []) out.push(await fn(payload, eventCtx))
      return out
    },
  }
}

const ctx = { cwd: ROOT, ui: { confirm: async () => true, notify() {}, setTitle() {} } }

function bashFailure(command, exitCode, text) {
  return {
    type: "tool_result",
    toolCallId: "call-" + exitCode + "-" + command.length,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: text ?? "Command exited with code " + exitCode }],
    structuredContent: { output: "", truncated: false, exit_code: exitCode, wall_time_seconds: 0.1 },
    details: undefined,
    isError: true,
  }
}

function resultOf(values) {
  return values.find((value) => value && typeof value === "object")
}

test("WP-1: Git-Bash drive paths map to native Windows paths only on win32", () => {
  assert.equal(toNativePath("/d/Code/repo/lib/a.mjs", "win32"), "D:\\Code\\repo\\lib\\a.mjs")
  assert.equal(toNativePath("/cygdrive/c/Users/dev/a.txt", "win32"), "C:\\Users\\dev\\a.txt")
  // Not drive paths: unchanged (no invented mapping).
  assert.equal(toNativePath("/tmp/x", "win32"), "/tmp/x")
  assert.equal(toNativePath("/var/tmp/x", "win32"), "/var/tmp/x")
  assert.equal(toNativePath("lib/a.mjs", "win32"), "lib/a.mjs")
  assert.equal(toNativePath("D:\\Code\\repo", "win32"), "D:\\Code\\repo")
  // POSIX hosts keep MSYS-looking input untouched.
  assert.equal(toNativePath("/d/Code/repo", "linux"), "/d/Code/repo")
  assert.equal(toNativePath("/d/Code/repo", "darwin"), "/d/Code/repo")
})

test("WP-2: workspace containment is case-insensitive on win32 and exact elsewhere", () => {
  const root = "D:\\Code\\Repo"
  assert.equal(insideWorkspace(root, "D:\\Code\\Repo\\lib\\a.mjs", "win32"), true)
  assert.equal(insideWorkspace(root, "d:\\code\\repo\\lib\\a.mjs", "win32"), true)
  assert.equal(insideWorkspace(root, "D:\\Code\\Repo2\\a.mjs", "win32"), false)
  assert.equal(insideWorkspace(root, "D:\\Other\\a.mjs", "win32"), false)
  assert.equal(insideWorkspace("/repo", "/repo/lib/a.mjs", "linux"), true)
  assert.equal(insideWorkspace("/repo", "/Repo/lib/a.mjs", "linux"), false)
})

test("WP-3: the shared resolver adopts an MSYS path deterministically", () => {
  const mapped = resolveWorkspaceTarget("D:\\Code\\repo", "/d/Code/repo/lib/a.mjs", { platform: "win32" })
  assert.equal(mapped.requested, "D:\\Code\\repo\\lib\\a.mjs")
  assert.equal(mapped.msysPath, "/d/Code/repo/lib/a.mjs")
  // Same input, same resolution, whether or not the file exists: a missing
  // mapped file fails with a real "no such file" error, not a bogus escape.
  const missing = resolveWorkspaceTarget("D:\\Code\\repo", "/d/Code/repo/missing.mjs", { platform: "win32" })
  assert.equal(missing.requested, "D:\\Code\\repo\\missing.mjs")
  // POSIX hosts never remap.
  const posix = resolveWorkspaceTarget("/repo", "/d/Code/repo/lib/a.mjs", { platform: "linux" })
  assert.equal(posix.requested, path.resolve("/repo", "/d/Code/repo/lib/a.mjs"))
  assert.equal(posix.msysPath, null)
  // Non-drive POSIX temp paths are never remapped.
  const temp = resolveWorkspaceTarget("D:\\Code\\repo", "/tmp/x", { platform: "win32" })
  assert.equal(temp.requested, path.resolve("D:\\Code\\repo", "/tmp/x"))
})

test("WP-4: readAnchoredCode accepts the MSYS path a bash pwd printed", { skip: !WINDOWS }, async () => {
  const target = path.join(ROOT, "package.json")
  const read = await readAnchoredCode(ROOT, msysPath(target), { startLine: 1, endLine: 3 })
  assert.equal(read.file, "package.json")
  assert.match(read.text, /"name"/)
})

test("WP-4b: readAnchoredCode accepts a lower-case drive path", { skip: !WINDOWS }, async () => {
  const read = await readAnchoredCode(ROOT, path.join(ROOT, "package.json").toLowerCase(), { startLine: 1, endLine: 2 })
  assert.equal(read.file, "package.json")
})

test("WP-5: ingestDocument accepts the MSYS path a bash pwd printed", { skip: !WINDOWS }, async () => {
  const target = path.join(ROOT, "README.md")
  const document = await ingestDocument(ROOT, msysPath(target), { maxBytes: 4 * 1024 * 1024 })
  assert.equal(document.file, "README.md")
  assert.ok(document.markdown.length > 0)
})

test("WP-6: service cwd containment still rejects an MSYS path outside the workspace", { skip: !WINDOWS }, async () => {
  await assert.rejects(
    () => startService(ROOT, { name: "ues-win-path-guard", command: "node -e 0", cwd: "/c/Windows" }),
    /escapes workspace root/,
  )
})

test("WS-1: findstr exit 1 (no match) is a predicate, not a failure", async () => {
  const install = await loadExtension()
  const host = fakePi()
  install(host.pi)
  const returned = resultOf(await host.fire("tool_result", bashFailure('findstr /C:"ZZZ_NOT_PRESENT" README.md', 1, ""), ctx))
  assert.equal(returned?.details?.uesToolFailure, undefined, "findstr exit 1 must not be annotated as a failure")
})

test("WS-2: where exit 1 (not found) is a predicate, not a failure", async () => {
  const install = await loadExtension()
  const host = fakePi()
  install(host.pi)
  const returned = resultOf(await host.fire("tool_result", bashFailure("where nosuchbinary9191", 1, "INFO: Could not find files for the given pattern(s)."), ctx))
  assert.equal(returned?.details?.uesToolFailure, undefined, "where exit 1 must not be annotated as a failure")
})

test("WS-3: a genuine findstr error (exit 2) is still annotated", async () => {
  const install = await loadExtension()
  const host = fakePi()
  install(host.pi)
  const returned = resultOf(await host.fire("tool_result", bashFailure("findstr /C:foo missing-file.txt", 2, "FINDSTR: Cannot open missing-file.txt"), ctx))
  assert.ok(returned?.details?.uesToolFailure, "exit 2 is a real error and must stay FAIL")
  assert.equal(returned.structuredContent?.exit_code, 2, "exit code must be preserved")
})

test("WS-4: a real exit-1 failure of a non-predicate command is still annotated", async () => {
  const install = await loadExtension()
  const host = fakePi()
  install(host.pi)
  const returned = resultOf(await host.fire("tool_result", bashFailure("node scripts/check.mjs", 1, "checks failed"), ctx))
  assert.equal(returned?.details?.uesToolFailure?.class, "IMPLEMENTATION_FAILURE")
  assert.equal(returned?.details?.uesToolFailure?.retryable, true)
})
