---
type: Architecture
title: Testing
description: The test layers of kunj - Jest unit tests with the FakeBackend, the opt-in Docker integration suite, the opt-in functional suite that drives the built CLI, and the Swift tests of the two macOS apps.
resource: jest.config.js
tags: [architecture, testing, jest, docker, functional, swift]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

kunj has four test layers with increasing cost. Only the first runs by default and in CI; the Docker
and functional suites need a Docker daemon and are run explicitly; the Swift suites belong to the app
packages.

| Layer | Command | Files | Needs |
|-------|---------|-------|-------|
| Unit | `npm test` | `src/**/__tests__/*.test.ts` | Nothing (git for a few) |
| Docker integration | `npm run test:docker` | `src/**/__tests__/*.docker.test.ts` | Docker; skips itself otherwise |
| Functional | `npm run test:functional` | `test/functional/*.functional.test.ts` | Docker, `script`, many minutes |
| Swift | `scripts/test.sh` in `macos-app/` or `workspace-app/` | `Tests/KunjBarCoreTests`, `Tests/KunjWorkspaceCoreTests` | Command Line Tools |

Run one Jest file with `npm test -- path/to/file.test.ts`. `npm run lint` type-checks both `src/` and
`test/functional/`.

# Unit Tests (jest.config.js)

`ts-jest` preset, `testEnvironment: 'node'`, `roots: ['<rootDir>/src']`, `testMatch`
`**/__tests__/**/*.test.ts` (and `*.spec.ts`/`*.test.ts`), with `\.docker\.test\.ts$` in
`testPathIgnorePatterns`. Coverage (`npm run test:coverage`) covers `src/**/*.ts` minus tests,
`.d.ts` and `src/index.ts`, reported as text, lcov and html in `coverage/`.

Test directories: `src/lib/__tests__`, `src/commands/__tests__`, `src/settings/__tests__`,
`src/lib/container/__tests__`, `src/lib/secrets/__tests__`.

Conventions that keep unit tests hermetic:

* **FakeBackend** (`src/lib/container/__tests__/fake-backend.ts`) implements `ContainerBackend` in
  memory: it records every call in `calls`, answers execs from `execResults` keyed by the joined
  command, can reject (`execErrors`), hang (`hangOn`) or fail a method (`failOn`), and keeps
  `existing` containers and images. All container lifecycle, forwarding, prune, services and snapshot
  logic is tested through it ([Container Backend](/containers/backend.md)).
* **No real token lookups**: `StartOptions.tokenLookup` replaces `gh auth token`
  ([Tokens](/containers/tokens.md)).
* **No real Keychain**: secrets tests use a fixed `KUNJ_SECRETS_KEY` or a fake `Runner`/prompt
  ([Key Providers](/secrets/key-providers.md)).
* **Throwaway HOME**: path helpers such as `getReposPath()` resolve `os.homedir()` per call so tests can
  redirect it; `resetRepoCache()` clears cached repo resolution.
* **Contract checks**: `json-types.test.ts` and `json-types.contract.test.ts` fail to compile when the
  [JSON contract](/architecture/json-contract.md) loses fields.

# Docker Integration Suite

`npm run test:docker` runs `jest --runInBand` with `testMatch` `**/__tests__/**/*.docker.test.ts`
(today `src/lib/container/__tests__/integration.docker.test.ts`). It is wrapped in
`(dockerUp ? describe : describe.skip)` so it skips when `docker info` fails. It builds the real
images and checks the firewall, blueprints and snapshots (including bundle seeding through a host
`git daemon` reached via `core.gitProxy`), services and prune. Docker-in-Docker cases run only with
sysbox-runc installed, or on a non-Desktop daemon with `KUNJ_TEST_DIND_PRIVILEGED=1`.

# Functional Suite (jest.functional.config.js)

Drives the built CLI (`node dist/index.js ct ...`) as a user would.

