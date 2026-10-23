#!/usr/bin/env node
// Cross-platform replacement for `command > /dev/null` inside npm scripts.
//
// WHY
//
// `/dev/null` does not exist on Windows, and cmd.exe treats `> nul` differently
// enough that a copied script string becomes fragile. This runner spawns the
// child WITHOUT a shell, suppresses only stdout, keeps stderr visible, and exits
// with the child's exact status. A failing eval can therefore never be hidden by
// the redirection itself.
//
// USAGE
//
//   node scripts/run-quiet.mjs node scripts/eval-example.mjs
//   node scripts/run-quiet.mjs node "C:\path with spaces\script.mjs" --flag
//
// The executable is passed directly (no shell interpolation), so paths with
// spaces, Unicode and Windows separators are safe.

import { spawn } from "node:child_process"
import path from "node:path"

const argv = process.argv.slice(2)
if (!argv.length) {
  process.stderr.write("run-quiet: missing command\n")
  process.exit(127)
}

function isNodeExecutable(value) {
  const base = path.basename(String(value || "")).toLowerCase()
  return base === "node" || base === "node.exe"
}

const command = argv[0]
const resolvedCommand = isNodeExecutable(command) ? process.execPath : command
const args = argv.slice(1)

let spawnFailed = false
let child
try {
  child = spawn(resolvedCommand, args, {
    stdio: ["inherit", "ignore", "inherit"],
    shell: false,
    windowsHide: true,
  })
} catch (error) {
  process.stderr.write(`run-quiet: failed to start ${command}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(127)
}

child.on("error", (error) => {
  spawnFailed = true
  process.stderr.write(`run-quiet: failed to start ${command}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 127
})

child.on("close", (code, signal) => {
  // On Windows a spawn failure also emits `close` with a negative libuv error
  // code. That must not overwrite the explicit 127.
  if (spawnFailed) return
  if (typeof code === "number" && code >= 0) {
    process.exitCode = code
    return
  }
  // A signal-terminated child has no exit code. Report it on stderr and fail;
  // never turn a killed verification into a green run.
  process.stderr.write(`run-quiet: ${command} terminated by signal ${signal || "unknown"}\n`)
  process.exitCode = 1
})
