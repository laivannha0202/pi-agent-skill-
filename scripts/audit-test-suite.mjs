// Non-destructive audit. Similar names and titles are REVIEW candidates, not proof of redundant coverage.
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const groups = [
  ["verification", /verification|verifier|evidence|receipt|integrity|completion|gate-|acceptance|verified/],
  ["security", /shell|safety|permission|untrusted|sandbox|security|auth/],
  ["browser-research", /browser|deepseek|web-reasoning|research|mcp|ui-inspector|visual/],
  ["context-intelligence", /context|memory|retriev|repo-map|lsp|semantic|code-intelligence|token|prompt-cache/],
  ["orchestration", /task-|orchestrat|subagent|delegation|parallel|execution|advisor|agent-|decision|planning/],
  ["runtime-lifecycle", /process|runtime|resource|service|workspace|worktree|windows|shim|lock|gc-|cleanup/],
  ["distribution", /release|installer|package|compat|docs|cli|version/],
]

async function walk(dir) {
  const output = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await walk(file))
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) output.push(file)
  }
  return output
}

function collisions(map) {
  return [...map.entries()]
    .map(([key, files]) => ({ key, files: [...new Set(files)].sort() }))
    .filter((item) => item.files.length > 1)
    .sort((a, b) => b.files.length - a.files.length || a.key.localeCompare(b.key))
}

function familyName(file) {
  return path.basename(file, ".test.mjs")
    .replace(/[-_.]v\d+(?:[-.]\d+)*/gi, "")
    .replace(/--+/g, "-")
    .replace(/[-_.]+$/, "")
    .toLowerCase()
}

async function audit() {
  const files = (await walk(path.join(root, "test"))).sort()
  const hashes = new Map(), families = new Map(), titles = new Map()
  const groupCounts = Object.fromEntries([...groups.map(([name]) => name), "other"].map((name) => [name, 0]))
  let bytes = 0, versionNamed = 0, staticTitles = 0

  for (const full of files) {
    const file = path.relative(root, full).replaceAll("\\", "/")
    const content = await readFile(full, "utf8")
    const name = path.basename(file).toLowerCase()
    const hash = createHash("sha256").update(content).digest("hex")
    const family = familyName(file)
    const group = groups.find(([, re]) => re.test(name))?.[0] || "other"
    bytes += Buffer.byteLength(content)
    versionNamed += Number(/(?:^|[-_.])v\d+/i.test(name))
    groupCounts[group] += 1
    hashes.set(hash, [...(hashes.get(hash) || []), file])
    families.set(family, [...(families.get(family) || []), file])
    const names = new Set()
    for (const match of content.matchAll(/\b(?:test|it)\s*\(\s*(["'])([^\n]{12,150}?)\1\s*,/g)) {
      names.add(match[2].trim().replace(/\s+/g, " ").toLowerCase())
    }
    staticTitles += names.size
    for (const title of names) titles.set(title, [...(titles.get(title) || []), file])
  }

  return {
    schemaVersion: 1,
    totalFiles: files.length,
    totalBytes: bytes,
    versionNamedFiles: versionNamed,
    extractedStaticTestTitles: staticTitles,
    groupCounts,
    exactFileDuplicates: collisions(hashes),
    repeatedTestTitles: collisions(titles),
    versionNameFamilies: collisions(families),
    caveat: "Names and repeated titles are only review candidates. Preserve assertions and regression coverage before any merge.",
  }
}

const result = await audit()
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const flag = process.argv.find((arg) => arg.startsWith("--top="))
  const parsed = Number(flag?.slice(6))
  const top = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 12
  console.log("UES test inventory: " + result.totalFiles + " files / " + result.totalBytes + " bytes")
  console.log("Version-named files: " + result.versionNamedFiles)
  console.log("Static test titles identified: " + result.extractedStaticTestTitles)
  for (const [name, count] of Object.entries(result.groupCounts)) console.log("  " + name + ": " + count)
  console.log("Exact duplicate files: " + result.exactFileDuplicates.length)
  console.log("Repeated test titles across files: " + result.repeatedTestTitles.length)
  console.log("Version naming families: " + result.versionNameFamilies.length)
  for (const row of result.versionNameFamilies.slice(0, top)) console.log("  " + row.key + ": " + row.files.length + " files")
  console.log(result.caveat)
}
