import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.18 Edge setup: worker uses Microsoft Edge channel", () => {
  const source = readFileSync(path.join(ROOT, "scripts", "browser-worker-v16-3.mjs"), "utf8")
  assert.match(source, /UES_PLAYWRIGHT_CHANNEL \|\| "msedge"/)
  assert.match(source, /channel: BROWSER_CHANNEL/)
})

test("V16.18 Edge setup: preflight unwraps worker capability payload", () => {
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  assert.match(cli, /capability\?\.payload/)
  assert.match(cli, /capabilityPayload\?\.browserState/)
})

test("V16.18 Edge setup: CLI exposes setup action", () => {
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  assert.match(cli, /action === "setup"/)
  assert.match(cli, /deepseekSetup\(/)
  assert.match(cli, /--browser/)
  assert.match(cli, /setup --browser edge --profile/)
})

test("V16.18 Edge setup: help mentions Edge-managed profile", () => {
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  assert.match(cli, /uses a separate UES-managed Microsoft Edge profile/)
})

test("V16.18 Edge setup: README documents Windows command", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8")
  assert.match(readme, /deepseek setup --browser edge --profile personal/)
  assert.match(readme, /channel: "msedge"/)
})
