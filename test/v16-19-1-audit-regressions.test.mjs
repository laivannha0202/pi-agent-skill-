// V16.19.1 AUDIT REGRESSIONS — defects reproduced by driving the shipped code.
//
// Every case below failed BEFORE the fix and is asserted through the real
// production entry point, not through a source marker:
//
//   * the shipped Pi extension handler (`tool_result` in pi/extensions/ues.ts),
//     loaded with Node's type stripping exactly like the controller loads it,
//   * `compileRequirementLedger` (lib/requirement-contract.mjs),
//   * `classifyEngineeringTask` (lib/task-policy.mjs).
//
// AR-1 Pi DELETES `structuredContent` when a `tool_result` handler returns
//      content without replacing it (runner.js), so annotating a failure used to
//      drop exit_code/output/truncated/full_output_path. Data loss.
// AR-2 Pi's bash tool reports the code as `structuredContent.exit_code` +
//      "Command exited with code N"; `details` has no exit code. The old reader
//      always returned null, so the exit-code branches were unreachable and
//      every failure was reported as "no test signature". Wrong logic.
// AR-3 `grep`/`rg`/`git diff --quiet` exit 1 means "no match / predicate false".
//      Annotating it as IMPLEMENTATION_FAILURE injected a false failure into the
//      model's context. False failure signal.
// AR-4 "không push, không tag, không publish" lost two prohibitions and
//      relabelled the survivor as MUST (the fallback forced kind MUST and kept
//      only the first clause). Dropped constraint.
// AR-5 "thêm tính năng X, không sửa Y" was classified read-only (Vietnamese
//      "thêm" was missing from the mutation vocabulary while English "add" was
//      present), routing a feature request into the read-only lane. Scope error.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { compileRequirementLedger } from "../lib/requirement-contract.mjs";
import { classifyEngineeringTask } from "../lib/task-policy.mjs";

const ROOT = process.cwd();
const EXT = path.join(ROOT, "pi", "extensions", "ues.ts");

