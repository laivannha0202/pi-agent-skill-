// ---------------------------------------------------------------------------
// Shell safety gate (canonical implementation).
//
// WHY THIS FILE IS THE OWNER
//
// The UES router plugin is installed as a self-contained directory under the
// user's OpenCode config; it cannot import `lib/` from the npm package. The
// extension and the core runtime therefore re-export THIS module through
// `lib/safety.mjs`. Keeping one implementation (instead of two drifting copies)
// means the installed plugin and the Pi extension can never disagree about what
// is destructive.
//
// WHAT IT DOES
//
// The gate is a STATIC classifier. It does not run the command and it does not
// try to prove a command safe; it proves that a command it can UNDERSTAND does
// not contain a known destructive operation. Shell wrappers (`sh -c`, `cmd /c`,
// PowerShell `-Command`, `env`, `sudo`, `timeout`, `xargs`, `eval`, ...), command
// substitution (`$(...)`, backticks), chaining and quoting are unwrapped first,
// because `bash -c "git push --force"` is the same operation as the direct form.
//
// Fail closed on ambiguity: a shell wrapper that cannot be inspected (for
// example an encoded PowerShell command that is not valid base64) is reported as
// `obfuscated-shell`, never silently allowed.
// ---------------------------------------------------------------------------

const MAX_NESTING = 6

const SAFETY_RULES = Object.freeze([
  "git-force",
  "git-discard-work",
  "history-rewrite",
  "publish",
  "destructive-files",
  "database-drop",
  "deployment",
  "obfuscated-shell",
])

const GIT_VALUE_OPTIONS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env", "--attr-source",
])

const SUDO_VALUE_OPTIONS = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
  "-C", "--close-from", "-T", "--command-timeout", "-r", "--role",
  "-t", "--type", "-U", "--other-user", "-D", "--chdir",
])

const ENV_VALUE_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "-S", "--split-string",
])

const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"])
const NICE_VALUE_OPTIONS = new Set(["-n", "--adjustment"])
const EXEC_VALUE_OPTIONS = new Set(["-a"])
const XARGS_VALUE_OPTIONS = new Set([
  "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace",
  "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s",
  "--max-chars",
])
const NPM_VALUE_OPTIONS = new Set([
  "--prefix", "--cwd", "-C", "--filter", "-F", "--workspace", "-w",
  "--registry", "--userconfig", "--cache", "--loglevel", "--tag", "--access",
  "--otp", "--scope", "--location", "--include", "--omit",
])
const NPX_VALUE_OPTIONS = new Set([
  "--package", "-p", "--cache", "--registry", "--userconfig", "--call", "-c",
])
const KUBECTL_VALUE_OPTIONS = new Set([
  "-n", "--namespace", "--context", "--kubeconfig", "--server", "--token",
  "--user", "--cluster", "--request-timeout", "--cache-dir", "--as",
  "--as-group", "--as-uid", "--certificate-authority", "--client-certificate",
  "--client-key", "--tls-server-name", "--v", "-v", "--log-flush-frequency",
  "--log-file", "--log-file-max-size", "--vmodule", "--profile", "--profile-output",
])
const TERRAFORM_VALUE_OPTIONS = new Set(["-chdir", "--chdir"])
const HELM_VALUE_OPTIONS = new Set([
  "-n", "--namespace", "--kube-context", "--kubeconfig", "--kube-apiserver",
  "--kube-token", "--registry-config", "--repository-cache", "--repository-config",
  "--burst-limit", "--qps", "-v", "--v", "--set", "--set-string", "--values",
  "-f", "--set-file", "--set-json", "--set-literal", "--description",
])

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"])
const POWERSHELLS = new Set(["powershell", "pwsh"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
const DESTRUCTIVE_FILE_TOOLS = new Set(["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri"])
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "do", "while", "until", "for", "in", "case",
  "esac", "function", "select", "time", "!", "{", "}", "(",
])

function normalizeExecutable(value) {
  let text = String(value || "").trim().replace(/^["']|["']$/g, "")
  if (!text) return ""
  const normalizedEnv = text.toLowerCase()
  if (normalizedEnv === "%comspec%" || normalizedEnv === "$comspec") return "cmd"
  text = text.replace(/^.*[\\/]/, "")
  text = text.replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "")
  return text.toLowerCase()
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(word || ""))
}

