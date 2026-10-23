import assert from "node:assert/strict"
import test from "node:test"
import { auditCompletion } from "../lib/completion-auditor.mjs"
import { createVerificationReceipt } from "../lib/evidence-receipt.mjs"

const fingerprint = "test-current-workspace-fingerprint"
const verification = {
  exitCode: 0,
  verdict: "PASS",
  report: {
    valid: true,
    verdict: "PASS",
    sections: {
      "checks-run": "node --test test/checkout.test.mjs",
      "acceptance-criteria-proven": "VERIFIED: node --test test/checkout.test.mjs returned exit code 0",
      "completion-evidence": "Test output and receipt captured",
      "checks-not-run": "none",
    },
  },
}
const snapshot = { cacheable: true, fingerprint, changedFiles: ["src/checkout.mjs"] }
function receipt(command = "node", args = ["--test", "test/checkout.test.mjs"], overrides = {}) {
  return { receipt: {
    ...createVerificationReceipt({ command, args, exitCode: 0, workspaceBefore: fingerprint, workspaceAfter: fingerprint }),
    ...overrides,
  } }
}
function audit(rows, overrides = {}) {
  return auditCompletion({
    verification, workspaceSnapshot: snapshot, requireBehavioralReceipt: true,
    requireClaimEvidenceStatus: true, behavioralReceipts: rows, ...overrides,
  })
}
test("A1: valid test receipt at current fingerprint grants behavioral evidence", () => {
  const result = audit([receipt()])
  assert.equal(result.passed, true)
  assert.equal(result.evidence.passingReceiptCount, 1)
})
test("A2: successful build without tests is not behavioral proof", () => {
  const result = audit([receipt("npm", ["run", "build"])])
  assert.equal(result.passed, false)
  assert.ok(result.failures.includes("fresh-behavioral-receipt-missing"))
})
test("A3: model-forged incomplete receipt cannot count as passing test", () => {
  const result = audit([{ receipt: { passed: true, exitCode: 0, command: "npm test" } }])
  assert.equal(result.passed, false)
})
test("A4: receipt from old workspace fingerprint cannot verify new edits", () => {
  const result = audit([receipt("npm", ["test"], { workspaceAfter: "old-workspace" })])
  assert.equal(result.passed, false)
})
test("A5: non-cacheable or missing workspace snapshot fails closed", () => {
  assert.equal(audit([receipt()], { workspaceSnapshot: { cacheable: false, fingerprint } }).passed, false)
  assert.equal(audit([receipt()], { workspaceSnapshot: null }).passed, false)
})
test("A6: contradictory verdict or failed receipt is rejected", () => {
  assert.equal(audit([receipt("npm", ["test"], { exitCode: 2 })]).passed, false)
  assert.equal(audit([receipt("npm", ["test"], { passed: false })]).passed, false)
})
test("A7: read-only audit can omit behavioral receipts when not required", () => {
  const result = auditCompletion({
    verification, workspaceSnapshot: snapshot, behavioralReceipts: [],
    requireBehavioralReceipt: false, requireClaimEvidenceStatus: true,
  })
  assert.equal(result.passed, true)
})
test("A8: a mixture only counts the valid behavioral receipt", () => {
  const result = audit([receipt("npm", ["run", "build"]), receipt("npm", ["run", "test:unit"])])
  assert.equal(result.passed, true)
  assert.equal(result.evidence.passingReceiptCount, 1)
})
