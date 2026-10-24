# Remote Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run branch containers on another machine through `kunj serve`, driven from the laptop by the same `kunj ct` commands and apps, with every Docker call (the terminal included) crossing the wire as kunj's own protocol and SSH only as an optional tunnel.

**Architecture:** `src/lib/serve/` holds the protocol (routes, frames, errors), the server (Node `http` + `ws`, one route per `ContainerBackend` method, `kunj.*` guards, bearer token) and the SSH tunnel. `src/lib/container/remote.ts` is `RemoteKunjBackend`, a `ContainerBackend` over that protocol; nothing above the interface changes. `docker.ts` gains `execTty()` over the Docker Engine API for TTY execs. `kunj serve` and `kunj remote` are fast-path commands; `container.remote` / `--remote` pick the backend in `ct`.

**Tech Stack:** TypeScript (strict, CommonJS), Node `http`/`https`/`net`, `ws` (new dependency, loaded lazily so the local path stays light), Jest with `FakeBackend`. No native modules.

**Spec:** `docs/specs/remote-containers.md` (decisions 2026-10-24).

## Global Constraints

- Only `docker.ts` talks to Docker: spawning `docker`, and `execTty()` over the daemon socket. The server imports `docker.ts`; the client never does.
- No host path reaches the backend: tar bodies, bundles and env are streams or request bodies. Nothing is written to the box's disk except the `--env-file` temp file `LocalDockerBackend.run()` already makes (0600, deleted after the run).
- A secret value is never in a URL, a header, a label, a log line or a WebSocket control frame. Request bodies are never logged; `--verbose` logs method, route, id and duration.
- The server refuses every object without a `kunj.*` label, image tags not starting with `kunj-`, `privileged`/`runtime` without its flags, bodies over 1 MB (streaming bodies excepted), label keys outside `kunj.*` on create, and a non-loopback `--listen` without `--allow-remote-listen`. The guard is one `inspect` per id, cached 5 s.
- Token: 32 random bytes base64url, `~/.kunj/serve/token` 0600 on the box, `~/.kunj/remotes.json` 0600 on the laptop, constant-time compare (`crypto.timingSafeEqual` on equal-length buffers), 401 without detail. Never in argv unless the user chose `--token` (which warns).
- `RemoteKunjBackend` rethrows server errors as the same `Error` text `LocalDockerBackend` produces (`Docker is not available: …`, `docker exec timed out after N ms` as `ExecTimeoutError`, `exec ended: connection closed`), so lifecycle's handling is unchanged.
- Exec frames: binary, first byte channel (`0` stdin, `1` stdout, `2` stderr); text frames are control JSON (`resize`, `exit`, `error`). Empty channel-0 frame is stdin EOF. Backpressure at 1 MB buffered.
- `ct`, `serve` and `remote` stay on the fast path: `ws` and `remote.ts` are imported lazily, only when a remote is in use.
- Protocol version is an integer in `GET /v1/info`; the client refuses another major (`remote-protocol`).
- Error codes (`ContainerError.jsonCode`): `remote-unreachable`, `remote-unauthorized`, `remote-protocol`, `remote-refused` (a guard), `remote-no-editor`, `remote-unknown` (no such remote name).

## Review Focus

1. **Guards.** A request naming a container without `kunj.repo`, an image tag without `kunj-`, a `run` with `privileged` on a server without `--allow-privileged`: all refused with `remote-refused`, and `FakeBackend.calls` shows the backend was never reached (Task 1).
2. **Backpressure and half-close on the exec channel.** A 10 MB stdin and a 10 MB stdout cross without buffering more than ~1 MB on either side; stdin EOF reaches the command while stdout still flows; a client close mid-exec ends the server-side exec (Task 3).
3. **Terminal restore.** Every exit path of a TTY exec (exit frame, socket close, error, uncaught exception) calls `setRawMode(false)` exactly once (Task 5).
4. **Error text parity.** The parametrised lifecycle tests pass unchanged over `RemoteKunjBackend`; the messages lifecycle prints for a timed-out ready wait and a failed exec are byte-identical local and remote (Task 2).
5. **Token never logged.** `--verbose` output and the error of a 401 contain no token bytes (Task 4).

---

### Task 1: Protocol module and server core over `FakeBackend`

**Status: done** in aab2a76 (guards relaxed for reads in fbb95e0).

**Files:**
- Create: `src/lib/serve/protocol.ts`, `src/lib/serve/guard.ts`, `src/lib/serve/server.ts`, `src/lib/serve/token.ts`
- Test: `src/lib/serve/__tests__/server.test.ts`, `src/lib/serve/__tests__/guard.test.ts`
- Modify: `package.json` (`ws`, `@types/ws`)

