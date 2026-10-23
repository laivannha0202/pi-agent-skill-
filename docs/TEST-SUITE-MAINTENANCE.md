# UES test-suite maintenance — baseline and safe consolidation

## Grounded baseline

- Baseline commit: `ef8a523d67a196a8ff0cc5cac6d049c89f2d4369` (main).
- Most recent user-run full suite: **296/296 test files passing**, duration **142,296 ms**, on Windows; these are *file counts*, not individual test-case counts.
- GitHub tree inventory: **296 `.test.mjs` files**, **2,702,705 bytes**, **236 version-named files**.
- **Zero byte-for-byte duplicate test files** based on Git blob SHA. This does NOT prove no overlapping assertions.
- Full-suite runner `scripts/run-test-suite.mjs` already supports explicit positional file selections and a bounded concurrency of 4 on Windows.

## Commands

- `npm run test:inventory` — static inventory and candidates for manual review, read-only.
- `npm run test:inventory -- --json` — machine-readable inventory. Use redirection if you want to save a report.
- `npm run test:smoke` — a small, explicitly curated smoke set. **Not a release gate.**
- `npm run test:verification` — focused verification/receipt/decision regression set. **Not a release gate.**
- `npm test` — unchanged full suite, required for broad regression and release confidence.

## Policy for future changes

1. Prefer adding a regression case to an existing subsystem test file instead of introducing a new version-named file.
2. Group by responsibility rather than by release number. Treat candidate families and repeated test titles as **leads**, never permission to delete assertions.
3. Before merging two suites, compare every test's assertions, negative cases, setup, cleanup, process isolation, and failure mode. Some similar tests deliberately guard different historical regressions.
4. Review scripts in `package.json`, documents and other test manifests for references before renaming a file.
5. Preserve Windows-safe bounded runs, independent test cases, and negative-case security coverage. Don't increase concurrency simply to make numbers look better.
6. Run focused tests during development, then **full `npm test` after any consolidation**. Capture pass/fail counts, total duration and test-case counts where available, plus exact files moved/deleted and coverage rationale.
7. No benchmark or measured speed-up claim until the changed suite completes on the user's machine. Optimizing file count does not guarantee lower elapsed time.

This first phase adds inventory and focused commands **without deleting or renaming tests**, preserving the 296-file baseline for safe comparisons.
