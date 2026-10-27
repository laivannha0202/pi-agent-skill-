# GitHub Ruleset Readiness

GitHub Actions is intentionally disabled in this repository by owner decision. There are no CI Gate or Security Gate workflows and none must be created or restored. Verification is performed locally.

## No GitHub Actions

- Do not add or restore `.github/workflows/**`.
- Do not configure required status checks that depend on GitHub Actions.
- All build, test, pack, security audit, and release checks run locally (see `npm run ci` and `docs/NPM-PUBLISH.md`).

## Recommended ruleset

- **Ruleset name:** `main-protection`
- **Target:** default branch / `main`
- **Enforcement:** Active

## Rules

1. **Restrict deletions** — block deleting the default branch or force-pushing over it.
2. **Block force pushes** — no `git push --force` or `git push -f` to `main`.
3. **Require pull request before merge** — all changes must go through a PR.
4. **Require conversation resolution** — PR reviewers must resolve all inline comments before merge.
5. **Require branch up to date** — PR branches must be up to date with `main` before merge (applies when there are multiple contributors; can be relaxed for single-maintainer setups).

Status checks are not required because GitHub Actions is disabled. If external checks are ever added by the owner, they must be local/manual and documented separately.

## Approval policy for single-maintainer repo

This repository currently has one maintainer. Setting `required approval = 1` would prevent the owner from merging their own PRs (they cannot approve their own PR). Therefore:

- **Required approval = 0** for now.
- When a collaborator or external reviewer is added, raise to `required approval = 1` to restore oversight.

## Classic branch protection vs ruleset

GitHub supports both classic branch protection rules and repository rulesets simultaneously. When both are configured:

- They can apply independently to different aspects of branch protection.
- Be cautious of duplicate or conflicting protections.
- If migrating from classic protection to ruleset, remove the classic rule after confirming the ruleset is active and working.

## Manual release process

Releases are manual and local:

1. Run `npm run integrity`.
2. Run `npm run syntax`.
3. Run `npm run typecheck:pi`.
4. Run `npm test`.
5. Run `npm run smoke:pi`.
6. Run `npm pack --dry-run` and review package contents.
7. Publish with `npm publish` only when explicitly intended.

No GitHub Actions, automated release, or CI gate is used.

## Current status

- **GitHub Actions:** Intentionally disabled.
- **Ruleset:** Configure via GitHub admin settings as needed; do not depend on Actions-based status checks.
