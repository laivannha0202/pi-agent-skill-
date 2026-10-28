import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runProcess } from "../lib/process-runner.mjs";
import {
  classifyChildFailure,
  decideRetry,
  FAILURE_CLASS,
} from "../lib/integration-transaction-v16-15.mjs";
import {
  planningFailureFingerprint,
  planningRecoveryDecision,
} from "../lib/planning-recovery.mjs";
import { classifyProviderFailure } from "../lib/provider-recovery.mjs";
import { buildLightTaskContext, lightContextInsufficient } from "../lib/context-engine-v11.mjs";

test("PER-1: command not found is detected and not retried", async () => {
  const result = await runProcess("definitely-not-a-ues-command-12345", [], { timeoutMs: 5000, heartbeatMs: 0 });
  assert.notEqual(result.status, 0);
  const classified = classifyChildFailure({ exitCode: result.status, error: result.stderr || result.stdout, stopReason: result.timedOut ? "timeout" : "" });
  assert.equal(classified.retryable, false);
});

test("PER-2: JavaScript SyntaxError is detected and not blindly retried", async () => {
  const result = await runProcess(process.execPath, ["-e", "const x = ;"], { timeoutMs: 5000, heartbeatMs: 0 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
  const classified = classifyChildFailure({ exitCode: result.status, error: result.stderr });
  assert.equal(classified.retryable, false);
});

test("PER-3: patch anchor failure is a conflict, not a retryable implementation failure", () => {
  const classified = classifyChildFailure({ error: "patch failed: anchor not found for src/x.mjs" });
  assert.equal(classified.class, FAILURE_CLASS.CONFLICT);
  assert.equal(classified.retryable, false);
});

test("PER-4: failing verification command is classified as test/build failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-per-test-"));
  try {
    await writeFile(path.join(dir, "failing.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => { assert.equal(1, 2); });\n", "utf8");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = await runProcess(process.execPath, ["--test", "failing.test.mjs"], { cwd: dir, timeoutMs: 10000, heartbeatMs: 0, env });
    assert.notEqual(result.status, 0);
    const classified = classifyChildFailure({ exitCode: result.status, error: (result.stdout || "") + "\n" + (result.stderr || "") });
    assert.equal(classified.class, FAILURE_CLASS.TEST_FAILURE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PER-5: timeout is detected, retryable, and process stops", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 100, heartbeatMs: 0 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
  const classified = classifyChildFailure({ stopReason: "timeout" });
  assert.equal(classified.class, FAILURE_CLASS.TIMEOUT);
  assert.equal(classified.retryable, true);
});

test("PER-6: abort cancellation is detected and nonzero", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { signal: controller.signal, heartbeatMs: 0 });
  assert.equal(result.aborted, true);
  assert.notEqual(result.status, 0);
});

test("PER-7: repeated failure fingerprint stops instead of retrying", () => {
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

test("PER-8: decideRetry refuses an identical fingerprint", () => {
  const decision = decideRetry({
    classification: classifyChildFailure({ exitCode: 1, error: "tool crashed" }),
    attempts: 0,
    fingerprint: "same-fingerprint",
    seenFingerprints: ["same-fingerprint"],
  });
  assert.equal(decision.retry, false);
  assert.equal(decision.escalate, true);
});

test("PER-9: provider empty response classification distinguishes safe replay", () => {
  const safe = classifyProviderFailure({ output: "", errorMessage: "provider returned an empty response", toolCalls: 0 });
  const unsafe = classifyProviderFailure({ output: "", errorMessage: "provider returned an empty response", toolCalls: 2 });
  assert.equal(safe.safeReplay, true);
  assert.equal(unsafe.safeReplay, false);
  assert.equal(unsafe.safeSessionResume, true);
});

test("PER-11: combined timeout + exit 127 prioritizes timeout", () => {
  const classified = classifyChildFailure({ stopReason: "timeout", exitCode: 127, error: "command not found" });
  assert.equal(classified.class, FAILURE_CLASS.TIMEOUT);
  assert.equal(classified.retryable, true);
});

test("PER-12: test failure containing DeepSeek stays TEST_FAILURE", () => {
  const classified = classifyChildFailure({ error: "AssertionError: expected 3 but got 4; DeepSeek worker crashed" });
  assert.equal(classified.class, FAILURE_CLASS.TEST_FAILURE);
});

test("PER-13: patch conflict + provider error prioritizes conflict", () => {
  const classified = classifyChildFailure({ error: "patch failed: anchor not found; provider returned an empty response" });
  assert.equal(classified.class, FAILURE_CLASS.CONFLICT);
  assert.equal(classified.retryable, false);
});

test("PER-10: LIGHT_CONTEXT production runtime escalates when evidence is insufficient", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-per-light-"));
  try {
    const light = await buildLightTaskContext(dir, { title: "fix hidden bug", acceptance: ["make tests pass"] }, { changedFiles: [] });
    const decision = lightContextInsufficient(light, { crossSubsystem: true });
    assert.equal(decision.insufficient, true);
    assert.ok(decision.reasons.includes("cross-subsystem-scope"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
