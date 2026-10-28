import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = process.cwd();
const EXT = path.join(ROOT, "pi", "extensions", "ues.ts");

async function loadExtension() {
  const temp = path.join(os.tmpdir(), `ues-parent-tool-${process.pid}-${Date.now()}.mjs`);
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

const ctx = { cwd: process.cwd(), ui: { confirm: async () => true, notify() {}, setTitle() {} } };

// Enter an ACTIVE UES run exactly like Pi does: an interactive `/ues-*` input.
// The repeated-failure guard is scoped to an active run (V16.19.2), so every
// in-scope case must activate the mode through the production input handler.
async function activateUes(host, target = ctx) {
  await host.fire("input", { type: "input", source: "interactive", text: "/ues-fix make the failing test pass" }, target);
}

test("PT-1: Pi parent tool_result preserves error and adds UES failure delta", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = {
    toolName: "bash",
    input: { command: "definitely-not-a-command-ues" },
    content: [{ type: "text", text: "command not found" }],
    details: { exitCode: 127 },
    isError: true,
  };
  const results = await host.fire("tool_result", event, ctx);
  const returned = results.find((value) => value && typeof value === "object");
  assert.ok(returned, "tool_result handler must return a result");
  assert.equal(returned.isError, true);
  const text = (returned.content || []).map((block) => String(block?.text || "")).join("\n");
  assert.match(text, /UES failure delta/);
  assert.match(text, /command not found|not recognized|ENOENT/i);
});

test("PT-2: repeated identical failed command is not hard-blocked when fingerprint is insufficient (ignored files present)", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  await activateUes(host);
  const command = "node -e \"process.exit(1)\"";
  await host.fire("tool_result", {
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: "exitCode: 1" }],
    details: { exitCode: 1 },
    isError: true,
  }, ctx);
  const result = await host.fire("tool_call", {
    toolName: "bash",
    input: { command },
    toolCallId: "call-1",
  }, ctx);
  const decision = result.find((value) => value && typeof value === "object");
  assert.equal(decision?.block, undefined);
});

test("PT-3: SyntaxError result stays FAIL with targeted recovery hint", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = {
    toolName: "bash",
    input: { command: "node --check /tmp/bad.mjs" },
    content: [{ type: "text", text: "SyntaxError: Unexpected token" }],
    details: { exitCode: 1 },
    isError: true,
  };
  const results = await host.fire("tool_result", event, ctx);
  const returned = results.find((value) => value && typeof value === "object");
  assert.equal(returned.isError, true);
  const text = (returned.content || []).map((block) => String(block?.text || "")).join("\n");
  assert.match(text, /SyntaxError/);
  assert.match(text, /targeted file\/test/);
});

test("PT-4: timeout is prioritized over command-not-found text", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = {
    toolName: "bash",
    input: { command: "definitely-not-a-command-ues" },
    content: [{ type: "text", text: "command not found" }],
    details: { exitCode: 127 },
    stopReason: "timeout",
    isError: true,
  };
  const results = await host.fire("tool_result", event, ctx);
  const returned = results.find((value) => value && typeof value === "object");
  assert.equal(returned.details?.uesToolFailure?.class, "TIMEOUT");
});

test("PT-5: identical failure hint is delivered only once", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = {
    toolName: "bash",
    input: { command: "node -e \"process.exit(2)\"" },
    content: [{ type: "text", text: "exitCode: 2" }],
    details: { exitCode: 2 },
    isError: true,
  };
  const first = await host.fire("tool_result", { ...event }, ctx);
  const second = await host.fire("tool_result", { ...event }, ctx);
  const firstText = (first.find((v) => v)?.content || []).map((b) => String(b?.text || "")).join("\n");
  const secondText = (second.find((v) => v)?.content || []).map((b) => String(b?.text || "")).join("\n");
  assert.match(firstText, /UES failure delta/);
  assert.doesNotMatch(secondText, /UES failure delta/);
});

