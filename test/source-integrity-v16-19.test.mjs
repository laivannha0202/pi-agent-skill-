import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateV16_18SourceIntegrity,
  validateV16_19SourceIntegrity,
} from "../scripts/check-source-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("V16.19 source integrity passes", () => {
  assert.deepEqual(validateV16_19SourceIntegrity(), []);
});

test("V16.18 source integrity still passes", () => {
  assert.deepEqual(validateV16_18SourceIntegrity(), []);
});

function collectSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.(?:ts|mjs|js|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

// Decode the subset of string-literal escapes used by the shipped sources.
function decodeLiteralBody(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === "u") {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (next === "n") {
      out += "\n";
      i += 1;
    } else if (next === "t") {
      out += "\t";
      i += 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function fingerprintUpdateLine() {
  const source = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8");
  const line = source
    .split("\n")
    .find((entry) => entry.includes(".update(toolName") && entry.includes("failure.class"));
  assert.ok(line, "failure fingerprint update line not found in pi/extensions/ues.ts");
  const literals = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = re.exec(line))) literals.push(match[1]);
  return { source, line, literals: literals.map(decodeLiteralBody) };
}

test("V16.19.0 shipped sources contain no raw NUL bytes", () => {
  const offenders = [];
  for (const dir of ["pi", "lib", "scripts", "bin", "global-config"]) {
    for (const file of collectSourceFiles(path.join(ROOT, dir))) {
      if (readFileSync(file).includes("\u0000")) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("V16.19.0 failure fingerprint uses escaped NUL separators with unchanged hash", () => {
  const { source, literals } = fingerprintUpdateLine();
  assert.equal((source.match(/\u0000/g) || []).length, 0, "raw NUL byte present in ues.ts");
  assert.equal(literals.length, 4, "expected 4 separator literals in the fingerprint concatenation");
  for (const literal of literals) {
    assert.equal(literal, "\u0000", "fingerprint separator must decode to a single NUL character");
  }
  const sep = literals[0];
  const fingerprint = (toolName, command, failureClass, reason, resultText) =>
    createHash("sha256")
      .update(toolName + sep + command + sep + failureClass + sep + String(reason) + sep + resultText.slice(0, 500))
      .digest("hex")
      .slice(0, 20);
  // Golden value produced by the pre-cleanup source (raw NUL separators).
  assert.equal(
    fingerprint("ues_cli", "npm test", "IMPLEMENTATION_FAILURE", "child exited 1", "x".repeat(600)),
    "43c43ebe969eecaab87c",
  );
});

test("V16.19 release consistency: no eval script names a test file that does not exist", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const missing = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (!name.startsWith("eval:") || typeof command !== "string") continue;
    for (const token of command.split(/\s+/)) {
      if (!token.startsWith("test/") || !token.endsWith(".mjs")) continue;
      if (!existsSync(path.join(ROOT, token))) missing.push(`${name} -> ${token}`);
    }
  }
  assert.deepEqual(missing, []);
});
