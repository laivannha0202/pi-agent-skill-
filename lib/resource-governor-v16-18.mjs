// ---------------------------------------------------------------------------
// V16.18 GLOBAL RESOURCE GOVERNOR.
//
// WHY THIS EXISTS
//
// Before this release every concurrency-bearing subsystem resolved its own local
// maximum independently: the test runner, the RPC worker pool, the subagent
// fleet, the LSP pool, the semantic index, the writer lane, the browser lane and
// the service manager could all reach their own ceiling at the same moment. On a
// Windows host that is textbook oversubscription: each owner believes it is
// within budget while the machine is not.
//
// WHAT THIS IS NOT
//
// This is NOT a scheduler and it does NOT replace any subsystem owner. It does
// not run work, reorder queues, or decide what should happen. It is a LEASE
// COORDINATOR that answers one question for existing owners: "may I start ONE
// more unit of class X right now, given everything else that is running?".
//
// LAWS
//
//   1. A LEASE IS NEVER WRITTEN WITHOUT A CLASS. `withLease()` requires an
//      explicit class; an unknown class is refused rather than assumed cheap.
//   2. GLOBAL CAPS RESOLVE NESTING. A unit held by a parent never lets a child
//      exceed the class ceiling, because the ceiling is GLOBAL, not per-owner.
//      Nested oversubscription is therefore structurally impossible.
//   3. RE-ENTRANCY IS DEPTH, NOT WIDTH. The same logical task may nest leases of
//      the same class (a verifier inside a run) and consumes ONE unit, not two.
//      Re-entry is only granted when the caller presents the LIVE PARENT HANDLE
//      returned by this governor: a matching `taskId` alone is not proof of
//      ownership, because two unrelated callers may reuse a string. That is
//      what keeps the governor deadlock-free without opening a width bypass: no
//      task can deadlock against itself, and unrelated tasks queue FIFO and are
//      woken on release.
//   4. EVERY EXIT RELEASES. Success, throw, abort and timeout all release, and a
//      release is idempotent so a double release can never free someone else's
//      unit. A throw releases the unit BEFORE the error leaves the governor.
//   5. NOTHING IS RAISED BY THE GOVERNOR. It can only NARROW. Existing
//      per-subsystem limits stand; this module adds a shared ceiling, and each
//      owner keeps choosing its own local limit (respecting current Windows
//      evidence). Nobody may exceed these caps by asking.
//   6. METRICS ARE TRUTHFUL. `state()` reports counted live/waiting/peak/refused/
//      timeout/abort values, never a guess. `live` is UNITS, not lease records:
//      a lease that asks for two units occupies two units of the ceiling.
// ---------------------------------------------------------------------------

export const RESOURCE_CLASS = Object.freeze({
  CPU_HEAVY: "CPU_HEAVY",
  IO_HEAVY: "IO_HEAVY",
  MODEL_CHILD: "MODEL_CHILD",
  WRITER: "WRITER",
  LSP: "LSP",
  BROWSER: "BROWSER",
  SERVICE: "SERVICE",
})

export const RESOURCE_GOVERNOR_POLICY = "global-resource-governor-v16-18"
export const RESOURCE_GOVERNOR_SCHEMA_VERSION = 1

/**
 * Conservative global ceilings. They are CEILINGS: an owner may set a lower
 * local limit and the governor honours it, but no owner may exceed these. The
 * numbers deliberately match the current conservative Windows evidence (a small
 * child fleet, a single writer lane, a handful of heavy streams) and are never
 * raised by this module.
 */
export const RESOURCE_GOVERNOR_CAPS = Object.freeze({
  [RESOURCE_CLASS.CPU_HEAVY]: 3,
  [RESOURCE_CLASS.IO_HEAVY]: 6,
  [RESOURCE_CLASS.MODEL_CHILD]: 3,
  [RESOURCE_CLASS.WRITER]: 1,
  [RESOURCE_CLASS.LSP]: 2,
  [RESOURCE_CLASS.BROWSER]: 1,
  [RESOURCE_CLASS.SERVICE]: 2,
})