async function loadExtension() {
  const temp = path.join(os.tmpdir(), `ues-audit-1619-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  let source = stripTypeScriptTypes(readFileSync(EXT, "utf8"), { mode: "strip", sourceUrl: "pi/extensions/ues.ts" });
  source = source.replace(/from "typebox"/g, `from "${pathToFileURL(path.join(ROOT, "node_modules", "typebox", "build", "index.mjs")).href}"`);
  source = source.replace(/from "\.\.\/\.\.\/lib\/([^"]+)"/g, (_, rel) => `from "${pathToFileURL(path.join(ROOT, "lib", rel)).href}"`);
  source = source.replace(/import\("\.\.\/\.\.\/lib\/([^"]+)"\)/g, (_, rel) => `import("${pathToFileURL(path.join(ROOT, "lib", rel)).href}")`);
  writeFileSync(temp, source, "utf8");
  try {
    const mod = await import(pathToFileURL(temp).href);
    return mod.default;
  } finally {
    rmSync(temp, { force: true });
  }
}

function fakePi() {
  const handlers = new Map();
  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    getAllTools() { return []; },
    setActiveTools() {},
    getActiveTools() { return []; },
  };
  return {
    pi,
    async fire(event, payload = {}, ctx = {}) {
      const out = [];
      for (const fn of handlers.get(event) || []) out.push(await fn(payload, ctx));
      return out;
    },
  };
}

const ctx = { cwd: ROOT, ui: { confirm: async () => true } };

// Pi's real bash failure shape: no `details.exitCode`, code in structuredContent.
function bashFailure(command, exitCode, text) {
  return {
    type: "tool_result",
    toolCallId: "call-" + exitCode + "-" + command.length,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: text ?? "Command exited with code " + exitCode }],
    structuredContent: { output: "out", truncated: false, exit_code: exitCode, wall_time_seconds: 0.1 },
    details: undefined,
    isError: true,
  };
}

function resultOf(values) {
  return values.find((value) => value && typeof value === "object");
}

test("AR-1: annotating a failed bash result preserves structuredContent", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = bashFailure("definitely-not-a-ues-command", 127, "bash: command not found\n\nCommand exited with code 127");
  const returned = resultOf(await host.fire("tool_result", event, ctx));
  assert.ok(returned, "the handler must annotate the failure");
  assert.notEqual(returned.structuredContent, undefined, "structuredContent must not be dropped");
  assert.equal(returned.structuredContent.exit_code, 127);
  // Reproduce Pi's runner merge: `structuredContent === undefined` deletes it.
  const merged = { ...event };
  if (returned.content !== undefined) {
    merged.content = returned.content;
    if (returned.structuredContent === undefined) delete merged.structuredContent;
  }
  if (returned.details !== undefined) merged.details = returned.details;
  assert.notEqual(merged.structuredContent, undefined, "runner merge must keep structuredContent");
});

test("AR-2: the real exit code is read from structuredContent.exit_code", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const returned = resultOf(await host.fire("tool_result", bashFailure("node scripts/whatever.mjs", 2), ctx));
  assert.ok(returned);
  assert.equal(returned.details?.uesToolFailure?.reason, "child exited 2");
});

test("AR-2b: command-not-found exit code 127 is classified non-retryable", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const returned = resultOf(await host.fire("tool_result", bashFailure("definitely-not-a-ues-command", 127), ctx));
  assert.equal(returned.details?.uesToolFailure?.retryable, false);
});

test("AR-3: predicate commands exiting 1 are not reported as failures", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  for (const command of ["grep -rn ZZZ_NOT_PRESENT lib/", "rg ZZZ_NOT_PRESENT", "git diff --quiet", "git diff --exit-code"]) {
    const returned = resultOf(await host.fire("tool_result", bashFailure(command, 1), ctx));
    assert.equal(returned?.details?.uesToolFailure, undefined, command + " must not be annotated as a failure");
  }
});

test("AR-3b: a genuine exit-1 failure is still annotated and retryable", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const returned = resultOf(await host.fire("tool_result", bashFailure('node -e "process.exit(1)"', 1), ctx));
  assert.equal(returned?.details?.uesToolFailure?.class, "IMPLEMENTATION_FAILURE");
  assert.equal(returned?.details?.uesToolFailure?.retryable, true);
});

test("AR-4: every prohibition survives the ledger and stays MUST_NOT", () => {
  const ledger = compileRequirementLedger("không push, không tag, không publish");
  assert.deepEqual(ledger.requirements.map((item) => item.kind), ["MUST_NOT", "MUST_NOT", "MUST_NOT"]);
  assert.deepEqual(ledger.requirements.map((item) => item.text), ["không push", "không tag", "không publish"]);
});

test("AR-4b: a trailing prohibition is not dropped", () => {
  const ledger = compileRequirementLedger("chạy test rồi báo cáo, không commit");
  assert.equal(ledger.counts.MUST_NOT, 1);
  assert.equal(ledger.requirements.find((item) => item.kind === "MUST_NOT")?.text, "không commit");
});

test("AR-4c: an unclassifiable prohibition is never relabelled MUST", () => {
  const ledger = compileRequirementLedger("không deploy lên production\nkhông rotate secret");
  assert.equal(ledger.counts.MUST, 0);
  assert.ok(ledger.counts.MUST_NOT >= 1);
});

test("AR-5: a Vietnamese add-feature task with a negative scope constraint is not read-only", () => {
  const policy = classifyEngineeringTask("thêm tính năng X, không sửa Y");
  assert.equal(policy.readOnly, false);
});

test("AR-5b: English and Vietnamese add-feature phrasing agree", () => {
  const vi = classifyEngineeringTask("thêm tính năng X, không sửa Y");
  const en = classifyEngineeringTask("add feature X, do not change Y");
  assert.equal(vi.readOnly, en.readOnly);
  assert.equal(vi.readOnly, false);
});

test("AR-5c: adverbial 'thêm' does not turn a read-only task into a mutation", () => {
  for (const task of [
    "chỉ kiểm tra thêm, đừng sửa",
    "kiểm tra thêm rồi báo cáo, không sửa code",
    "chạy thêm test, không đổi source",
    "đọc thêm tài liệu, không sửa gì",
  ]) {
    assert.equal(classifyEngineeringTask(task).readOnly, true, task + " must stay read-only");
  }
});

test("AR-5d: contractions are honoured as explicit read-only instructions", () => {
  assert.equal(classifyEngineeringTask("review only, don't change anything").readOnly, true);
  assert.equal(classifyEngineeringTask("review only, do not change anything").readOnly, true);
});

// AR-3c/3d/3e (V16.19.2): the predicate-exit-1 exemption may only suppress the
// HINT. It must never turn a FAIL into a PASS, hide the exit code, drop
// structuredContent, or swallow stderr — and a genuine error of the same
// command must still be annotated. Driven through the production handler and
// Pi's documented merge rule (content replaced => structuredContent deleted
// unless the handler replaces it).
function bashWithStderr(command, exitCode, stderr, stdout = "") {
  return {
    type: "tool_result",
    toolCallId: "call-" + exitCode + "-" + command.length,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: [stdout, stderr, "Command exited with code " + exitCode].filter(Boolean).join("\n") }],
    details: { truncation: {} },
    structuredContent: { output: stdout + stderr, truncated: false, exit_code: exitCode, wall_time_seconds: 0.05 },
    isError: true,
  };
}

function piMerge(event, returned) {
  const merged = { ...event };
  if (returned && returned.content !== undefined) {
    merged.content = returned.content;
    if (returned.structuredContent === undefined) delete merged.structuredContent;
    else merged.structuredContent = returned.structuredContent;
  }
  if (returned && returned.details !== undefined) merged.details = returned.details;
  if (returned && returned.isError !== undefined) merged.isError = returned.isError;
  return merged;
}

test("AR-3c: predicate exit-1 keeps FAIL, exit code, structuredContent and stderr", async () => {
  const install = await loadExtension();
  const cases = [
    ["grep -n ZZZ src/none.txt", "grep: warning: stray \ before Z\n"],
    ["rg ZZZ src/none.txt", ""],
    ["git diff --quiet", ""],
    ["git diff --exit-code", ""],
  ];
  for (const [command, stderr] of cases) {
    const host = fakePi();
    install(host.pi);
    const event = bashWithStderr(command, 1, stderr);
    const returned = resultOf(await host.fire("tool_result", event, ctx));
    assert.equal(returned, undefined, command + " must not be annotated as a failure");
    const merged = piMerge(event, returned);
    assert.equal(merged.isError, true, command + " must stay FAIL");
    assert.equal(merged.structuredContent?.exit_code, 1, command + " must keep exit_code");
    assert.notEqual(merged.structuredContent, undefined, command + " must keep structuredContent");
    const text = (merged.content || []).map((block) => String(block?.text || "")).join("\n");
    assert.doesNotMatch(text, /UES failure delta/, command + " must not receive a false failure hint");
    if (stderr) assert.match(text, /stray/, command + " must keep stderr");
  }
});

test("AR-3d: a genuine error of grep/rg (exit 2) is still annotated and stays FAIL", async () => {
  const install = await loadExtension();
  const cases = [
    ["grep -n ZZZ /no/such/dir", "grep: /no/such/dir: No such file or directory"],
    ["rg --definitely-bad-flag", "error: unexpected argument '--definitely-bad-flag' found"],
  ];
  for (const [command, stderr] of cases) {
    const host = fakePi();
    install(host.pi);
    const event = bashWithStderr(command, 2, stderr);
    const returned = resultOf(await host.fire("tool_result", event, ctx));
    assert.ok(returned, command + " must be annotated");
    assert.equal(returned.details?.uesToolFailure?.class, "IMPLEMENTATION_FAILURE");
    assert.ok(returned.details?.uesToolFailure?.reason, command + " must carry a reason");
    const merged = piMerge(event, returned);
    assert.equal(merged.isError, true, command + " must stay FAIL");
    assert.equal(merged.structuredContent?.exit_code, 2, command + " must keep exit_code");
    const text = (merged.content || []).map((block) => String(block?.text || "")).join("\n");
    assert.match(text, /UES failure delta/);
    assert.match(text, /No such file|unexpected argument/, command + " must keep stderr");
  }
});

test("AR-3e: predicate exit-1 never feeds the repeated-failure guard", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const runCtx = { ...ctx, cwd: process.cwd() };
  await host.fire("input", { type: "input", source: "interactive", text: "/ues-review the repo" }, runCtx);
  const command = "grep -rn ZZZ_NOT_PRESENT lib/";
  for (let i = 0; i < 2; i += 1) {
    await host.fire("tool_result", bashWithStderr(command, 1, ""), runCtx);
    const decision = (await host.fire("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "call-3e-" + i, input: { command } }, runCtx))
      .find((value) => value && typeof value === "object");
    assert.equal(decision, undefined, "a predicate result must never become a repeated-failure block");
  }
});