/**
 * Split a command into simple segments at shell control operators. Operators
 * inside quotes, `$(...)`, backticks and grouping parentheses never split.
 * The `operator` on each segment is the separator that FOLLOWED it, matching the
 * historical public shape.
 */
export function shellCommandSegments(command) {
  const value = String(command || "")
  const segments = []
  let current = ""
  let quote = null
  let escaped = false
  let depth = 0
  let backtick = false

  const push = (operator = null) => {
    const text = current.trim()
    if (text) segments.push({ text, operator })
    current = ""
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1] || ""

    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (backtick) {
      current += char
      if (char === "`") backtick = false
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "`") {
      backtick = true
      current += char
      continue
    }
    if (char === "$" && next === "(") {
      depth += 1
      current += "$("
      index += 1
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1
      current += char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (depth > 0) {
      current += char
      continue
    }

    if (char === "&" && next === "&") {
      push("&&")
      index += 1
      continue
    }
    if (char === "|" && next === "|") {
      push("||")
      index += 1
      continue
    }
    if (char === "|" && next === "&") {
      push("|&")
      index += 1
      continue
    }
    if (char === "|" || char === ";") {
      push(char)
      continue
    }
    if (char === "\n" || char === "\r") {
      push("\n")
      continue
    }
    // A single `&` backgrounds a command. `>&2`, `2>&1` and `&>` are
    // redirections, not command separators.
    if (char === "&" && next !== ">" && value[index - 1] !== ">") {
      push("&")
      continue
    }
    current += char
  }
  push(null)
  return segments
}

/**
 * Tokenize one simple segment. Adjacent quoted/unquoted pieces concatenate into
 * one word (`g""it` -> `git`), escaped characters stay literal, and empty quoted
 * arguments are preserved.
 */
function shellWords(segment) {
  const source = String(segment || "")
  const words = []
  let current = ""
  let started = false
  let quote = null
  let escaped = false

  const push = () => {
    if (started) words.push(current)
    current = ""
    started = false
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      current += char
      started = true
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      const next = source[index + 1] || ""
      // Inside double quotes a backslash only escapes $ ` " \ and newline.
      // Outside quotes it only escapes shell syntax. A Windows path separator
      // (C:\repo\src) is therefore preserved instead of being eaten.
      const special = quote === '"'
        ? /[$`"\\\n]/.test(next)
        : /[\s"'\\|&;<>(){}]/.test(next)
      if (special) {
        escaped = true
        started = true
      } else {
        current += "\\"
        started = true
      }
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/[(){};&|]/.test(char)) {
      push()
      words.push(char)
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
    started = true
  }
  push()
  return words
}

/** Find the matching `)` for a `$(` at `start`, respecting quotes/nesting. */
function matchingParen(source, start) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Extract command-substitution bodies: `$(...)` and backticks. */
function nestedSubstitutions(segment) {
  const source = String(segment || "")
  const output = []
  let quote = null
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === "'" && quote === null) {
      quote = "'"
      continue
    }
    if (char === '"' && quote === '"') {
      quote = null
      continue
    }
    if (char === '"' && quote === null) {
      quote = '"'
      continue
    }
    if ((char === "$" || char === "<" || char === ">") && source[index + 1] === "(") {
      // `$(...)` is command substitution; `<(...)` / `>(...)` are process
      // substitution. All three execute their body.
      const end = matchingParen(source, index + 1)
      if (end === -1) {
        output.push(source.slice(index + 2))
        break
      }
      output.push(source.slice(index + 2, end))
      index = end
      continue
    }
    if (char === "`") {
      let end = index + 1
      let innerEscaped = false
      for (; end < source.length; end += 1) {
        if (innerEscaped) {
          innerEscaped = false
          continue
        }
        if (source[end] === "\\") {
          innerEscaped = true
          continue
        }
        if (source[end] === "`") break
      }
      if (end >= source.length) {
        output.push(source.slice(index + 1))
        break
      }
      output.push(source.slice(index + 1, end))
      index = end
    }
  }
  return output
}

