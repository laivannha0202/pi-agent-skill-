// V16.19 BEHAVIORAL: the LIGHT_CONTEXT admission the shipped extension runs.
//
// This file does NOT look for markers in the source and does NOT re-implement
// the admission conditions. It imports the shipped `pi/extensions/ues.ts`
// module (type-stripped by Node, exactly like the controller loads it) and
// drives the SAME production decisions `runRoutedAgent` calls:
//
//   * `resolveContextAdmission()` -- FAST/BALANCED admission + bounded scope,
//   * `resolveContextStage()`      -- builds the real LIGHT pack and lets the
//                                     real `lightContextInsufficient` gate
//                                     decide LIGHT vs FULL.
//
// The invariants under test (V16.19 brief):
//   B1 BALANCED + low risk + genuinely bounded  -> LIGHT_CONTEXT
//   B2 BALANCED + unknown scope                 -> FULL_CONTEXT
//   B3 BALANCED + cross-subsystem / high risk   -> FULL_CONTEXT
//   B4 LIGHT with insufficient evidence         -> FULL_CONTEXT escalation
//   B5 FAST keeps the safe V16.18 lane
//   B6 zero files is UNKNOWN scope, never bounded evidence

import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi/extensions/ues.ts")

// The production module. `resolveContextAdmission` / `resolveContextStage` are
// the exported decision points `runRoutedAgent` itself calls; nothing here is a
// copy of the admission logic.
const extension = await import(pathToFileURL(EXTENSION).href)
const { resolveContextAdmission, resolveContextStage, contextScopeEvidence } = extension

assert.equal(typeof resolveContextAdmission, "function", "the shipped extension must export the admission decision")
assert.equal(typeof resolveContextStage, "function", "the shipped extension must export the stage decision")

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v1619-admission-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "T"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "AGENTS.md"), "# agents\n")
  writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n')
  writeFileSync(
    path.join(root, "src/login-form.tsx"),
    "export function LoginForm() {\n  const [submitting, setSubmitting] = useState(true)\n  return null\n}\n",
  )
  writeFileSync(
    path.join(root, "src/auth-client.ts"),
    "export async function postLogin() { return fetch('/api/login') }\n",
  )
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

// The production task shape `runRoutedAgent` passes to `buildLightTaskContext`.
function taskRecord(text) {
  return { id: "pi-dispatch", title: String(text).slice(0, 240), summary: String(text), acceptance: [], verification: [] }
}

const BOUNDED_TASK = "Fix the login form submit state in src/login-form.tsx"
const UNKNOWN_SCOPE_TASK = "Fix the login form submit state when the API fails"

function balanced(overrides = {}) {
  return {
    executionProfile: "BALANCED",
    attempt: 1,
    risk: "low",
    mode: "standard",
    domains: ["react"],
    browserRequested: false,
    task: BOUNDED_TASK,
    declaredFiles: ["src/login-form.tsx"],
    changedFiles: [],
    ...overrides,
  }
}

function fast(overrides = {}) {
  return balanced({ executionProfile: "FAST", ...overrides })
}

// ===========================================================================
// B6. Zero / unknown scope is not bounded evidence
// ===========================================================================

test("B6: zero known files is UNKNOWN scope, never bounded evidence", () => {
  const empty = contextScopeEvidence({ declaredFiles: [], changedFiles: [], task: "make it better" })
  assert.equal(empty.bounded, false)
  assert.ok(empty.reasons.includes("scope-unknown"), JSON.stringify(empty))
  assert.equal(empty.knownFileCount, 0)
})

test("B6: an explicitly bounded file set is bounded evidence", () => {
  const two = contextScopeEvidence({ declaredFiles: ["src/a.ts", "src/b.ts"], changedFiles: [] })
  assert.equal(two.bounded, true)
  assert.deepEqual(two.reasons, [])
  const four = contextScopeEvidence({ declaredFiles: ["a.ts", "b.ts", "c.ts", "d.ts"], changedFiles: [] })
  assert.equal(four.bounded, false)
  assert.ok(four.reasons.includes("scope-too-broad:4files"), JSON.stringify(four))
})

test("B6: changed files alone are bounded evidence", () => {
  const changed = contextScopeEvidence({ declaredFiles: [], changedFiles: [{ path: "src/login-form.tsx" }] })
  assert.equal(changed.bounded, true)
  assert.equal(changed.changedFileCount, 1)
})

// ===========================================================================
// B1. BALANCED + low risk + genuinely bounded -> LIGHT_CONTEXT
// ===========================================================================

