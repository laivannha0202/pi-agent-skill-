// Cross-platform npm-script redirection regression suite.
//
// The old scripts used `> /dev/null`, which is not portable to Windows and can
// hide a failed eval. `scripts/run-quiet.mjs` must suppress ONLY stdout, keep
// stderr visible, and propagate the exact exit code without a shell.

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const REPO = path.resolve(import.meta.dirname, "..")
const HELPER = path.join(REPO, "scripts", "run-quiet.mjs")

function runHelper(args, options = {}) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  })
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues run-quiet ✓ & -"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = path.join(root, "probe script ✓.mjs")
  writeFileSync(script, [
    'process.stdout.write("STDOUT-SHOULD-BE-HIDDEN\\n")',
    'process.stderr.write("STDERR-SHOULD-BE-VISIBLE\\n")',
    "process.exit(Number(process.argv[2] || 0))",
    "",
  ].join("\n"))
  return { root, script }
}

test("Q1: stdout is suppressed, stderr is preserved, exit code is exact", (t) => {
  const { script } = fixture(t)
  const result = runHelper([process.execPath, script, "7"])
  assert.equal(result.status, 7)
  assert.equal(result.stdout, "", "stdout must be suppressed")
  assert.match(result.stderr, /STDERR-SHOULD-BE-VISIBLE/)
  assert.doesNotMatch(result.stderr, /STDOUT-SHOULD-BE-HIDDEN/)
})

test("Q2: success preserves status 0 and does not invent output", (t) => {
  const { script } = fixture(t)
  const result = runHelper(["node", script, "0"])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /STDERR-SHOULD-BE-VISIBLE/)
})

test("Q3: paths with spaces, Unicode, ampersands and Windows separators work without a shell", (t) => {
  const { root, script } = fixture(t)
  assert.ok(root.includes(" "))
  assert.ok(root.includes("&"))
  const nested = path.join(root, "nested dir ✓")
  mkdirSync(nested, { recursive: true })
  const moved = path.join(nested, "probe & script ✓.mjs")
  writeFileSync(moved, readFileSync(script))
  const result = runHelper(["node", moved, "3"])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /STDERR-SHOULD-BE-VISIBLE/)
})

test("Q4: a missing executable and a missing command fail closed with 127", () => {
  const missing = runHelper(["definitely-not-a-real-command-ues", "--version"])
  assert.equal(missing.status, 127)
  assert.match(missing.stderr, /run-quiet: failed to start/)

  const empty = spawnSync(process.execPath, [HELPER], { encoding: "utf8", windowsHide: true })
  assert.equal(empty.status, 127)
  assert.match(empty.stderr, /missing command/)
})

test("Q5: npm eval scripts no longer contain /dev/null and use the quiet runner", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"))
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    assert.ok(!String(script).includes("/dev/null"), `${name} must not depend on /dev/null`)
    assert.ok(!String(script).includes("> nul"), `${name} must not depend on Windows nul redirection`)
  }
  assert.match(pkg.scripts["eval:v16.5"], /run-quiet\.mjs node scripts\/eval-skill-routing-v16-5\.mjs/)
  assert.match(pkg.scripts["eval:v16.5"], /run-quiet\.mjs node scripts\/eval-v16-5\.mjs/)
  assert.match(pkg.scripts["eval:v16.6"], /run-quiet\.mjs node scripts\/eval-v16-6\.mjs/)
})