function skipOptions(words, start, valueOptions) {
  let index = start
  while (index < words.length) {
    const token = String(words[index] || "")
    if (token === "--") return index + 1
    if (!token.startsWith("-") || token === "-") break
    const equals = token.indexOf("=")
    const key = equals >= 0 ? token.slice(0, equals) : token
    if (equals < 0 && valueOptions.has(key)) index += 2
    else index += 1
  }
  return index
}

function stripShellPrefixes(words) {
  let output = [...words]
  let guard = 0
  while (output.length && guard < 16) {
    guard += 1
    const name = normalizeExecutable(output[0])
    if (name === "&") {
      output = output.slice(1)
      continue
    }
    if (SHELL_KEYWORDS.has(name)) {
      output = output.slice(1)
      continue
    }
    if (isAssignment(output[0])) {
      output = output.slice(1)
      continue
    }
    break
  }
  return output
}

/** Decode a PowerShell -EncodedCommand payload. Returns null if unreadable. */
function decodePowerShell(value) {
  try {
    const raw = String(value || "").trim()
    // Buffer.from(..., "base64") silently ignores invalid characters. An
    // encoded command must be canonical base64 before we can claim to have
    // inspected it; otherwise the safe answer is "unreadable", not "safe".
    if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null
    const buffer = Buffer.from(raw, "base64")
    if (!buffer.length) return null
    const text = buffer.toString("utf16le").replace(/^\uFEFF/, "").replace(/\u0000+$/g, "")
    if (!text.trim()) return null
    // Base64 is permissive; reject binary garbage rather than pretending it was
    // inspected. Control characters other than tab/newline are not a script.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null
    return text
  } catch {
    return null
  }
}

function pushFinding(findings, id, context, extra = {}) {
  if (!id) return false
  if (findings.some((row) => row.id === id && row.segmentIndex === context.segmentIndex)) return false
  findings.push({
    id,
    segmentIndex: context.segmentIndex,
    segment: context.segment,
    operator: context.operator,
    ...extra,
  })
  return true
}

function gitClassification(args) {
  const words = [...args]
  let index = 0
  while (index < words.length) {
    const token = String(words[index] || "")
    if (token === "--") {
      index += 1
      break
    }
    if (!token.startsWith("-") || token === "-") break
    const equals = token.indexOf("=")
    const key = equals >= 0 ? token.slice(0, equals) : token
    if (equals < 0 && GIT_VALUE_OPTIONS.has(key)) {
      index += 2
      continue
    }
    // Attached forms: -Cdir, -cname=value, --git-dir=dir.
    if (
      token.startsWith("-C") && token.length > 2 ||
      token.startsWith("-c") && token.length > 2 ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=") ||
      token.startsWith("--namespace=") ||
      token.startsWith("--config-env=")
    ) {
      index += 1
      continue
    }
    index += 1
  }
  const subcommand = String(words[index] || "").toLowerCase()
  const rest = words.slice(index + 1)
  if (!subcommand) return null

  if (subcommand === "push") {
    let forced = false
    for (const token of rest) {
      const value = String(token || "")
      if (value === "--") break
      if (
        value === "--force" ||
        value.startsWith("--force-with-lease") ||
        value === "--force-if-includes" ||
        value === "--mirror" ||
        value === "--prune" ||
        value === "--delete" ||
        value === "-d" ||
        value.startsWith("+") ||
        value.startsWith(":")
      ) {
        forced = true
        break
      }
      if (/^-[A-Za-z]+$/.test(value) && /f/.test(value.slice(1))) {
        forced = true
        break
      }
    }
    return forced ? "git-force" : null
  }
  if (subcommand === "reset" && rest.some((token) => String(token).toLowerCase() === "--hard")) {
    return "git-force"
  }
  if (subcommand === "clean") {
    const forced = rest.some((token) => {
      const value = String(token || "")
      return value === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(value)
    })
    return forced ? "git-force" : null
  }
  if (subcommand === "restore" || subcommand === "stash") return "git-discard-work"
  if (subcommand === "checkout") {
    const discards = rest.some((token) => {
      const value = String(token || "")
      return (
        value === "--" ||
        value === "-f" ||
        value === "--force" ||
        value === "--discard-changes" ||
        value === "."
      )
    })
    return discards ? "git-discard-work" : null
  }
  if (subcommand === "switch") {
    const discards = rest.some((token) =>
      ["-f", "--force", "--discard-changes"].includes(String(token || "")))
    return discards ? "git-discard-work" : null
  }
  if (["rebase", "filter-branch", "filter-repo"].includes(subcommand)) return "history-rewrite"
  return null
}