test("B1: BALANCED low-risk bounded task is admitted and reaches LIGHT_CONTEXT", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const admission = resolveContextAdmission(balanced())
  assert.equal(admission.lightStageEligible, true, JSON.stringify(admission.reasons))
  assert.equal(admission.lightStageBalancedBounded, true)

  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), {
    admission,
    role: "executor",
    changedFiles: [],
    facts: { longContext: false, browser: false, vision: false },
  })
  assert.equal(decision.stage, "LIGHT_CONTEXT", JSON.stringify(decision.reasons))
  assert.equal(decision.escalated, false)
  assert.ok(decision.pack, "an admitted LIGHT run must carry its real pack")
  assert.equal(decision.pack.stage, "LIGHT_CONTEXT")
  assert.ok(decision.pack.contextManifest.excerpts.length > 0, "LIGHT must hold real excerpts")
  // LIGHT never pays for the heavy owners (V16.18 contract).
  assert.equal(decision.pack.performance.semanticIndexBuilt, false)
  assert.equal(decision.pack.performance.repoGraphBuilt, false)
})

test("B1: a file named only in the task text counts as bounded scope", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(balanced({ declaredFiles: [] }))
  assert.equal(admission.scope.knownFileCount, 1, "the task text names exactly one file")
  assert.equal(admission.lightStageEligible, true, JSON.stringify(admission.reasons))
  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), { admission, role: "executor" })
  assert.equal(decision.stage, "LIGHT_CONTEXT", JSON.stringify(decision.reasons))
})

// ===========================================================================
// B2. BALANCED + unknown scope -> FULL_CONTEXT
// ===========================================================================

test("B2: BALANCED low-risk task with UNKNOWN scope is not admitted to LIGHT", () => {
  const admission = resolveContextAdmission(balanced({
    task: UNKNOWN_SCOPE_TASK,
    declaredFiles: [],
    changedFiles: [],
  }))
  assert.equal(admission.scope.knownFileCount, 0)
  assert.equal(admission.scope.bounded, false)
  assert.equal(admission.lightStageEligible, false)
  assert.ok(admission.reasons.includes("scope-unknown"), JSON.stringify(admission.reasons))
})

test("B2: BALANCED unknown scope resolves to FULL_CONTEXT even when name search would find a file", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(balanced({
    task: UNKNOWN_SCOPE_TASK,
    declaredFiles: [],
    changedFiles: [],
  }))
  const decision = await resolveContextStage(root, taskRecord(UNKNOWN_SCOPE_TASK), {
    admission,
    role: "executor",
  })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.equal(decision.escalated, true)
  assert.equal(decision.pack, null, "a rejected LIGHT pack must never be handed to the run")
  assert.ok(decision.reasons.includes("scope-unknown"), JSON.stringify(decision.reasons))
})

// ===========================================================================
// B3. BALANCED + cross-subsystem / high risk -> FULL_CONTEXT
// ===========================================================================

test("B3: BALANCED low-risk but CROSS-SUBSYSTEM is not admitted to LIGHT", () => {
  const admission = resolveContextAdmission(balanced({ domains: ["react", "devops"] }))
  assert.equal(admission.lightStageEligible, false)
  assert.ok(admission.reasons.some((row) => String(row).startsWith("cross-subsystem")), JSON.stringify(admission.reasons))
})

test("B3: BALANCED cross-subsystem resolves to FULL_CONTEXT with the real gate", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(balanced({ domains: ["react", "database"] }))
  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), { admission, role: "executor" })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.equal(decision.pack, null)
})

test("B3: high risk stays FULL_CONTEXT even with one file", () => {
  for (const risk of ["high", "critical"]) {
    const admission = resolveContextAdmission(balanced({ risk }))
    assert.equal(admission.lightStageEligible, false, risk)
    assert.ok(admission.reasons.includes(`risk=${risk}`), JSON.stringify(admission.reasons))
  }
})

test("B3: a high-risk domain stays FULL_CONTEXT even with one file", () => {
  for (const domain of ["auth-security", "payment", "database", "api-contract"]) {
    const admission = resolveContextAdmission(balanced({ domains: [domain] }))
    assert.equal(admission.lightStageEligible, false, domain)
    assert.ok(admission.reasons.includes(`high-risk-domain:${domain}`), JSON.stringify(admission.reasons))
  }
})

test("B3: a retry attempt and a long-horizon task stay FULL_CONTEXT", () => {
  assert.equal(resolveContextAdmission(balanced({ attempt: 2 })).lightStageEligible, false)
  assert.equal(resolveContextAdmission(balanced({ mode: "long-horizon" })).lightStageEligible, false)
})

// ===========================================================================
// B4. LIGHT with insufficient evidence escalates to FULL_CONTEXT
// ===========================================================================