**Interfaces:**
- `protocol.ts`: `PROTOCOL_VERSION = 1`; `ServeError { code, message, status }`; `encodeFrame(channel, data)` / `decodeFrame(buf)`; `ExecRequest { cmd, user?, workdir?, env?, tty?, stdin: boolean, timeoutMs? }`; `ExecControl = { resize } | { exit } | { error }`; `labelQuery(labels)` / `parseLabelQuery(url)` (`label=k=v` repeated; `k=` means any value, as `events()` takes it).
- `guard.ts`: `Guard` with `container(id)`, `image(tag)`, `runSpec(spec, flags)`, `filter(labels)`, `removeIds(ids)`; throws `ServeError(403, 'remote-refused', …)`; caches `inspectLabels` per id for 5 s.
- `server.ts`: `createServeServer(opts: { backend, token, allowPrivileged?, allowRuntimes?, log? }): { listen(host, port): Promise<AddressInfo>; close(): Promise<void> }`. Unary routes as the spec's table. No streaming yet (Task 3).
- `token.ts`: `loadOrCreateToken(file)`, `rotateToken(file)`, `tokenMatches(given, expected)`.

- [ ] **Step 1: Failing tests** for `encodeFrame`/`decodeFrame`, `labelQuery` round trip, `tokenMatches` (equal, different, different length, empty).
- [ ] **Step 2: Failing server tests**: `GET /v1/info` without token → 401 and `FakeBackend.calls` empty; with token → `{ kunj, protocol: 1, features, engine }`; each unary route forwards and returns the fake's result; a `run` with labels lacking `kunj.repo` → 403 `remote-refused` and no `run` call; `run` with `privileged` refused without the flag, accepted with it; `remove` with a volume lacking `kunj.repo` refused; body over 1 MB → 413; unknown route → 404 `{ error: { code: 'not-found' } }`.
- [ ] **Step 3: Implement** protocol, guard, token, server with Node `http` (no express: fast path, and the UI server is a separate concern).
- [ ] **Step 4:** `npm test -- src/lib/serve`, `npm run lint`. Commit: "kunj serve: protocol, guards and the unary routes over a fake backend".

### Task 2: `RemoteKunjBackend`, unary calls, parametrised lifecycle tests

**Status: done** in 8b4d3e2 and fbb95e0 (`testBackend()` + `KUNJ_TEST_REMOTE=1`, `npm run test:remote`).

**Files:**
- Create: `src/lib/container/remote.ts`
- Test: `src/lib/container/__tests__/remote.test.ts`; `src/lib/container/__tests__/remote-harness.ts` (starts the server over a `FakeBackend` on an ephemeral port and returns `{ fake, remote, close }`)
- Modify: `src/lib/container/__tests__/lifecycle.test.ts` (and `services`, `snapshot`, `prune`, `forward` where cheap): `describe.each([['fake', …], ['remote', …]])` over a backend factory