function packageManagerClassification(name, args) {
  let words = [...args]
  if (name === "yarn" && String(words[0] || "").toLowerCase() === "npm") {
    words = words.slice(1)
  }
  const index = skipOptions(words, 0, NPM_VALUE_OPTIONS)
  const subcommand = String(words[index] || "").toLowerCase()
  if (subcommand === "publish") return "publish"
  // `npm exec -- npm publish`, `pnpm dlx`, `yarn x`: the package manager is a
  // wrapper around another command. Unwrap only when the inner command is a
  // package manager we can classify; arbitrary packages stay opaque.
  if (["exec", "x", "dlx"].includes(subcommand)) {
    const inner = words.slice(index + 1).filter((token) => token !== "--")
    if (inner.length && PACKAGE_MANAGERS.has(normalizeExecutable(inner[0]))) {
      return classifyWords(inner)
    }
  }
  return null
}

function kubectlClassification(args) {
  const index = skipOptions(args, 0, KUBECTL_VALUE_OPTIONS)
  const subcommand = String(args[index] || "").toLowerCase()
  return ["delete", "apply"].includes(subcommand) ? "deployment" : null
}

function terraformClassification(args) {
  let index = 0
  const words = [...args]
  while (index < words.length) {
    const token = String(words[index] || "")
    if (!token.startsWith("-")) break
    const equals = token.indexOf("=")
    const key = equals >= 0 ? token.slice(0, equals) : token
    if (equals < 0 && TERRAFORM_VALUE_OPTIONS.has(key)) index += 2
    else index += 1
  }
  const subcommand = String(words[index] || "").toLowerCase()
  return ["apply", "destroy"].includes(subcommand) ? "deployment" : null
}

function helmClassification(args) {
  const index = skipOptions(args, 0, HELM_VALUE_OPTIONS)
  const subcommand = String(args[index] || "").toLowerCase()
  return ["install", "upgrade", "uninstall"].includes(subcommand) ? "deployment" : null
}

function destructiveFileClassification(name, args) {
  const words = args.map((value) => String(value || ""))
  const lower = words.map((value) => value.toLowerCase())
  const joined = lower.join(" ")
  if (name === "rmdir" || name === "rd" || name === "del" || name === "erase") {
    const recursive = lower.some((value) => value === "/s" || value === "--recursive")
    return recursive ? "destructive-files" : null
  }

  // PowerShell long-form flags (also accepted by the rm/del aliases there).
  const powershellRecursive = lower.includes("-recurse") || lower.includes("--recurse")
  const powershellForce = lower.includes("-force") || lower.includes("--force")
  if (name === "remove-item" || name === "ri") {
    return powershellRecursive && powershellForce ? "destructive-files" : null
  }

  let recursive = powershellRecursive
  let force = powershellForce
  for (const value of words) {
    if (!value.startsWith("-") || value === "-") continue
    if (value.startsWith("--")) {
      if (value === "--recursive") recursive = true
      if (value === "--force") force = true
      continue
    }
    const cluster = value.slice(1).toLowerCase()
    if (/[r]/.test(cluster)) recursive = true
    if (/f/.test(cluster)) force = true
  }
  // `rm -r -f`, `rm -rf`, `rm --recursive --force`, `rm -Rf` all mean the same
  // destructive operation. A lone -r or -f keeps the historical conservative
  // behaviour and is not escalated here.
  if (recursive && force) return "destructive-files"
  // `rm -Recurse -Force` parses as PowerShell long flags above.
  if (name === "rm" && joined.includes("-recurse") && joined.includes("-force")) return "destructive-files"
  return null
}

