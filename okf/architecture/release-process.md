---
type: Architecture
title: Release Process
description: How kunj is built, tested in CI, versioned at runtime and released by tag to npm and GitHub (with the VS Code extension and the two macOS apps as assets), plus the GitHub Pages deploy.
resource: .github/workflows/release.yml
tags: [architecture, release, ci, github-actions, npm, versioning]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Releases are tag-driven. Pushing a tag `vX.Y.Z` (or running the Release workflow by hand with a
version) builds and tests the CLI, publishes it to npm, packages the VS Code extension and creates a
GitHub release; two macOS jobs then attach the menu bar app and the workspace app. The version in
`package.json` on `main` stays `1.0.0`: the workflow rewrites it during the release, which is why the
CLI reads its version at runtime.

# Build

| Script (`package.json`) | Does |
|-------------------------|------|
| `build` | `tsc && node scripts/copy-container-assets.js` (copies `src/container` to `dist/container`, chmods `*.sh`, `git-credential-kunj`, `kunj-dind-start` to 0755) |
| `dev` | `ts-node src/index.ts` |
| `lint` | `tsc --noEmit && tsc -p test/functional --noEmit` |
| `test`, `test:docker`, `test:functional` | See [Testing](/architecture/testing.md) |
| `bundle` | esbuild single-file bundle to `.build/bundle.js` (node20, cjs) |
| `compile` | `bundle` + `@yao-pkg/pkg` to a `kunj` binary for `node20-macos-arm64` |
| `prepublishOnly` | `npm run build && npm run test` |

The npm package ships `dist` (without `dist/**/__tests__`) and `README.md`; `bin.kunj` is
`./dist/index.js`, `types` is `./dist/lib/json-types.d.ts` ([JSON Contract](/architecture/json-contract.md)).

# Version at Runtime

`getVersion()` in `src/lib/version.ts` does `require('../../package.json').version` (fallback
`0.0.0`). Never inline a version at build time: the release job runs `npm version <v>
--no-git-tag-version` *after* `npm run build`, so anything compiled in would be stale. `kunj -V` is
answered before the command registry loads ([Fast Path](/architecture/fast-path.md)).

# CI (ci.yml)

On pull requests to and pushes on `main`, `ubuntu-latest`, Node 20: `npm ci`, `npm test`,
`npm run build`, `node dist/index.js --version`.

# Release (release.yml)

Triggers: push of a tag matching `v*.*.*`, or `workflow_dispatch` with input `version` (no `v`; the
release step creates the tag on the selected ref). Permissions `contents: write`, `packages: write`.

| Job | Runner | Steps |
|-----|--------|-------|
| `release` | `ubuntu-latest`, Node 20 | Extract version; `npm ci`; build; test; `npm version`; `npm publish --access public` with `NPM_TOKEN` (`continue-on-error`); build the VS Code extension in `vscode-extension/` (`npm ci`, `npm version`, `npm run package`); create the GitHub release (`softprops/action-gh-release@v1`, generated notes, `vscode-extension/*.vsix` attached); finally fail the job if npm publish failed |
| `macos-app` | `macos-15` | `needs: release`, runs when the GitHub release step succeeded (even if npm failed); `macos-app/scripts/bundle.sh`, zip `build/Kunj.app` as `Kunj-macos-<version>.zip`, attach |
| `workspace-app` | `macos-15` | Same condition; `npm ci` in `workspace-app/web`, `workspace-app/scripts/bundle.sh`, zip `build/Kunj Workspace.app` as `Kunj-workspace-<version>.zip`, attach |

A broken npm token therefore never blocks the GitHub release or the app builds, and a failing macOS
build never blocks npm. Both apps are unsigned and not notarized; the release notes tell users to
clear the quarantine attribute.

## Asset names

| Asset | Matched by (`COMPANION_APPS` in `src/lib/apps.ts`) |
|-------|----------------------------------------------------|
| `kunj-worktrees-<version>.vsix` | `/^kunj-worktrees-.*\.vsix$/` |
| `Kunj-macos-<version>.zip` | `/^Kunj-macos-.*\.zip$/` |
| `Kunj-workspace-<version>.zip` | `/^Kunj-workspace-.*\.zip$/` |

`kunj install` downloads these from `adrianj98/kunj` releases (`RELEASES_REPO`), preferring the
release that matches the CLI version (`pickAsset()`), so the workflow's file names and these patterns
must change together ([Setup and Install](/features/setup-and-install.md)).

# Cutting a Release

```sh
git tag v1.2.3 && git push origin v1.2.3
```

`release.sh` is an interactive helper: it warns when not on `main`, refuses uncommitted changes, offers
patch/minor/major/custom bumps from the `package.json` version, pulls `main`, creates an annotated tag
and pushes it. It does not edit `package.json`.

# GitHub Pages (pages.yml)

On pushes to `main` touching `site/**`, `docs-site/**`, `src/commands/**`, `src/settings/**`,
`src/lib/hook-defs.ts` or the workflow (or manually): Node 22, `npm ci` at the root (the docs generator
loads the CLI sources through ts-node), `npm ci && npm run build` in `docs-site/` (which runs
`npm run gen` first), then `site/` is copied to `_site/` and `docs-site/dist` to `_site/docs`, and
deployed with `actions/deploy-pages@v4` (concurrency group `pages`). See [Docs Site](/apps/docs-site.md).

# Related Concepts

* [Testing](/architecture/testing.md)
* [Setup and Install](/features/setup-and-install.md) - `kunj install`
* [VS Code Extension](/apps/vscode-extension.md), [macOS App](/apps/macos-app.md), [Workspace App](/apps/workspace-app.md)
* [Docs Site](/apps/docs-site.md)

# Citations

[1] [.github/workflows/release.yml](/.github/workflows/release.yml)
[2] [.github/workflows/ci.yml](/.github/workflows/ci.yml)
[3] [.github/workflows/pages.yml](/.github/workflows/pages.yml)
[4] [.github/workflows/README.md](/.github/workflows/README.md)
[5] [release.sh](/release.sh)
[6] [package.json](/package.json)
[7] [src/lib/version.ts](/src/lib/version.ts)
[8] [src/lib/apps.ts](/src/lib/apps.ts)
[9] [scripts/copy-container-assets.js](/scripts/copy-container-assets.js)
[10] [CLAUDE.md](/CLAUDE.md)