test("PT-7: failed command is allowed again after workspace evidence changes", async () => {
  const { runProcess } = await import("../lib/process-runner.mjs");
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/ues-parent-evidence-");
  try {
    await runProcess("git", ["init"], { cwd: dir });
    await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await runProcess("git", ["config", "user.name", "test"], { cwd: dir });
    await (await import("node:fs/promises")).writeFile(dir + "/a.txt", "one\n", "utf8");
    await runProcess("git", ["add", "a.txt"], { cwd: dir });
    await runProcess("git", ["commit", "-m", "init"], { cwd: dir });

    const install = await loadExtension();
    const host = fakePi();
    install(host.pi);
    const command = "node -e \"process.exit(1)\"";
    const evidenceCtx = { ...ctx, cwd: dir };
    await activateUes(host, evidenceCtx);
    await host.fire("tool_result", {
      toolName: "bash",
      input: { command },
      content: [{ type: "text", text: "exitCode: 1" }],
      details: { exitCode: 1 },
      isError: true,
    }, evidenceCtx);
    const blocked = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-2" }, evidenceCtx);
    assert.equal(blocked.find((v) => v)?.block, true);

    await (await import("node:fs/promises")).writeFile(dir + "/a.txt", "two\n", "utf8");
    const allowed = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-3" }, evidenceCtx);
    assert.equal(allowed.find((v) => v)?.block, undefined);
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

test("PT-8: shell builtins and compound commands are not falsely blocked", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  await activateUes(host);
  for (const command of ["cd src", "echo hello", "pwd", "type node", "cd . && npm test"]) {
    await host.fire("tool_result", {
      toolName: "bash",
      input: { command },
      content: [{ type: "text", text: "Command exited with code 1" }],
      structuredContent: { exit_code: 1, output: "", truncated: false },
      isError: true,
    }, ctx);
    const result = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-builtin" }, ctx);
    const decision = result.find((value) => value && typeof value === "object");
    assert.equal(decision, undefined, command + " must not be blocked");
  }
});

test("PT-6: successful tool result is not annotated", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const event = {
    toolName: "bash",
    input: { command: "node -e \"process.exit(0)\"" },
    content: [{ type: "text", text: "ok" }],
    details: { exitCode: 0 },
    isError: false,
  };
  const results = await host.fire("tool_result", event, ctx);
  const returned = results.find((value) => value && typeof value === "object");
  // handler may return postWrite (undefined) or an object without uesToolFailure
  if (returned) {
    assert.equal(returned.isError, false);
    const text = (returned.content || []).map((block) => String(block?.text || "")).join("\n");
    assert.doesNotMatch(text, /UES failure delta/);
  }
});

// V16.19.2 scope regressions. The repeated-failure guard is a UES-run guard: it
// must never hard-block a user's own bash/powershell command while UES mode is
// INACTIVE, and a fingerprint recorded inside a run must not survive the run
// boundary. Both cases are driven through the production handlers with Pi's
// real event shapes (`type`, `toolCallId`, `input`, `content`, `details`,
// `structuredContent`, `isError`) and Pi's documented merge rule for
// `structuredContent`.
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

async function cleanGitRepo(prefix) {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const { runProcess } = await import("../lib/process-runner.mjs");
  const dir = await fsp.mkdtemp(os.tmpdir() + "/" + prefix);
  await runProcess("git", ["init"], { cwd: dir });
  await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runProcess("git", ["config", "user.name", "test"], { cwd: dir });
  await fsp.writeFile(dir + "/a.txt", "one\n", "utf8");
  await runProcess("git", ["add", "a.txt"], { cwd: dir });
  await runProcess("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, fsp };
}

test("PT-9: UES INACTIVE never hard-blocks a user's repeated failing command", async () => {
  const { dir, fsp } = await cleanGitRepo("ues-parent-inactive-");
  try {
    const install = await loadExtension();
    const host = fakePi();
    install(host.pi);
    const inactiveCtx = { ...ctx, cwd: dir };
    const command = "node -e \"process.exit(1)\"";
    // Evidence is sufficient here (clean repo, no ignored paths), so the guard
    // WOULD block if it were not scoped to an active UES run.
    const annotated = (await host.fire("tool_result", {
      type: "tool_result",
      toolCallId: "call-inactive-1",
      toolName: "bash",
      input: { command },
      content: [{ type: "text", text: "Command exited with code 1" }],
      details: { truncation: {} },
      structuredContent: { output: "", truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
      isError: true,
    }, inactiveCtx)).find((value) => value && typeof value === "object");
    assert.ok(annotated, "the failure is still annotated outside UES mode");
    const decision = (await host.fire("tool_call", {
      type: "tool_call", toolName: "bash", toolCallId: "call-inactive-2", input: { command },
    }, inactiveCtx)).find((value) => value && typeof value === "object");
    assert.equal(decision, undefined, "inactive UES mode must not block a user command");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("PT-10: a fingerprint recorded in a UES run does not leak past the run boundary", async () => {
  const { dir, fsp } = await cleanGitRepo("ues-parent-boundary-");
  try {
    const install = await loadExtension();
    const host = fakePi();
    install(host.pi);
    const runCtx = { ...ctx, cwd: dir };
    const command = "node -e \"process.exit(1)\"";
    const failure = {
      type: "tool_result",
      toolCallId: "call-boundary-1",
      toolName: "bash",
      input: { command },
      content: [{ type: "text", text: "Command exited with code 1" }],
      details: { truncation: {} },
      structuredContent: { output: "", truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
      isError: true,
    };
    await activateUes(host, runCtx);
    await host.fire("tool_result", failure, runCtx);
    const blocked = (await host.fire("tool_call", {
      type: "tool_call", toolName: "bash", toolCallId: "call-boundary-2", input: { command },
    }, runCtx)).find((value) => value && typeof value === "object");
    assert.equal(blocked?.block, true, "the guard must still block inside the UES run");

    await host.fire("agent_end", { type: "agent_end" }, runCtx);
    const afterRun = (await host.fire("tool_call", {
      type: "tool_call", toolName: "bash", toolCallId: "call-boundary-3", input: { command },
    }, runCtx)).find((value) => value && typeof value === "object");
    assert.equal(afterRun, undefined, "a normal chat after the run must not inherit the block");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("PT-11: predicate exit-1 results never create blocking state and keep FAIL intact", async () => {
  const { dir, fsp } = await cleanGitRepo("ues-parent-predicate-");
  try {
    const install = await loadExtension();
    const host = fakePi();
    install(host.pi);
    const runCtx = { ...ctx, cwd: dir };
    await activateUes(host, runCtx);
    for (const command of ["grep -rn ZZZ_NOT_PRESENT lib/", "rg ZZZ_NOT_PRESENT", "git diff --quiet", "git diff --exit-code"]) {
      const event = {
        type: "tool_result",
        toolCallId: "call-predicate-" + command.length,
        toolName: "bash",
        input: { command },
        content: [{ type: "text", text: "Command exited with code 1" }],
        details: { truncation: {} },
        structuredContent: { output: "", truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
        isError: true,
      };
      const returned = (await host.fire("tool_result", event, runCtx)).find((value) => value && typeof value === "object");
      assert.equal(returned, undefined, command + " must not be annotated as a failure");
      const merged = piMerge(event, returned);
      assert.equal(merged.isError, true, command + " must stay FAIL");
      assert.equal(merged.structuredContent?.exit_code, 1, command + " must keep its exit code");
      const blocked = (await host.fire("tool_call", {
        type: "tool_call", toolName: "bash", toolCallId: "call-predicate-again", input: { command },
      }, runCtx)).find((value) => value && typeof value === "object");
      assert.equal(blocked, undefined, command + " must not be hard-blocked as a repeated failure");
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