const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"])

function sqlClassification(segment, words = []) {
  const pattern = /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i
  if (!pattern.test(segment)) return null
  const cleaned = stripShellPrefixes(words)
  const name = normalizeExecutable(cleaned[0] || "")
  // A SQL client can receive the statement as an argument (`psql -c "..."`).
  if (SQL_CLIENTS.has(name)) return "database-drop"
  // Or the segment can BE the statement (`DROP TABLE users`). Do not flag an
  // echo/grep/documentation string that merely mentions the words.
  const first = normalizeExecutable(cleaned[0] || "")
  const second = normalizeExecutable(cleaned[1] || "")
  if (first === "drop" && ["database", "schema", "table"].includes(second)) return "database-drop"
  if (first === "truncate" && second === "table") return "database-drop"
  return null
}

function classifyWords(words) {
  const cleaned = stripShellPrefixes(words)
  if (!cleaned.length) return null
  const name = normalizeExecutable(cleaned[0])
  const args = cleaned.slice(1)
  if (name === "git") return gitClassification(args)
  if (PACKAGE_MANAGERS.has(name)) return packageManagerClassification(name, args)
  if (name === "kubectl") return kubectlClassification(args)
  if (name === "terraform") return terraformClassification(args)
  if (name === "helm") return helmClassification(args)
  if (DESTRUCTIVE_FILE_TOOLS.has(name)) return destructiveFileClassification(name, args)
  return null
}

/**
 * Unwrap one command layer. Returns either a nested shell string (wrappers whose
 * argument is itself a command string) or the executable words left to classify.
 */
function unwrapCommand(words) {
  let current = stripShellPrefixes(words)
  let guard = 0
  while (current.length && guard < 16) {
    guard += 1
    const name = normalizeExecutable(current[0])
    const rest = current.slice(1)
    const join = (index) => rest.slice(index).join(" ")

    if (name === "env") {
      let index = skipOptions(rest, 0, ENV_VALUE_OPTIONS)
      // `env -S "cmd args"` splits the string and runs the first word.
      const splitIndex = rest.findIndex((token) => token === "-S" || token === "--split-string")
      if (splitIndex >= 0 && rest[splitIndex + 1] !== undefined) {
        return { nested: join(splitIndex + 1) }
      }
      while (index < rest.length && isAssignment(rest[index])) index += 1
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "sudo" || name === "doas") {
      const index = skipOptions(rest, 0, SUDO_VALUE_OPTIONS)
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "timeout") {
      const index = skipOptions(rest, 0, TIMEOUT_VALUE_OPTIONS)
      // First positional is the duration.
      current = stripShellPrefixes(rest.slice(Math.min(index + 1, rest.length)))
      continue
    }
    if (name === "nice") {
      const index = skipOptions(rest, 0, NICE_VALUE_OPTIONS)
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "nohup" || name === "setsid" || name === "command" || name === "builtin" || name === "exec") {
      if (name === "command" && rest.some((token) => token === "-v" || token === "-V")) return { nested: null, words: [] }
      const index = skipOptions(rest, 0, name === "exec" ? EXEC_VALUE_OPTIONS : new Set())
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "xargs") {
      const index = skipOptions(rest, 0, XARGS_VALUE_OPTIONS)
      if (index >= rest.length) return { nested: null, words: [] }
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "eval") return { nested: join(0) }
    if (name === "busybox") {
      current = stripShellPrefixes(rest.filter((token, index) => index > 0 || token !== "--"))
      continue
    }
    if (name === "npx" || name === "pnpx" || name === "bunx") {
      const index = skipOptions(rest, 0, NPX_VALUE_OPTIONS)
      if (rest.some((token) => token === "-c" || token === "--call")) {
        const callIndex = rest.findIndex((token) => token === "-c" || token === "--call")
        return { nested: join(callIndex + 1) }
      }
      current = stripShellPrefixes(rest.slice(index))
      continue
    }
    if (name === "start") {
      const known = rest.findIndex((token) => {
        const candidate = normalizeExecutable(token)
        return candidate === "cmd" || POWERSHELLS.has(candidate) || POSIX_SHELLS.has(candidate) || candidate === "git"
      })
      current = known >= 0 ? rest.slice(known) : stripShellPrefixes(rest)
      continue
    }
    if (name === "cmd") {
      const index = rest.findIndex((token) => /^\/(?:c|k)$/i.test(String(token)))
      if (index < 0) return { nested: null, words: current }
      return { nested: join(index + 1) }
    }
    if (POWERSHELLS.has(name)) {
      const encoded = rest.findIndex((token) => /^-(?:encodedcommand|enc)$/i.test(String(token)))
      if (encoded >= 0) {
        const decoded = decodePowerShell(rest[encoded + 1])
        return decoded === null
          ? { nested: null, words: [], finding: "obfuscated-shell" }
          : { nested: decoded }
      }
      const commandIndex = rest.findIndex((token) =>
        /^-(?:command|commandwithargs|c)$/i.test(String(token)))
      if (commandIndex < 0) return { nested: null, words: current }
      return { nested: join(commandIndex + 1) }
    }
    if (POSIX_SHELLS.has(name)) {
      const commandIndex = rest.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(String(token)))
      if (commandIndex < 0) return { nested: null, words: current }
      return { nested: join(commandIndex + 1) }
    }
    return { nested: null, words: current }
  }
  return { nested: null, words: [] }
}