test("B4: an admitted LIGHT run with no bounded excerpt escalates to FULL_CONTEXT", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Bounded at admission (one declared file), but the repository holds no file
  // the bounded name search can excerpt, so the REAL gate must reject the pack.
  const task = "Fix src/nonexistent-widget.ts"
  const admission = resolveContextAdmission(balanced({ task, declaredFiles: ["src/nonexistent-widget.ts"] }))
  assert.equal(admission.lightStageEligible, true, "admission is bounded; the GATE must reject it")
  const decision = await resolveContextStage(root, taskRecord(task), { admission, role: "executor" })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.equal(decision.pack, null)
  assert.ok(decision.reasons.includes("no-bounded-excerpt"), JSON.stringify(decision.reasons))
})

test("B4: a LIGHT pack that misses a declared file escalates on measured recall", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Structured-plan task shape: `files` is the declared scope the LIGHT pack
  // measures its own recall against.
  const planTask = {
    id: "t1",
    title: "Fix the login form submit state",
    summary: "LoginForm owns the submitting state",
    acceptance: [],
    verification: [],
    files: { modify: ["src/login-form.tsx", "src/missing-module.ts"] },
  }
  const admission = resolveContextAdmission(balanced({ declaredFiles: ["src/login-form.tsx", "src/missing-module.ts"] }))
  assert.equal(admission.scope.bounded, true)
  const decision = await resolveContextStage(root, planTask, { admission, role: "executor" })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.ok(decision.reasons.includes("context-quality-below-threshold"), JSON.stringify(decision.reasons))
})

test("B4: a verifier role escalates because it needs verification detail", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(balanced())
  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), { admission, role: "ues-verifier" })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.ok(decision.reasons.includes("verification-detail-required"), JSON.stringify(decision.reasons))
})

// ===========================================================================
// B5. FAST keeps the safe V16.18 lane
// ===========================================================================

test("B5: FAST low-risk bounded task still reaches LIGHT_CONTEXT", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(fast())
  assert.equal(admission.fastLane, true)
  assert.equal(admission.lightStageEligible, true)
  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), { admission, role: "executor" })
  assert.equal(decision.stage, "LIGHT_CONTEXT", JSON.stringify(decision.reasons))
  assert.ok(decision.pack)
})

test("B5: FAST with UNKNOWN scope still starts LIGHT (V16.18 provisional discovery)", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(fast({
    task: UNKNOWN_SCOPE_TASK,
    declaredFiles: [],
    changedFiles: [],
  }))
  assert.equal(admission.fastLane, true, JSON.stringify(admission.reasons))
  assert.equal(admission.lightStageEligible, true, "FAST must not lose its bounded discovery lane")
  const decision = await resolveContextStage(root, taskRecord(UNKNOWN_SCOPE_TASK), { admission, role: "executor" })
  assert.equal(decision.stage, "LIGHT_CONTEXT", JSON.stringify(decision.reasons))
})

test("B5: FAST keeps every V16.18 safety exclusion", () => {
  for (const risk of ["high", "critical"]) {
    const admission = resolveContextAdmission(fast({ risk }))
    assert.equal(admission.lightStageEligible, false, risk)
    assert.ok(admission.reasons.includes(`risk=${risk}`), JSON.stringify(admission.reasons))
  }
  assert.equal(resolveContextAdmission(fast({ attempt: 2 })).lightStageEligible, false)
  assert.ok(resolveContextAdmission(fast({ attempt: 2 })).reasons.includes("retry-attempt"))
  assert.equal(resolveContextAdmission(fast({ mode: "long-horizon" })).lightStageEligible, false)
  assert.equal(resolveContextAdmission(fast({ browserRequested: true })).lightStageEligible, false)
  assert.ok(resolveContextAdmission(fast({ browserRequested: true })).reasons.includes("browser-requested"))
})

test("B5: FAST cross-subsystem escalates to FULL_CONTEXT (restored gate intent)", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const admission = resolveContextAdmission(fast({ domains: ["react", "devops"] }))
  assert.equal(admission.fastLane, true, "the FAST profile itself is not revoked")
  const decision = await resolveContextStage(root, taskRecord(BOUNDED_TASK), { admission, role: "executor" })
  assert.equal(decision.stage, "FULL_CONTEXT", JSON.stringify(decision.reasons))
  assert.ok(decision.reasons.includes("cross-subsystem-scope"), JSON.stringify(decision.reasons))
})

// ===========================================================================
// Wiring: the runtime really uses the exported decision
// ===========================================================================

test("W1: runRoutedAgent drives the exported admission instead of an inline copy", () => {
  const source = readFileSync(EXTENSION, "utf8")
  assert.ok(source.includes("resolveContextAdmission({"), "the run path must call the exported admission")
  assert.ok(source.includes("resolveContextStage(cwd, taskRecord(task)"), "the run path must call the exported stage decision")
  assert.equal(source.includes("balancedBoundedScope"), false, "the inline bounded-scope predicate must be gone")
  assert.equal(
    /crossSubsystem:\s*Number\(v16_6\?\.taskSignals\?\.domains/.test(source),
    false,
    "the dead taskSignals.domains cross-subsystem input must be gone",
  )
})
