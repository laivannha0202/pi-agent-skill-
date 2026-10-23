# Publishing to npm

The public package name is:

```text
opencode-agent-skill
```

The authoritative release version is the `version` field in `package.json`:

```cmd
node -p "require('./package.json').version"
```

This document deliberately does **not** hardcode that version. Every command below uses the
`<version>` placeholder; substitute the value printed by the command above. `package-lock.json`
and `CHANGELOG.md` must agree with it before publishing.

## Release prerequisites

1. The npm account must have publish rights to the unscoped `opencode-agent-skill` package.
2. `package.json`, `package-lock.json` and the latest `CHANGELOG.md` release version must match.
3. Local validation must pass from the exact release commit:

```cmd
npm run ci
```

The release gate includes source-integrity validation, runtime import/export validation, syntax
checks, the full Node test suite, release consistency, package dry-run, Pi smoke tests,
package-closure validation and packed-install smoke.

## Stable local release

GitHub Actions is intentionally disabled in this repository, so a release is manual and local.
Do not re-create CI, security or publish workflows for a release.

Authenticate interactively on the release machine:

```cmd
npm login
npm whoami
```

Confirm the exact version is not already published:

```cmd
npm view opencode-agent-skill@<version> version --registry=https://registry.npmjs.org/
```

Run the complete gate and inspect the package:

```cmd
npm run ci
npm pack
```

Test the exact tarball with Pi:

```cmd
pi install .\opencode-agent-skill-<version>.tgz
pi list
```

Publish stable to the default `latest` dist-tag:

```cmd
npm publish --access public
```

For manual/local publishing, do not add `--provenance`. npm provenance is intended for supported
cloud CI/OIDC publishing. If trusted publishing is configured later, provenance can be generated
automatically by the supported CI provider.

Verify the registry after publication:

```cmd
npm view opencode-agent-skill@<version> version
npm view opencode-agent-skill dist-tags
npm view opencode-agent-skill@latest version
```

Expected stable result:

```text
latest: <version>
```

## Git tag

After the npm publication succeeds, create the matching immutable release tag from the same tested
commit:

```cmd
npm run release:check-tag -- v<version>
git tag -a v<version> -m "UES <version>"
git push origin v<version>
```

Never move an existing release tag and never use force push for a release.

## Public install

Pi package install (official syntax):

```cmd
npm install -g @earendil-works/pi-coding-agent
pi install npm:opencode-agent-skill
pi
```

Optional global CLI:

```cmd
npm install -g opencode-agent-skill@latest
ues version
```

Update an existing npm-based Pi install:

```cmd
pi update
```

## Release checklist

1. `git status` is clean.
2. `git pull --ff-only origin main`.
3. `npm run ci` passes.
4. `npm pack` succeeds and the tarball contains the required Pi/runtime files.
5. Exact packed install works.
6. `npm whoami` resolves the authorized publisher.
7. Exact target version is not already present.
8. `npm publish --access public` succeeds.
9. Registry reports `latest: <version>`.
10. Create and push `v<version>` from the same commit.
11. Test `pi install npm:opencode-agent-skill` in a clean environment before announcing the release.