function analyzeText(text, context, findings, depth, seen) {
  const raw = String(text || "")
  if (!raw.trim()) return
  if (depth > MAX_NESTING) {
    pushFinding(findings, "obfuscated-shell", { ...context, segment: raw }, { reason: "nesting-limit" })
    return
  }
  const key = `${context.segmentIndex}:${raw}`
  if (seen.has(key)) return
  seen.add(key)

  for (const segment of shellCommandSegments(raw)) {
    const words = shellWords(segment.text).filter((word) => word !== "")
    const localContext = {
      segmentIndex: context.segmentIndex,
      segment: context.segment,
      operator: context.operator,
    }
    if (words.length) {
      const unwrapped = unwrapCommand(words)
      if (unwrapped.finding) {
        pushFinding(findings, unwrapped.finding, localContext, { depth })
        continue
      }
      if (unwrapped.nested !== null) {
        analyzeText(unwrapped.nested, localContext, findings, depth + 1, seen)
        continue
      }
      const direct = classifyWords(unwrapped.words) || sqlClassification(segment.text, unwrapped.words)
      if (direct) pushFinding(findings, direct, localContext, { depth })
    } else if (sqlClassification(segment.text, [])) {
      pushFinding(findings, "database-drop", localContext, { depth })
    }

    // Even when the outer command is benign, a substitution runs a command.
    for (const substitution of nestedSubstitutions(segment.text)) {
      analyzeText(substitution, localContext, findings, depth + 1, seen)
    }
  }
}

/**
 * Full analysis. Findings are ordered by the segment in which they occur and,
 * within a segment, by the declared rule order.
 */
export function destructiveShellAnalysis(command) {
  const value = String(command || "")
  const segments = shellCommandSegments(value)
  const findings = []
  const seen = new Set()
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    analyzeText(segment.text, {
      segmentIndex: index,
      segment: segment.text,
      operator: segment.operator,
    }, findings, 0, seen)
  }
  // A top-level operator into a shell interpreter with no inspectable script is
  // not itself dangerous. Everything else is covered by the scan above; no
  // whole-command substring fallback is used because it cannot tell a command
  // from an argument (e.g. `grep "git reset --hard" docs`).
  return {
    risky: findings.length > 0,
    id: findings[0]?.id || null,
    findings,
    segmentCount: segments.length,
  }
}

export function destructiveShellRisk(command) {
  const analysis = destructiveShellAnalysis(command)
  return {
    risky: analysis.risky,
    id: analysis.id,
    segmentIndex: analysis.findings[0]?.segmentIndex ?? null,
    segment: analysis.findings[0]?.segment || null,
  }
}

export const SHELL_SAFETY_POLICY = "shell-safety-v16-18"
export const SHELL_SAFETY_RULES = SAFETY_RULES
