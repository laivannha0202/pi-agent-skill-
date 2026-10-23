// V16.18 shell-safety hardening regression suite.
//
// These tests prove that the safety gate understands the SAME destructive
// operation through every common shell wrapper, that global Git options cannot
// hide a force/discard command, and that ordinary read-only development
// commands are not turned into false positives.

import assert from "node:assert/strict"
import test from "node:test"

import {
  destructiveShellAnalysis,
  destructiveShellRisk,
  shellCommandSegments,
} from "../global-config/plugins/ues-router/safety.js"
import * as coreSafety from "../lib/safety.mjs"

function expectRisk(command, id) {
  assert.equal(destructiveShellRisk(command).id, id, command)
}

function expectSafe(command) {
  assert.equal(destructiveShellRisk(command).risky, false, command)
}

test("S1: the core import path delegates to the single canonical classifier", () => {
  assert.equal(coreSafety.destructiveShellRisk, destructiveShellRisk)
  assert.equal(coreSafety.destructiveShellAnalysis, destructiveShellAnalysis)
  assert.equal(coreSafety.shellCommandSegments, shellCommandSegments)
})

test("S2: ordinary read-only development commands stay allowed", () => {
  for (const command of [
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff --stat",
    "git checkout -b feature/login",
    "git push origin main",
    "git clean -n",
    "npm test",
    "npm run lint",
    "pnpm build",
    "node --test test/a.test.mjs",
    "dotnet test",
    "grep -R \"git reset --hard\" docs",
    "rg \"npm publish\" README.md",
    "echo \"git push --force\"",
    "git commit -m \"document git push --force\"",
    "npm run publish",
    "kubectl get pods",
    "helm list",
    "terraform plan",
    "rm -f build.log",
    "rm -r build",
    "rmdir empty-directory",
  ]) {
    expectSafe(command)
  }
})

test("S3: Git global options cannot hide force, hard reset or clean", () => {
  for (const command of [
    "git reset --hard HEAD~1",
    "git push origin main -f",
    "git push -f origin main",
    "git push --force",
    "git push --force-with-lease origin main",
    "git push origin +main",
    "git push --mirror origin",
    "git push --delete origin old-branch",
    "git push origin :old-branch",
    "git -C repo push --force",
    "git -Crepo push -fu origin main",
    "git -c core.pager=cat reset --hard",
    "git -c core.pager=cat push --force",
    "git --git-dir=.git push --force",
    "git --git-dir=.git --work-tree=. clean -fdx",
    "git --no-pager clean -fd",
    'git -C "C:\\repo with spaces" push -f',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push --force',
  ]) {
    const risk = destructiveShellRisk(command)
    assert.equal(risk.risky, true, command)
    assert.equal(risk.id, "git-force", command)
  }
})

test("S4: work-discarding and history-rewriting commands keep their own ids", () => {
  for (const command of [
    "git restore src/a.ts",
    "git checkout -- src/a.ts",
    "git checkout .",
    "git checkout -f main",
    "git switch --discard-changes main",
    "git stash",
    "git -C repo stash pop",
  ]) {
    expectRisk(command, "git-discard-work")
  }
  for (const command of [
    "git rebase main",
    "git -C repo rebase -i HEAD~3",
    "git filter-branch --tree-filter true HEAD",
    "git filter-repo --path src",
  ]) {
    expectRisk(command, "history-rewrite")
  }
})

test("S5: POSIX shell wrappers and clustered -c flags are unwrapped", () => {
  for (const command of [
    'sh -c "git push --force"',
    'bash -c "git reset --hard"',
    'bash -lc "git clean -fd"',
    'zsh -ec "git push -f"',
    'dash --noprofile -c "git restore src/a.ts"',
    "sh -c 'npm publish'",
  ]) {
    const risk = destructiveShellRisk(command)
    assert.equal(risk.risky, true, command)
    assert.ok(["git-force", "git-discard-work", "publish"].includes(risk.id), command)
  }
})

test("S6: Windows cmd/PowerShell wrappers and encoded commands are unwrapped", () => {
  expectRisk('cmd /c "git reset --hard"', "git-force")
  expectRisk('cmd.exe /d /s /c "git clean -fdx"', "git-force")
  expectRisk('powershell -NoProfile -Command "git push --force"', "git-force")
  expectRisk('pwsh -c "git restore src/a.ts"', "git-discard-work")
  expectRisk('powershell -CommandWithArgs "git push -f"', "git-force")

  const encoded = Buffer.from("git push --force", "utf16le").toString("base64")
  expectRisk(`powershell -EncodedCommand ${encoded}`, "git-force")
  const safeEncoded = Buffer.from("Write-Host hello", "utf16le").toString("base64")
  expectSafe(`pwsh -enc ${safeEncoded}`)
  // An encoded payload we cannot decode is NOT assumed safe.
  expectRisk("powershell -EncodedCommand not-valid-base64!!!", "obfuscated-shell")
})

