# AGENTS.md

Repository: `laivannha0202/pi-agent-skill-` (UES V16.18.0).

## No GitHub Actions policy (permanent)

GitHub Actions is intentionally disabled in this repository by explicit owner decision.

- GitHub Actions is OFF. This is not a bug, missing feature, or something to restore.
- Do NOT re-enable, invoke, or configure GitHub Actions in any way.
- Do NOT create, restore, modify, or delete files under `.github/workflows/**`, including workflows with new names.
- Do NOT propose or implement a solution that requires GitHub Actions to run.
- Do NOT call GitHub API/CLI to change Actions or workflows.
- All verification, security audit, release checks, and smoke tests must run LOCAL (see `npm run integrity`, `npm run syntax`, `npm run typecheck:pi`, `npm test`, `npm run smoke:pi`, `npm run ci`).
- Build, test, pack, and npm publish are manual local processes (see `docs/NPM-PUBLISH.md`).
- Only an explicit, unambiguous owner request may reconsider this policy.

See also `global-config/AGENTS.md` for the full UES agent policy.
