import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  extractCriticalIntegrityFailures,
  listGitHubActionsWorkflowFiles,
  noGitHubActionsWorkflowFailures,
  onlyIntentionallyDisabledWorkflowFailures,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.7.1 no-actions integrity: current repository has no GitHub Actions workflow files", () => {
  for (const file of ["ci.yml", "publish.yml", "security.yml", "anything.yml", "totally-new.yaml"]) {
    assert.equal(existsSync(path.join(ROOT, ".github", "workflows", file)), false, file)
  }
  assert.deepEqual(listGitHubActionsWorkflowFiles(ROOT), [])
  assert.deepEqual(noGitHubActionsWorkflowFailures(ROOT), [])
})

test("V16.7.1 no-actions integrity: an arbitrarily named workflow file is detected (fail-closed)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-"))
  try {
    const dir = path.join(tmp, ".github", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "totally-new.yml"), "name: Should Not Exist\n")
    const files = listGitHubActionsWorkflowFiles(tmp)
    assert.deepEqual(files, [".github/workflows/totally-new.yml"])
    const failures = noGitHubActionsWorkflowFailures(tmp)
    assert.equal(failures.length, 1)
    assert.match(failures[0], /totally-new\.yml/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("V16.7.1 no-actions integrity: nested and multiple arbitrary workflows are all detected", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-"))
  try {
    const dir = path.join(tmp, ".github", "workflows")
    mkdirSync(path.join(dir, "nested"), { recursive: true })
    writeFileSync(path.join(dir, "foo.yaml"), "name: Foo\n")
    writeFileSync(path.join(dir, "nested", "bar.yml"), "name: Bar\n")
    const failures = noGitHubActionsWorkflowFailures(tmp)
    assert.equal(failures.length, 2)
    assert.ok(failures.some((f) => f.includes("foo.yaml")))
    assert.ok(failures.some((f) => f.includes("nested/bar.yml")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("V16.7.1 no-actions integrity: exactly the two retired workflow contracts are tolerated", () => {
  const sample = [
    "AssertionError [ERR_ASSERTION]: Critical UES source-integrity validation failed:",
    "- .github/workflows/security.yml: unreadable (ENOENT: no such file or directory)",
    "- .github/workflows/publish.yml: unreadable (ENOENT: no such file or directory)",
    "+ actual - expected",
  ].join("\n")
  const failures = extractCriticalIntegrityFailures(sample)
  assert.equal(failures.length, 2)
  assert.equal(onlyIntentionallyDisabledWorkflowFailures(failures), true)
})

test("V16.7.1 no-actions integrity: any additional integrity failure still fails closed", () => {
  const failures = [
    ".github/workflows/security.yml: unreadable (ENOENT: disabled)",
    ".github/workflows/publish.yml: unreadable (ENOENT: disabled)",
    "pi/extensions/ues.ts: too small",
  ]
  assert.equal(onlyIntentionallyDisabledWorkflowFailures(failures), false)
})

test("V16.7.1 no-actions integrity: one missing retired contract alone is not silently ignored", () => {
  assert.equal(
    onlyIntentionallyDisabledWorkflowFailures([
      ".github/workflows/security.yml: unreadable (ENOENT: disabled)",
    ]),
    false,
  )
})

test("V16.7.1 no-actions integrity: a detected workflow failure is never treated as tolerated", () => {
  const failures = [".github/workflows/totally-new.yml: GitHub Actions workflow present (intentionally disabled)"]
  assert.equal(onlyIntentionallyDisabledWorkflowFailures(failures), false)
})

test("V16.7.1 no-actions integrity: a workflow path that is a file fails closed", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-"))
  try {
    mkdirSync(path.join(tmp, ".github"), { recursive: true })
    writeFileSync(path.join(tmp, ".github", "workflows"), "not a directory")
    assert.throws(() => listGitHubActionsWorkflowFiles(tmp), /expected a directory/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("V16.7.1 no-actions integrity: a symlinked workflow directory fails closed", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-"))
  const target = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-target-"))
  try {
    mkdirSync(path.join(tmp, ".github"), { recursive: true })
    try {
      symlinkSync(target, path.join(tmp, ".github", "workflows"))
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("symlink creation unavailable")
      throw error
    }
    assert.throws(() => listGitHubActionsWorkflowFiles(tmp), /symlinked workflow directory/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test("V16.7.1 no-actions integrity: a symlinked workflow entry fails closed", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ues-no-actions-"))
  try {
    const dir = path.join(tmp, ".github", "workflows")
    mkdirSync(dir, { recursive: true })
    const targetFile = path.join(tmp, "target.yml")
    writeFileSync(targetFile, "name: Target\n")
    try {
      symlinkSync(targetFile, path.join(dir, "linked.yml"))
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("symlink creation unavailable")
      throw error
    }
    assert.throws(() => listGitHubActionsWorkflowFiles(tmp), /symlink is not safe/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