test("S7: env/sudo/timeout/nice/xargs/eval/npx wrappers preserve the inner command", () => {
  for (const command of [
    "env FOO=bar git push --force",
    "env -i PATH=/usr/bin git reset --hard",
    "env -u TOKEN sudo -E git clean -fd",
    "sudo -u root -E git push -f",
    "doas -u root git push --force",
    "timeout 10 git push --force",
    "timeout -s KILL 10 git push --force",
    "nice -n 10 git push --force",
    "xargs -0 git push --force",
    "xargs -0 -n1 rm -rf",
    'eval "git push --force"',
    "npx --yes npm publish",
    "pnpm dlx npm publish",
    'npx -c "git push --force"',
    "busybox rm -rf build",
    "command git push --force",
    "exec -a app git push --force",
    'start "" cmd /c "git reset --hard"',
  ]) {
    const risk = destructiveShellRisk(command)
    assert.equal(risk.risky, true, command)
    assert.ok(["git-force", "destructive-files", "publish"].includes(risk.id), command)
  }
})

test("S8: chaining, background and pipelines cannot park a destructive segment", () => {
  for (const command of [
    "git status && git push --force",
    "git status || git reset --hard",
    "git status; git clean -fd",
    "git status | tee log; git push -f",
    "git status & git push --force",
    "true && (git push --force)",
    "if true; then git push --force; fi",
    "while true; do git push --force; done",
    "{ git push --force; }",
    "for f in a b; do git push --force; done",
    "git status\nnpm publish\n",
  ]) {
    const risk = destructiveShellRisk(command)
    assert.equal(risk.risky, true, command)
  }
  // Redirections are not command separators and must not split a safe command
  // into a fake destructive one.
  expectSafe("npm test 2>&1")
  expectSafe("npm test > build.log 2>&1")
})

test("S9: command substitution and backticks are inspected, even inside double quotes", () => {
  for (const command of [
    "echo $(git push --force)",
    'echo "$(git push --force)"',
    "echo `git push --force`",
    "echo $(bash -c \"git clean -fd\")",
    "echo $(env FOO=1 git reset --hard)",
    "echo ${UNSET:-$(git push --force)}",
    "cat <(git push --force)",
  ]) {
    const risk = destructiveShellRisk(command)
    assert.equal(risk.risky, true, command)
  }
  // A literal mention in a quoted argument is data, not an executed command.
  expectSafe("echo '$(git push --force)'")
  expectSafe("echo '`git push --force`'")
  expectSafe("echo \\$(git push --force)")
})

test("S10: rm/rmdir/del/Remove-Item need the destructive flag combination", () => {
  for (const command of [
    "rm -rf build",
    "rm -fr build",
    "rm -Rf build",
    "rm -r -f build",
    "rm --recursive --force build",
    "rm -r --force build",
    "del /s /q build",
    "del /f /s build",
    "rmdir /s /q build",
    "rd /s build",
    "Remove-Item -Recurse -Force build",
    "ri -Recurse -Force build",
    "rm -Recurse -Force build",
  ]) {
    expectRisk(command, "destructive-files")
  }
  for (const command of ["rm build.log", "rm -f build.log", "rm -r build", "del build.log", "rmdir empty"]) {
    expectSafe(command)
  }
})

test("S11: publish and deployment global flags are skipped, not treated as the verb", () => {
  for (const command of [
    "npm publish --access public",
    "npm --prefix ./packages/app publish",
    "npm --workspace app publish",
    "pnpm --filter @scope/app publish",
    "yarn npm publish",
    "yarn --cwd packages/app publish",
    "bun publish",
    "npm exec -- npm publish",
  ]) {
    expectRisk(command, "publish")
  }
  for (const command of [
    "kubectl delete pod api",
    "kubectl -n production delete deployment api",
    "kubectl --namespace=production apply -f k8s/",
    "terraform destroy -auto-approve",
    "terraform -chdir=infra destroy",
    "helm upgrade --install api chart/",
    "helm -n production uninstall api",
  ]) {
    expectRisk(command, "deployment")
  }
})

test("S12: SQL is classified at command position or through a SQL client, not from docs text", () => {
  expectRisk("DROP TABLE users;", "database-drop")
  expectRisk("truncate table audit_log", "database-drop")
  expectRisk('psql -c "drop table users"', "database-drop")
  expectRisk('mysql -e "drop database app"', "database-drop")
  expectRisk('sqlite3 app.db "drop table users"', "database-drop")
  expectSafe('echo "drop table users"')
  expectSafe('grep -R "truncate table" migrations/')
  expectSafe('git commit -m "drop table migration"')
})

test("S13: analysis keeps the documented shape and deduplicates findings", () => {
  const analysis = destructiveShellAnalysis("git status && git push --force")
  assert.equal(analysis.risky, true)
  assert.equal(analysis.id, "git-force")
  assert.equal(analysis.segmentCount, 2)
  assert.equal(analysis.findings.length, 1)
  assert.equal(analysis.findings[0].segmentIndex, 1)
  assert.equal(analysis.findings[0].operator, null)

  const segments = shellCommandSegments("a && b | c; d")
  assert.deepEqual(segments.map((row) => row.text), ["a", "b", "c", "d"])
  assert.deepEqual(segments.map((row) => row.operator), ["&&", "|", ";", null])

  const empty = destructiveShellAnalysis(null)
  assert.deepEqual(empty, { risky: false, id: null, findings: [], segmentCount: 0 })
})
