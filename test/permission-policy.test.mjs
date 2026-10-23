import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  compilePolicyLattice,
  evaluatePermissionRules,
  evaluatePolicyLattice,
  permissionPatternMatches,
  PermissionPolicyStore,
  permissionRecoveryHint,
  toolPermissionRequest,
} from "../lib/permission-policy.mjs"

test("last matching rule wins", () => {
  const result = evaluatePermissionRules([
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "git status *", effect: "allow" },
    { action: "shell", resource: "git push *", effect: "deny" },
  ], { action: "shell", resource: "git push origin main" })
  assert.equal(result.effect, "deny")
  assert.equal(result.decisions[0].matchedRule.index, 2)
})

test("shell pattern ending in space-star also matches no-argument command", () => {
  assert.equal(permissionPatternMatches("git status *", "git status", { shell: true }), true)
  assert.equal(permissionPatternMatches("git status *", "git status --short", { shell: true }), true)
})

test("windows matching normalizes slashes and is case-insensitive", () => {
  const result = evaluatePermissionRules([
    { action: "edit", resource: "packages/docs/*.mdx", effect: "deny" },
  ], { action: "EDIT", resource: "PACKAGES\\DOCS\\Guide.MDX" }, { platform: "win32" })
  assert.equal(result.effect, "deny")
})

test("multiple resources aggregate deny before ask before allow", () => {
  const result = evaluatePermissionRules([
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "*.env", effect: "deny" },
  ], { action: "edit", resources: ["src/a.ts", ".env"] })
  assert.equal(result.effect, "deny")
})

test("UES compatibility default is allow when no rule matches", () => {
  const result = evaluatePermissionRules([], { action: "shell", resource: "npm test" })
  assert.equal(result.effect, "allow")
})

test("tool request mapping uses OpenCode-style actions", () => {
  assert.deepEqual(
    toolPermissionRequest("powershell", { command: "git status --short" }),
    { action: "shell", resources: ["git status --short"] },
  )
  assert.deepEqual(
    toolPermissionRequest("write", { path: "src/a.ts" }),
    { action: "edit", resources: ["src/a.ts"] },
  )
  assert.deepEqual(
    toolPermissionRequest("ues_session", { action: "follow-up" }),
    { action: "session", resources: ["follow-up"] },
  )
})

test("deny-and-continue recovery tells weak models not to loop on blocked actions", () => {
  const request = { action: "shell", resources: ["git push origin main"] }
  const decision = evaluatePermissionRules([
    { action: "shell", resource: "git push *", effect: "deny" },
  ], request)
  const hint = permissionRecoveryHint(request, decision)
  assert.match(hint, /Do not repeat the same blocked shell request/)
  assert.match(hint, /narrowest allowed, reversible alternative/)
  assert.match(hint, /report the blocker with evidence/)
})

test("agent rules append after global rules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    defaultEffect: "allow",
    permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    agents: {
      "ues-reviewer": {
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      },
    },
  }))
  const store = new PermissionPolicyStore(file)
  const result = await store.evaluate(
    { action: "edit", resources: ["src/a.ts"] },
    { agent: "ues-reviewer" },
  )
  assert.equal(result.decision.effect, "deny")
  assert.equal(result.decision.decisions[0].matchedRule.index, 1)
})

test("store hot-reloads when config file changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    permissions: [{ action: "shell", resource: "git push *", effect: "deny" }],
  }))
  const store = new PermissionPolicyStore(file)
  const before = await store.evaluate({ action: "shell", resources: ["git push origin main"] })
  assert.equal(before.decision.effect, "deny")

  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(file, JSON.stringify({
    permissions: [{ action: "shell", resource: "git push *", effect: "allow" }],
  }))
  const after = await store.evaluate({ action: "shell", resources: ["git push origin main"] })
  assert.equal(after.decision.effect, "allow")
})

test("agent/role rules narrow but never widen the repo baseline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-monotonic-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    defaultEffect: "allow",
    permissions: [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
    ],
    agents: {
      "ues-child": {
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "edit", resource: "src/*", effect: "allow" },
          { action: "edit", resource: "secrets/*", effect: "deny" },
        ],
      },
    },
  }))
  const store = new PermissionPolicyStore(file)
  const shell = await store.evaluate(
    { action: "shell", resources: ["git status"] },
    { agent: "ues-child" },
  )
  assert.equal(shell.decision.effect, "deny", "a role allow cannot erase a repo deny")
  assert.equal(shell.decision.decisions[0].matchedRule.index, 0)

  const edit = await store.evaluate(
    { action: "edit", resources: ["src/a.ts"] },
    { agent: "ues-child" },
  )
  assert.equal(edit.decision.effect, "ask", "a role allow cannot erase a repo ask")

  const narrowed = await store.evaluate(
    { action: "edit", resources: ["secrets/token.txt"] },
    { agent: "ues-child" },
  )
  assert.equal(narrowed.decision.effect, "deny", "a role deny still narrows")
})

test("agent allow cannot override a default-deny baseline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-default-deny-"))
  const file = path.join(dir, "permissions.json")
  await writeFile(file, JSON.stringify({
    defaultEffect: "deny",
    permissions: [],
    agents: {
      "ues-child": { permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
    },
  }))
  const store = new PermissionPolicyStore(file)
  const decision = await store.evaluate(
    { action: "shell", resources: ["npm test"] },
    { agent: "ues-child" },
  )
  assert.equal(decision.decision.effect, "deny")
})

test("the exposure lattice applies the same monotonic role boundary", () => {
  const plan = compilePolicyLattice([
    { name: "repo", rules: [{ action: "shell", resource: "*", effect: "deny" }] },
    { name: "role", rules: [{ action: "shell", resource: "*", effect: "allow" }] },
  ], ["bash", "read"])
  assert.equal(plan.tools.includes("bash"), false, "a role allow must not expose a repo-denied tool")
  assert.equal(plan.tools.includes("read"), true)
  assert.equal(plan.hidden[0].reason, "role-layer-monotonic-deny")

  const decision = evaluatePolicyLattice([
    { name: "repo", rules: [{ action: "shell", resource: "*", effect: "deny" }] },
    { name: "role", rules: [{ action: "shell", resource: "*", effect: "allow" }] },
  ], { action: "shell", resource: "git status" })
  assert.equal(decision.decision.effect, "deny")

  // An explicit user layer remains able to override (documented precedence).
  const user = evaluatePolicyLattice([
    { name: "repo", rules: [{ action: "shell", resource: "*", effect: "deny" }] },
    { name: "user", rules: [{ action: "shell", resource: "git status", effect: "allow" }] },
  ], { action: "shell", resource: "git status" })
  assert.equal(user.decision.effect, "allow")
})

test("permission store errors fail closed instead of silently allowing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-permission-invalid-"))
  const file = path.join(dir, "permissions.json")

  await writeFile(file, "{ not-json")
  const broken = new PermissionPolicyStore(file)
  await assert.rejects(() => broken.evaluate({ action: "shell", resources: ["git status"] }), /JSON/i)

  await writeFile(file, JSON.stringify({
    permissions: [{ action: "shell", resource: "*", effect: "maybe" }],
  }))
  const invalid = new PermissionPolicyStore(file)
  await assert.rejects(
    () => invalid.evaluate({ action: "shell", resources: ["git status"] }),
    /effect=allow\|deny\|ask/,
  )

  const missing = new PermissionPolicyStore(path.join(dir, "absent.json"))
  const unconfigured = await missing.evaluate({ action: "shell", resources: ["git status"] })
  assert.equal(unconfigured.configured, false)
  assert.equal(unconfigured.decision, null)
})
