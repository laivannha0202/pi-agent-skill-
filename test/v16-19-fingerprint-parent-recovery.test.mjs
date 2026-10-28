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
  const temp = path.join(os.tmpdir(), `ues-fpr-${process.pid}-${Date.now()}.mjs`);
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
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); return () => {}; },
    registerTool() {}, registerCommand() {}, registerShortcut() {},
    getAllTools() { return []; }, setActiveTools() {}, getActiveTools() { return []; },
  };
  return { pi, async fire(event, payload = {}, ctx = {}) { const out = []; for (const fn of handlers.get(event) || []) out.push(await fn(payload, ctx)); return out; } };
}

const ctx = { cwd: process.cwd(), ui: { confirm: async () => true, notify() {}, setTitle() {} } };

// Enter an ACTIVE UES run exactly like Pi does: an interactive `/ues-*` input.
async function activateUes(host, target = ctx) {
  await host.fire("input", { type: "input", source: "interactive", text: "/ues-fix make the failing test pass" }, target);
}

// Pi's real bash failure shape: the exit code lives in structuredContent.
function bashFailure(command, exitCode, text) {
  return {
    type: "tool_result",
    toolCallId: "call-" + exitCode + "-" + command.length,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: text ?? "Command exited with code " + exitCode }],
    details: { truncation: {} },
    structuredContent: { output: "", truncated: false, exit_code: exitCode, wall_time_seconds: 0.1 },
    isError: true,
  };
}

test("FPR-1: ignored file change allows retry of a previously failed command", async () => {
  const { runProcess } = await import("../lib/process-runner.mjs");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(os.tmpdir() + "/ues-fpr-ignored-");
  try {
    await runProcess("git", ["init"], { cwd: dir });
    await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await runProcess("git", ["config", "user.name", "test"], { cwd: dir });
    await fsp.writeFile(dir + "/a.txt", "one\n", "utf8");
    await runProcess("git", ["add", "a.txt"], { cwd: dir });
    await runProcess("git", ["commit", "-m", "init"], { cwd: dir });
    await fsp.writeFile(dir + "/.gitignore", "ignored.txt\n", "utf8");
    await runProcess("git", ["add", ".gitignore"], { cwd: dir });
    await runProcess("git", ["commit", "-m", "ignore"], { cwd: dir });

    const install = await loadExtension();
    const host = fakePi();
    install(host.pi);
    const command = 'node -e "process.exit(1)"';
    const evidenceCtx = { ...ctx, cwd: dir };
    await activateUes(host, evidenceCtx);
    await host.fire("tool_result", bashFailure(command, 1), evidenceCtx);
    const blocked = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-i1" }, evidenceCtx);
    assert.equal(blocked.find((v) => v)?.block, true);

    await fsp.writeFile(dir + "/ignored.txt", "changed\n", "utf8");
    const allowed = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-i2" }, evidenceCtx);
    assert.equal(allowed.find((v) => v)?.block, undefined);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("FPR-2: shell builtins and compound commands are never blocked even after failure", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  await activateUes(host);
  for (const command of ["cd src", "echo hello", "pwd", "type node", "cd . && npm test"]) {
    await host.fire("tool_result", bashFailure(command, 1), ctx);
    const result = await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: "call-builtin" }, ctx);
    const decision = result.find((value) => value && typeof value === "object");
    assert.equal(decision, undefined, command + " must not be blocked");
  }
});

test("FPR-3: powershell tool repeated failure follows the same gate", async () => {
  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  await activateUes(host);
  const command = 'node -e "process.exit(1)"';
  await host.fire("tool_result", { ...bashFailure(command, 1), toolName: "powershell" }, ctx);
  const result = await host.fire("tool_call", { toolName: "powershell", input: { command }, toolCallId: "call-ps" }, ctx);
  // In this repo fingerprint is insufficient (ignored files present), so not hard-blocked.
  assert.equal(result.find((v) => v)?.block, undefined);
});

test("FPR-4: D6 fail-open holds when the ignored-path list is unchanged", async (t) => {
  const { runProcess } = await import("../lib/process-runner.mjs");
  const fsp = await import("node:fs/promises");
  const dir = await fsp.mkdtemp(os.tmpdir() + "/ues-fpr-d6-");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await runProcess("git", ["init"], { cwd: dir });
  await runProcess("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runProcess("git", ["config", "user.name", "test"], { cwd: dir });
  await fsp.writeFile(dir + "/a.txt", "one\n", "utf8");
  await fsp.writeFile(dir + "/.gitignore", "ignored.txt\n", "utf8");
  await runProcess("git", ["add", "a.txt", ".gitignore"], { cwd: dir });
  await runProcess("git", ["commit", "-m", "init"], { cwd: dir });
  // An ignored, untracked file exists and never changes for the rest of the test.
  await fsp.writeFile(dir + "/ignored.txt", "stable\n", "utf8");

  const install = await loadExtension();
  const host = fakePi();
  install(host.pi);
  const evidenceCtx = { ...ctx, cwd: dir };
  await activateUes(host, evidenceCtx);
  const command = 'node -e "process.exit(1)"';
  await host.fire("tool_result", bashFailure(command, 1), evidenceCtx);
  // Unchanged ignored paths mean insufficient evidence: never hard-block.
  for (const id of ["call-d6-1", "call-d6-2"]) {
    const decision = (await host.fire("tool_call", { toolName: "bash", input: { command }, toolCallId: id }, evidenceCtx))
      .find((value) => value && typeof value === "object");
    assert.equal(decision, undefined, "unchanged ignored paths must stay fail-open");
  }
});