* `roots: ['<rootDir>/test/functional']`, `testMatch: ['**/*.functional.test.ts']`, ts-jest with
  `test/functional/tsconfig.json`, `maxWorkers: 1` (shared daemon, images and host ports),
  `testTimeout` 10 minutes.
* `test/functional/global-setup.js`: without `KUNJ_FUNCTIONAL=1` (set by the npm script) it sets
  `KUNJ_FUNCTIONAL_SKIP` and every file skips; if `docker info` fails it skips with a message;
  otherwise it runs `npm run build` so tests use the current sources.
* `test/functional/harness.ts`: `describeFunctional`, one fixture per file (`useFixture`) with a bare
  origin served by `git daemon`, a clone whose origin is `git://host.docker.internal:<port>/<repo>.git`,
  and a HOME of its own (so `~/.kunj` and the registries are the fixture's); after each test it removes
  every Docker object labelled with the fixture's repo id. Shared git helpers live in
  `src/lib/container/__tests__/git-origin.ts`.

| File | Covers |
|------|--------|
| `lifecycle.functional.test.ts` | start -c / list / stop / resume / remove, the remove guard (unpushed commit), container hooks |
| `exec.functional.test.ts` | exec and shell, own clone (no bind mount), push to origin, forwarded secrets never in labels or argv, firewall |
| `forward.functional.test.ts` | forward, `--auto`, agent + attach under `script`, `open` with and without VS Code |
| `services.functional.test.ts` | sidecar reachable by name from its branch only, logs |
| `blueprint.functional.test.ts` | snapshot built once, `setup` once, `maintain` per start |
| `prune.functional.test.ts` | prune of deleted branches; `KUNJ_FUNCTIONAL_SLOW=1` adds the orphan-volume grace test, `KUNJ_FUNCTIONAL_PRUNE_IMAGES=1` allows `prune --yes` that would remove other kunj images |
| `dind.functional.test.ts` | Docker-in-Docker refusals (privileged without `container.allowPrivileged`) |
| `mcp.functional.test.ts` | MCP bridge with a fake stdio server: tools filtered, paths and `upload_file` refused |

Functional tests are run only when explicitly asked for.

# Swift Tests

Both apps use Swift Testing under SwiftPM. `macos-app/` tests `KunjBarCore` (`KunjBarCoreTests`:
grouping, layout, event feed, window matching, ...). `workspace-app/` tests the Foundation-only
`KunjWorkspaceCore` (`KunjWorkspaceCoreTests`) against `Tests/Fixtures/fake-kunj`, a fake CLI with
canned `responses`. Each app's `scripts/test.sh` works around Command Line Tools SDKs that lack the
macro plugins; `SCRATCH=.build/<name>` gives a parallel build its own directory.

# Related Concepts

* [Release Process](/architecture/release-process.md) - CI runs `npm test` and a build
* [Container Backend](/containers/backend.md)
* [Workspace App](/apps/workspace-app.md), [macOS App](/apps/macos-app.md)

# Citations

[1] [jest.config.js](/jest.config.js)
[2] [jest.functional.config.js](/jest.functional.config.js)
[3] [package.json](/package.json)
[4] [test/functional/harness.ts](/test/functional/harness.ts)
[5] [test/functional/global-setup.js](/test/functional/global-setup.js)
[6] [src/lib/container/__tests__/fake-backend.ts](/src/lib/container/__tests__/fake-backend.ts)
[7] [src/lib/container/__tests__/integration.docker.test.ts](/src/lib/container/__tests__/integration.docker.test.ts)
[8] [test/functional/prune.functional.test.ts](/test/functional/prune.functional.test.ts)
[9] [workspace-app/scripts/test.sh](/workspace-app/scripts/test.sh)
[10] [macos-app/scripts/test.sh](/macos-app/scripts/test.sh)
[11] [.github/workflows/ci.yml](/.github/workflows/ci.yml)
[12] [CLAUDE.md](/CLAUDE.md)
