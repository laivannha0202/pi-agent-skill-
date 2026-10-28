import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { attemptList } from "../lib/document-ingestion.mjs";
import { planningFailureFingerprint, planningRecoveryDecision } from "../lib/planning-recovery.mjs";
import { classifyProviderFailure } from "../lib/provider-recovery.mjs";

test("AER-1: on Windows, attemptList does not include python3", () => {
  if (process.platform !== "win32") return; // platform-specific
  const list = attemptList();
  const flat = list.map((row) => row[0]);
  assert.ok(!flat.includes("python3"), "python3 must not be tried on Windows");
  // ensure a usable fallback exists
  assert.ok(flat.includes("python") || flat.includes("py"), "a python fallback must exist");
});

test("AER-2: planning fingerprint repeats -> STOP (no useless retry)", () => {
  const fp = planningFailureFingerprint({ code: "PLAN_PARSE_ERROR", message: "bad json" }, null);
  const decision = planningRecoveryDecision({
    attempts: 1,
    maxAttempts: 2,
    fingerprint: fp,
    previousFingerprints: [fp],
    failure: { retryable: true },
    task: "fix x",
    policy: { risk: "low" },
  });
  assert.equal(decision.action, "STOP");
  assert.equal(decision.repeat, true);
});

test("AER-3: provider empty response with 0 tool calls is safe replay", () => {
  const r = classifyProviderFailure({ output: "", errorMessage: "provider returned an empty response", toolCalls: 0 });
  assert.equal(r.transient, true);
  assert.equal(r.safeReplay, true);
});

test("AER-4: provider empty response after tool calls blocks blind replay", () => {
  const r = classifyProviderFailure({ output: "", errorMessage: "provider returned an empty response", toolCalls: 3 });
  assert.equal(r.transient, true);
  assert.equal(r.safeReplay, false);
  assert.equal(r.safeSessionResume, true);
});

test("AER-5: non-transient failure is not retried", () => {
  const r = classifyProviderFailure({ output: "some output", errorMessage: "syntax error", toolCalls: 0 });
  assert.equal(r.transient, false);
  assert.equal(r.safeReplay, false);
});

test("AER-6: planning fingerprint is stable for same failure", () => {
  const a = planningFailureFingerprint({ code: "PLAN_PARSE_ERROR", message: "bad json" }, null);
  const b = planningFailureFingerprint({ code: "PLAN_PARSE_ERROR", message: "bad json" }, null);
  assert.equal(a, b);
});