/** Classes the governor can govern. */
export const RESOURCE_GOVERNOR_CLASSES = Object.freeze(Object.keys(RESOURCE_GOVERNOR_CAPS))

/**
 * A monotonic clock. Wall-clock `Date.now()` can jump backwards (NTP, manual
 * clock changes) and would turn a wait into a negative duration or a timeout
 * into a late admission. `performance.now()` is monotonic within the process.
 */
const now = (() => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return () => performance.now()
  }
  return () => Date.now()
})()

const MAX_TIMER_MS = 2_147_483_647

function normalizePositiveMs(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${label} must be a finite positive number of milliseconds`)
  }
  return Math.min(number, MAX_TIMER_MS)
}

function normalizeCap(value, cls) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(`resource cap for ${cls} must be an integer >= 1`)
  }
  return number
}

/**
 * Validate an acquisition's units request. Returns an integer >= 1 or null for
 * anything that is not a whole number of units. Booleans are rejected instead
 * of being coerced to 1 by `Number(true)`: a malformed caller must not silently
 * consume a unit.
 */
function normalizeUnits(value) {
  if (value === undefined) return 1
  if (typeof value === "boolean" || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return null
  return number
}

/**
 * Create a governor. Pure in-process state, no timers kept alive, no process
 * handles: an abandoned governor is garbage-collected with its waiters.
 *
 * Handles are per-acquisition objects. The internal lease record is never
 * exposed: two nested acquisitions of the same lease receive two DISTINCT
 * handles, so releasing one handle twice can never decrement depth twice and
 * free capacity that another acquisition still owns.
 */
export function createResourceGovernor(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("resource governor options must be an object")
  }
  const rawCaps = options.caps === undefined || options.caps === null ? {} : options.caps
  if (typeof rawCaps !== "object" || Array.isArray(rawCaps)) {
    throw new TypeError("resource governor caps must be an object")
  }
  const caps = { ...RESOURCE_GOVERNOR_CAPS }
  for (const [rawClass, rawCap] of Object.entries(rawCaps)) {
    const cls = String(rawClass || "").toUpperCase()
    if (!Object.hasOwn(caps, cls)) {
      throw new RangeError(`unknown resource class in caps override: ${rawClass}`)
    }
    caps[cls] = normalizeCap(rawCap, cls)
  }
  const defaultTimeoutMs = normalizePositiveMs(options.defaultTimeoutMs, 30_000, "defaultTimeoutMs")
  const pollIntervalMs = normalizePositiveMs(options.pollIntervalMs, 5, "pollIntervalMs")

  /** cls -> Map<leaseId, leaseRecord> */
  const held = new Map()
  /** cls -> Set<waiter> */
  const waiters = new Map()
  /** cls -> peak LIVE UNITS */
  const peak = new Map()
  for (const cls of Object.keys(caps)) {
    held.set(cls, new Map())
    waiters.set(cls, new Set())
    peak.set(cls, 0)
  }

  // Per-governor symbol: a handle minted by another governor (or a forged plain
  // object) cannot be used to claim re-entrancy here.
  const leaseRef = Symbol("resource-governor.lease")

  let leaseSeq = 0
  let handleSeq = 0
  let anonymousSeq = 0
  let admitted = 0
  let reentries = 0
  let refused = 0
  let timedOut = 0
  let aborted = 0
  let waitMsTotal = 0
  let peakWaiters = 0
  let unitsAdmitted = 0

  function liveUnits(cls) {
    let total = 0
    for (const lease of held.get(cls)?.values() || []) total += lease.units
    return total
  }

  function makeHandle(lease, inherited) {
    handleSeq += 1
    const handle = {
      id: `acquire-${lease.cls}-${handleSeq}`,
      leaseId: lease.id,
      cls: lease.cls,
      taskId: lease.taskId,
      units: inherited ? 0 : lease.units,
      inherited,
      depth: lease.depth,
      acquiredAt: now(),
      wantedAt: lease.wantedAt,
      waitedMs: 0,
      meta: lease.meta,
      released: false,
    }
    Object.defineProperty(handle, leaseRef, { value: lease, enumerable: false })
    lease.handles.add(handle)
    return handle
  }

  function makeLease(cls, taskId, units, meta, wantedAt) {
    leaseSeq += 1
    return {
      id: `lease-${cls}-${leaseSeq}`,
      cls,
      taskId,
      units,
      depth: 0,
      wantedAt,
      acquiredAt: 0,
      meta: meta && typeof meta === "object" ? meta : {},
      handles: new Set(),
      released: false,
    }
  }

  function usableParent(handle, cls) {
    if (!handle || typeof handle !== "object") return null
    const lease = handle[leaseRef]
    if (!lease) return null
    if (handle.released === true || lease.released === true) return null
    if (lease.cls !== cls) return null
    const ledger = held.get(cls)
    if (!ledger || ledger.get(lease.id) !== lease) return null
    if (lease.depth < 1) return null
    return lease
  }

  /**
   * Attempt an immediate admission. Returns `{ ok:true, lease }` or
   * `{ ok:false, reason }`; it never waits.
   */
  function tryAcquire(cls, taskId, units, meta, parentHandle, wantedAt) {
    const ledger = held.get(cls)
    if (!ledger) return { ok: false, reason: "unknown-class" }

    if (parentHandle !== null && parentHandle !== undefined) {
      const parent = usableParent(parentHandle, cls)
      if (!parent) return { ok: false, reason: "invalid-parent" }
      if (taskId !== null && taskId !== parent.taskId) {
        return { ok: false, reason: "parent-task-mismatch" }
      }
      parent.depth += 1
      parent.acquiredAt = parent.acquiredAt || now()
      const handle = makeHandle(parent, true)
      handle.waitedMs = Math.max(0, now() - wantedAt)
      reentries += 1
      admitted += 1
      return { ok: true, lease: handle }
    }

    if (units > caps[cls]) return { ok: false, reason: "units-exceed-cap" }
    if (liveUnits(cls) + units > caps[cls]) return { ok: false, reason: "at-cap" }

    const lease = makeLease(cls, taskId, units, meta, wantedAt)
    lease.depth = 1
    lease.acquiredAt = now()
    ledger.set(lease.id, lease)
    const handle = makeHandle(lease, false)
    handle.waitedMs = Math.max(0, lease.acquiredAt - wantedAt)
    admitted += 1
    unitsAdmitted += units
    peak.set(cls, Math.max(peak.get(cls) || 0, liveUnits(cls)))
    return { ok: true, lease: handle }
  }

  function wakeAll(cls) {
    const queue = waiters.get(cls)
    if (!queue || queue.size === 0) return
    // Wake every waiter, not just the head. A released unit may be large enough
    // for a later waiter while the head still needs more units; waking only one
    // could park capacity behind a waiter that cannot use it.
    for (const waiter of [...queue]) waiter.resolve()
  }

  function release(handle) {
    if (!handle || typeof handle !== "object") return false
    const lease = handle[leaseRef]
    if (!lease) return false
    if (handle.released === true) return false
    const ledger = held.get(lease.cls)
    if (!ledger || ledger.get(lease.id) !== lease) return false
    handle.released = true
    handle.depth = lease.depth
    lease.depth -= 1
    if (lease.depth > 0) return true
    ledger.delete(lease.id)
    lease.released = true
    wakeAll(lease.cls)
    return true
  }

  function waitForWake(cls, ms, signal) {
    return new Promise((resolve) => {
      const queue = waiters.get(cls)
      let settled = false
      let timer = null
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (signal) signal.removeEventListener("abort", finish)
        queue?.delete(waiter)
        resolve()
      }
      const waiter = { resolve: finish }
      queue?.add(waiter)
      peakWaiters = Math.max(peakWaiters, queue?.size || 0)
      timer = setTimeout(finish, Math.max(1, ms))
      if (signal) {
        signal.addEventListener("abort", finish, { once: true })
        // The signal may have aborted between the caller's pre-check and the
        // listener registration; do not park a waiter that can never be woken.
        if (signal.aborted) finish()
      }
    })
  }

  function normalizeTaskId(value) {
    if (value === undefined || value === null) {
      anonymousSeq += 1
      return `anonymous:${anonymousSeq}`
    }
    const text = String(value).trim()
    if (text) return text
    anonymousSeq += 1
    return `anonymous:${anonymousSeq}`
  }

  async function acquireInternal(cls, rawInput = {}) {
    const input = rawInput && typeof rawInput === "object" ? rawInput : {}
    const started = now()
    let accounted = false
    const finish = (outcome) => {
      // A refusal is still a wait. Reporting 0 for a 30s timeout would make the
      // metrics lie about exactly the case operators need to diagnose, so the
      // measured duration travels on EVERY outcome, not only on admission.
      const waitedMs = Math.max(0, now() - started)
      if (!accounted) {
        accounted = true
        waitMsTotal += waitedMs
      }
      return { ...outcome, waitedMs }
    }

    const klass = String(cls || "").toUpperCase()
    if (!held.has(klass)) {
      refused += 1
      return finish({ lease: null, reason: "unknown-class" })
    }

    const units = normalizeUnits(input.units)
    if (units === null) {
      refused += 1
      return finish({ lease: null, reason: "invalid-units" })
    }

    const signal = input.signal
      && typeof input.signal === "object"
      && typeof input.signal.aborted === "boolean"
      && typeof input.signal.addEventListener === "function"
      && typeof input.signal.removeEventListener === "function"
      ? input.signal
      : null
    if (signal?.aborted) {
      aborted += 1
      return finish({ lease: null, reason: "aborted" })
    }

    const rawParent = input.parentLease ?? input.parent ?? null
    let taskId = null
    if (rawParent !== null && rawParent !== undefined) {
      const parent = usableParent(rawParent, klass)
      if (!parent) {
        refused += 1
        return finish({ lease: null, reason: "invalid-parent" })
      }
      const requested = input.taskId === undefined || input.taskId === null
        ? null
        : String(input.taskId).trim()
      if (requested && requested !== parent.taskId) {
        refused += 1
        return finish({ lease: null, reason: "parent-task-mismatch" })
      }
      taskId = parent.taskId
    } else {
      taskId = normalizeTaskId(input.taskId)
    }

    const requestedTimeout = Number(input.timeoutMs)
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_TIMER_MS)
      : defaultTimeoutMs
    const deadline = started + timeoutMs

    // First attempt is immediate: a caller with a tiny timeout still gets the
    // chance to take free capacity without waiting for one poll interval. The
    // deadline is still checked first so even the first admission can never be
    // a LATE admission.
    if (now() >= deadline) {
      timedOut += 1
      return finish({ lease: null, reason: "timeout" })
    }
    let attempt = tryAcquire(klass, taskId, units, input.meta, rawParent, started)
    while (!attempt.ok) {
      if (attempt.reason !== "at-cap") {
        refused += 1
        return finish({ lease: null, reason: attempt.reason })
      }
      if (signal?.aborted) {
        aborted += 1
        return finish({ lease: null, reason: "aborted" })
      }
      const remaining = deadline - now()
      if (remaining <= 0) {
        timedOut += 1
        return finish({ lease: null, reason: "timeout" })
      }
      await waitForWake(klass, Math.min(pollIntervalMs, remaining), signal)
      // Re-check BOTH terminal conditions BEFORE retrying. Otherwise a waiter
      // woken at the deadline could slip in a late admission after its timeout.
      if (signal?.aborted) {
        aborted += 1
        return finish({ lease: null, reason: "aborted" })
      }
      if (now() >= deadline) {
        timedOut += 1
        return finish({ lease: null, reason: "timeout" })
      }
      attempt = tryAcquire(klass, taskId, units, input.meta, rawParent, started)
    }
    return finish({ lease: attempt.lease, reason: null })
  }

  return {
    schemaVersion: RESOURCE_GOVERNOR_SCHEMA_VERSION,
    policy: RESOURCE_GOVERNOR_POLICY,
    caps: { ...caps },

    /** Current live UNIT count for a class (not lease-record count). */
    live(cls) {
      return liveUnits(String(cls || "").toUpperCase())
    },

    /** Number of live lease records for a class (nesting is one record). */
    leaseCount(cls) {
      return held.get(String(cls || "").toUpperCase())?.size || 0
    },

    /** Remaining UNIT headroom for a class. */
    headroom(cls) {
      const klass = String(cls || "").toUpperCase()
      if (!held.has(klass)) return 0
      return Math.max(0, caps[klass] - liveUnits(klass))
    },

    /** Whether a lease of this class/units could be granted without waiting. */
    canAdmit(cls, units = 1) {
      const klass = String(cls || "").toUpperCase()
      if (!held.has(klass)) return false
      const want = normalizeUnits(units)
      if (want === null || want > caps[klass]) return false
      return liveUnits(klass) + want <= caps[klass]
    },

    /**
     * Acquire a lease and await it. Resolves null on timeout/abort/unknown
     * class/invalid request. Re-entrancy requires `parentLease` (or `parent`)
     * to be a live handle from THIS governor; a matching `taskId` alone is
     * treated as an independent acquisition and consumes its own units.
     */
    async acquire(cls, input = {}) {
      const outcome = await acquireInternal(cls, input)
      return outcome.lease
    },

    /** Release one acquisition handle. Idempotent; stale handles are refused. */
    release(handle) {
      return release(handle)
    },

    /**
     * Run `fn` under a lease of `cls`. Every exit path releases; a throw releases
     * BEFORE the error leaves the governor. When no lease can be granted the
     * work never runs and `{ ok:false }` is returned, so nothing executes out of
     * budget. What a refusal MEANS (fail open, queue, or stop) stays the caller's
     * decision, exactly as the rest of the runtime does with a missing provider.
     */
    async withLease(cls, fn, input = {}) {
      const outcome = await acquireInternal(cls, input)
      const lease = outcome.lease
      if (!lease) {
        const klass = String(cls || "").toUpperCase()
        return {
          ok: false,
          cls: klass,
          reason: outcome.reason || (held.has(klass) ? "timeout" : "unknown-class"),
          waitedMs: Math.max(0, outcome.waitedMs || 0),
        }
      }
      try {
        const result = await fn(lease)
        return {
          ok: true,
          cls: lease.cls,
          lease: lease.id,
          leaseId: lease.leaseId,
          waitedMs: Math.max(0, lease.waitedMs),
          result,
        }
      } finally {
        release(lease)
      }
    },

    /** Truthful, counted metrics. Nothing here is estimated. */
    state() {
      const rows = {}
      let leaseCount = 0
      let units = 0
      for (const cls of Object.keys(caps)) {
        const live = liveUnits(cls)
        const records = held.get(cls)?.size || 0
        leaseCount += records
        units += live
        rows[cls] = {
          cap: caps[cls],
          live,
          units: live,
          leases: records,
          waiting: waiters.get(cls)?.size || 0,
          peak: peak.get(cls) || 0,
          headroom: Math.max(0, caps[cls] - live),
        }
      }
      return {
        schemaVersion: RESOURCE_GOVERNOR_SCHEMA_VERSION,
        policy: RESOURCE_GOVERNOR_POLICY,
        classes: rows,
        admitted,
        reentries,
        refused,
        timedOut,
        aborted,
        peakWaiters,
        waitMsTotal: Math.max(0, waitMsTotal),
        unitsAdmitted,
        leases: leaseCount,
        units,
      }
    },
  }
}

export const RESOURCE_GOVERNOR_EXPORTS = Object.freeze([
  "RESOURCE_CLASS",
  "RESOURCE_GOVERNOR_POLICY",
  "RESOURCE_GOVERNOR_SCHEMA_VERSION",
  "RESOURCE_GOVERNOR_CAPS",
  "RESOURCE_GOVERNOR_CLASSES",
  "createResourceGovernor",
])