**Interfaces:**
- `new RemoteKunjBackend({ baseUrl: string; token: string; fetchImpl? })`; `features` is filled lazily from `/v1/info` on first use (`await remote.ready()` is called by `ct`'s context so `features` is sync afterwards, as the interface declares).
- Error mapping: network error → `Error('Docker is not available: <remote name>: <cause>')` with `jsonCode: 'remote-unreachable'`; 401 → `remote-unauthorized`; 403 → `remote-refused` with the server's message; other statuses → the server's `message` verbatim.

- [ ] **Step 1: Failing tests**: every unary method round-trips (arguments arrive in `FakeBackend.calls` deep-equal, results come back deep-equal, including `null` for a missing container and `ExecTimeoutError` later); 401 and unreachable mappings; protocol major mismatch → `remote-protocol`.
- [ ] **Step 2: Implement** with `http.request`/`https.request` (no `fetch`: streaming request bodies in Task 3 need it).
- [ ] **Step 3: Parametrise** the lifecycle tests; fix nothing in lifecycle, fix the remote until they pass. Review Focus 4.
- [ ] **Step 4:** `npm test`, `npm run lint`. Commit: "RemoteKunjBackend: unary calls over the protocol; lifecycle tests run over the wire".

### Task 3: Streams: exec (non-TTY), copyIn, buildImage, logs, events

**Status: done** in fbb95e0.

**Files:**
- Modify: `src/lib/serve/server.ts` (WebSocket upgrade through `ws`, chunked bodies), `src/lib/container/remote.ts`
- Test: `src/lib/serve/__tests__/streams.test.ts`; `forward.test.ts`, `autoforward.test.ts`, `mcpbridge.test.ts` parametrised

- [ ] **Step 1: Failing tests**: exec with a stdin stream and captured stdout (`echoUpper`) round-trips; 10 MB each way, buffered amounts sampled below 2 MB (Review Focus 2); stdin EOF while stdout flows; `timeoutMs` → `ExecTimeoutError` with the local text; client abort → server exec's stdin ends; `copyIn` tar bytes arrive intact; `buildImage` body and `BuildOptions` arrive, output lines stream; `logs` with `onLine`; `events` delivers `emitEvent`, resolves on abort, rejects when the server closes.
- [ ] **Step 2: Implement** frames and control messages per the spec; backpressure with `ws`'s `bufferedAmount` and `pause()`/`resume()`; `'inherit'` without tty streams to `process.stdout/stderr`.
- [ ] **Step 3:** `npm test`, `npm run lint`. Commit: "RemoteKunjBackend: exec, copy, build, logs and events over WebSocket and chunked bodies".

### Task 4: `kunj serve`, `kunj remote`, `--remote`, `ct list --json`

**Status: done** (this commit); `selectBackend()` in src/lib/container/select-backend.ts is the one place that picks the backend, with the tunnel seam for Task 6.

**Files:**
- Create: `src/commands/serve.ts`, `src/commands/remote.ts`, `src/lib/remotes.ts`
- Modify: `src/commands/fast.ts`, `src/commands/index.ts`, `src/commands/container.ts` (`context()` picks the backend; `open` refuses `remote-no-editor`; `backend` in list JSON), `src/lib/json-types.ts` (`backend: { kind: 'docker' | 'remote'; context: string; remote?: string; features: … }`), `src/settings/container.ts` (`container.remote`), `src/lib/container/errors.ts`, `docs-site` reference JSON (`npm run gen`)
- Test: `src/commands/__tests__/serve.test.ts`, `remote.test.ts`, `src/lib/__tests__/remotes.test.ts`

- [ ] **Step 1: Failing tests**: `serve` refuses a non-loopback `--listen` without the flag; creates the token file 0600 on first run and prints it once; `serve token --rotate`; `remote add --url http://10.0.0.5:7433` refused (plain http only to loopback), `--url https://…` accepted, `--token-stdin` read; `remote list` never prints tokens; `ct list --json` with `--remote` has `backend.kind === 'remote'`; `ct open` on a remote → `remote-no-editor`; `--verbose` log of a 401 has no token bytes (Review Focus 5).
- [ ] **Step 2: Implement.** `remotes.json` shape per the spec; `--remote local` forces the laptop.
- [ ] **Step 3:** `npm test`, `npm run lint`, `cd docs-site && npm run gen`. Commit: "kunj serve and kunj remote; ct --remote picks the remote backend".

### Task 5: TTY exec

**Files:**
- Modify: `src/lib/container/docker.ts` (`execTty()` over the Engine API: socket path from `docker context inspect`, hijack, resize, exit code), `src/lib/container/backend.ts` (optional `execTty?` on the interface, used by the server for `tty: true`), `src/lib/serve/server.ts`, `src/lib/container/remote.ts` (raw-mode terminal), `src/lib/container/__tests__/fake-backend.ts` (`execTty` fake)
- Test: `src/lib/container/__tests__/remote-tty.test.ts` (fake terminal: duplex pair, `setRawMode` recorded), `src/lib/container/__tests__/docker.test.ts` (Engine API request shapes against a fake Unix socket server), `remote.docker.test.ts` (`stty size` after a resize; hang-up on close)

- [ ] **Step 1: Failing tests**: raw mode on, first `resize` sent, `SIGWINCH` → `resize`, `0x03` passes through, exit code from the `exit` frame, raw mode off exactly once on exit / close / error / uncaught exception (Review Focus 3); the server refuses env names other than `TERM`, `COLORTERM`, `LANG` on a TTY exec; `execTty` issues the four Engine API calls in order with the right bodies.
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** `npm test`, `npm run lint`, `npm run test:docker` where Docker exists. Commit: "Remote TTY exec: raw-mode client, resize frames, Engine API on the server".

### Task 6: SSH tunnel, events per repo, detached helpers

**Files:**
- Create: `src/lib/serve/tunnel.ts` (`openTunnel({ ssh, port }) → { localPort, close }`: `ssh -N -L <free>:127.0.0.1:<port> <ssh>`, ready when the local port accepts, killed on exit)
- Modify: `src/commands/remote.ts` (`add --ssh` pings once interactively so the host key is known), `src/lib/container/remote.ts`, `src/commands/events.ts` (per-repo remote from the repo's config), `src/commands/container.ts` (`spawnDetached` passes `--remote`)
- Test: `tunnel.test.ts` with a fake `ssh` (a script that listens on the port it is told), `events.test.ts` additions

- [ ] **Step 1: Failing tests**, **Step 2: Implement**, **Step 3:** `npm test`, `npm run lint`. Commit: "Remote containers: SSH tunnel, per-repo remotes in kunj events, detached helpers".

### Task 7: Functional test, docs, setup

**Files:**
- Create: `test/functional/remote.functional.test.ts` (starts `kunj serve` as a child with a throwaway HOME, `remote add --url http://127.0.0.1:<port>`, runs start/list/shell(`script`)/forward/stop/remove with `--remote`)
- Modify: `docs-site/src/content/docs/…/remote.mdx` (new page), `docs/specs/remote-containers.md` (status table), `docs/specs/README.md` (tracker), `CLAUDE.md` (a "Remote containers" paragraph), `src/commands/setup.ts` (asks about a remote when `ct` is used)

- [ ] **Steps:** tests, docs, tracker. Commit: "Remote containers: functional test, docs, setup".

## Order and dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7. Step 1 of the spec's implementation order (validating `container.dockerContext` over SSH) needs a real box and is done by the user alongside Task 1; its findings go into the spec's open questions.
