# Container Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** sidecar services, editor attach, auto port forwarding, prune, Docker-in-Docker and a host MCP bridge for `kunj container`.

**Architecture:** every feature plugs into the existing seams — `ContainerBackend` (only `docker.ts` runs docker), `startContainer`/`resume`/`removeContainer` in `lifecycle.ts` (move new code into focused modules: `services.ts`, `autoforward.ts`, `prune.ts`, `dind.ts`, `mcpbridge.ts`, `editor.ts`), the command in `src/commands/container.ts`, labels as the only state.

**Tech stack:** TypeScript strict, Node 20, Jest + `FakeBackend`, Docker CLI, POSIX sh.

**Spec:** docs/specs/container-phase-2.md (binding; decisions settled with the user).

## Global constraints

- Work and commit on `main` (no branches). Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; aj-log.md entry per task; leave `dist/` and `.impeccable/` out.
- No host bind mounts; secrets only via the run env-file; nothing exec'd in the branch container before its helper is READY.
- `kunj ct list --json` changes are additive only.
- Fast path: no AWS/LangChain/Jira imports in container modules; inquirer lazy.
- `npm test`, `npm run lint`, `npm run build` green per task; Docker features also add a test to `integration.docker.test.ts` and run `npm run test:docker` once.
- Detached helpers (auto-forward, MCP bridge) are kunj child processes recorded in `~/.kunj/container-forwards.json` / `~/.kunj/container-bridges.json` with pid; dead pids pruned on read; they exit when the container stops (poll `docker inspect` state every 5 s).

## Review focus

1. A service image named in a branch's blueprint must never get host mounts, privileged, added caps or forwarded env (T1 test).
2. Services must not be reachable from another branch's container (T1 Docker test).
3. Prune must keep a container whose deleted branch still has unpushed work (T4 test).
4. `privileged` must be refused without `allowPrivileged` and on Docker Desktop's default context (T5 tests).
5. The MCP bridge must reject navigation to a non-allowed origin and never forward host env to the container (T6 tests).

---

### Task 1: Sidecar services

**Files:** create `src/lib/container/services.ts`; modify `blueprint.ts` (parse `services`), `devcontainer.ts` (compose path + import via a small YAML subset parser — or add `yaml` dependency? **No new deps:** compose files are YAML; write a minimal parser for the keys used, or shell out to `docker compose -f <file> config --format json` on the host — **use `docker compose config` through the backend** (`backend.composeConfig(fileText)` streamed via stdin), which handles real YAML), `backend.ts`/`docker.ts`/`FakeBackend` (`composeConfig`, `logs(id, follow)`), `lifecycle.ts` (start/resume/stop/remove/rollback), `snapshot.ts` (services during snapshot builds), `src/commands/container.ts` (`logs`, `forward <svc>:<port>`, list JSON), settings (`container.services`), README/CLAUDE.md.

**Interfaces:**
```ts
export interface ServiceSpec { name: string; image: string; env: Record<string,string>; command?: string[]; port?: number; healthcheck?: string; volumes: Record<string,string>; dependsOn: string[] }
export function parseServices(raw: unknown, source: string): ServiceSpec[];           // validates; names [a-z0-9-]
export function servicesFromCompose(config: any, excludeService?: string): { services: ServiceSpec[]; dropped: string[] };
export function mergeServices(...layers: ServiceSpec[][]): ServiceSpec[];             // first layer wins by name
export function serviceOrder(services: ServiceSpec[]): ServiceSpec[];                 // topological; cycle → Error
export function serviceNames(names: ContainerNames, svc: string): { container: string; volume: (v: string) => string };
export async function startServices(backend, names, repoId, branch, services, opts: { warn, timeoutMs?: number }): Promise<{ created: string[]; volumes: string[] }>;
export async function serviceStates(backend, names): Promise<Array<{ name: string; state: string; port?: number }>>;
```
- [ ] Tests: parse/validate (bad name, missing image, host-path volume rejected), compose mapping + dropped keys, merge precedence, topo order + cycle, run specs (no env except declared, no mounts other than named volumes, no caps, network alias), health-check warn after timeout (fake timers), rollback includes services, remove deletes service containers + volumes, list JSON `services`, snapshot build starts services before setup. Docker: postgres service reachable as `postgres:5432` from the branch container and not from a second branch's container; `setup` runs `pg_isready -h postgres` successfully during a snapshot; removal leaves nothing labelled.
- [ ] Commit `Containers: sidecar services`.

### Task 2: Editor attach

**Files:** create `src/lib/container/editor.ts`; modify command (`open`), README.
```ts
export function attachedContainerUri(containerName: string, folder = '/workspace'): string;
export function imageConfigPaths(home: string, platform: NodeJS.Platform): string[];   // VS Code + Cursor globalStorage imageConfigs dirs
export function writeImageConfig(dir: string, image: string, cfg: { remoteUser?: string; workspaceFolder: string }): string;
```
- [ ] Tests: URI hex encoding (decode round-trip), image config file name encoding (VS Code uses the image name URL-encoded; verify against the extension's behaviour and document), command builds the editor argv via `buildOpenCommand`, non-VS-Code editor prints the exec command, stopped container is started first.
- [ ] Manual check with VS Code if installed (`code --version`); report.
- [ ] Commit `kunj ct open: attach the editor to a branch container`.

### Task 3: Auto port forwarding

**Files:** create `src/lib/container/autoforward.ts` (+ registry), modify `forward.ts` (reuse `forwardPort`), command (`forward --auto [--detach]`, `agent` starts detached auto-forward unless `container.forward.auto === false`), settings (`container.forward.auto` default true, `container.forward.ignore`), list JSON.
```ts
export function parseSsListen(output: string): number[];
export function diffPorts(current: Set<number>, next: number[], ignore: number[]): { add: number[]; remove: number[] };
export interface ForwardRecord { pid: number; container: string; port: number; hostPort: number; kind: 'forward' }
export function readForwards(file?: string): ForwardRecord[]; export function writeForwards(...)...
export async function runAutoForward(backend, containerId, opts: { ignore: number[]; intervalMs?: number; onChange?: ... ; signal: AbortSignal }): Promise<void>;
export function spawnDetached(args: string[]): number;   // node process.execPath dist/index.js ct forward <branch> --auto (no --detach), detached, stdio ignored
```
- [ ] Tests: ss parsing (IPv4/IPv6/wildcard), diff with ignore and <1024, registry prune of dead pids, agent spawns detached forwarder by default and not when disabled, list JSON includes forward entries. Docker: start `node -e` server after `--auto` begins → reachable on localhost within 3 s; stop it → port freed.
- [ ] Commit `kunj ct forward --auto, on by default with agent`.

### Task 4: Prune

**Files:** create `src/lib/container/prune.ts`; command (`prune`), list JSON `orphans`, settings `container.pruneAfterDays`.
```ts
export interface PrunePlan { containers: Array<{ branch: string; names: ContainerNames; reason: 'branch-gone' | 'age'; guard?: RemoveGuard; kept?: string }>; orphans: Array<{ kind: 'container'|'volume'|'network'; name: string }>; images: string[]; bytes: number }
export async function planPrune(backend, ctx: { repoId, repoName, cwd, kunjVersion, now?: Date, pruneAfterDays?: number, force: boolean }): Promise<PrunePlan>;
export async function applyPrune(backend, plan: PrunePlan, ctx): Promise<{ removed: string[]; failed: string[] }>;
```
- Branch gone: `git ls-remote --heads origin` once (non-interactive env, timeout); unreachable origin → nothing pruned for that reason (fail safe).
- [ ] Tests: plan composition (gone branch with clean guard → removed; with unpushed → kept with reason; orphan helper/volume/network; old snapshot image; superseded kunj image tags; age rule), `--dry-run` default without TTY, `--all` iterates repos. Docker: orphaned helper + volume removed; unpushed-on-deleted-branch kept.
- [ ] Commit `kunj ct prune`.

### Task 5: Docker-in-Docker

**Files:** create `src/lib/container/dind.ts`; `src/container/sandbox-dind/` (Dockerfile `FROM kunj-sandbox` + docker-ce, dockerd, compose plugin, `kunj-dind-start` script) and its image tag/hash; lifecycle (mode → run spec: runtime/privileged, no capDrop, docker volume, start dockerd as root after READY, wait for `docker info`), firewall env (Docker Hub, CDN, ghcr domains), settings (`container.dockerInDocker`, `container.allowPrivileged`), list JSON `dockerInDocker`, README (Colima profile with file sharing off).
```ts
export type DindMode = 'off' | 'sysbox' | 'privileged';
export async function checkDind(backend, mode: DindMode, cfg: { allowPrivileged: boolean }, info: { runtimes: string[]; context: string; isDockerDesktop: boolean }): Promise<void>;   // throws StartError('dind', message)
```
- Backend gains `info()` returning `{ serverVersion, runtimes, operatingSystem }` (extend existing) and the command reads `docker context show`.
- [ ] Tests: refusal matrix (sysbox without runtime; privileged without allowPrivileged; privileged on Docker Desktop), run spec per mode, dockerd started after READY as root, firewall domains added, compose hint when off. Docker: skipped unless `KUNJ_TEST_DIND_CONTEXT` names a disposable context; then `docker run hello-world` works inside.
- [ ] Commit `Containers: Docker-in-Docker (sysbox, privileged)`.

### Task 6: Host MCP bridge

**Files:** create `src/lib/container/mcpbridge.ts`; sandbox image gets nothing new (socat present); lifecycle (write the container's Claude Code MCP config entry after seed: `~/.claude.json` `mcpServers.<name> = { command: 'socat', args: ['-', 'UNIX-CONNECT:/run/kunj-mcp/<name>.sock'] }` merged, as the sandbox user); command (`agent` starts a detached bridge when `container.mcp` has entries; `kunj ct mcp [branch]` runs it in the foreground for debugging); settings `container.mcp`.
- Mechanism: host runs `docker exec -i <ctr> socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock,fork,mode=600 EXEC:'kunj-mcp-relay'` is not possible (relay would run in the container). **Use:** host keeps one `docker exec -i <ctr> socat UNIX-LISTEN:…,fork STDIO`? — fork + STDIO shares one stdio for all connections, so only one connection at a time. **Ruling:** v1 supports one connection at a time per server (Claude Code opens one stdio session per server): host loop = `exec socat UNIX-LISTEN:<sock>,mode=600,user=<uid> STDIO` (no fork) ↔ spawn the MCP server process; when either side ends, restart both. Document the single-session limit.
```ts
export interface McpServerConfig { command: string; args?: string[]; env?: Record<string,string>; allowOrigins?: string[] }
export function containerMcpEntry(name: string): { command: string; args: string[] };
export function makeOriginFilter(allow: string[]): (line: string) => { pass: boolean; reply?: string };   // JSON-RPC line filter for tools/call navigate_page/new_page url args
export async function runBridge(backend, containerId, name: string, cfg: McpServerConfig, opts: { user: string; signal: AbortSignal; spawn?: typeof child_process.spawn }): Promise<void>;
```
- Only the `chrome` browser server is allowed in v1 (decision): `container.mcp` keys other than the documented browser entry warn and are skipped.
- The host MCP process gets only `cfg.env` + PATH/HOME (never the forwarded container env).
- [ ] Tests: origin filter (localhost pass, other origin → JSON-RPC error reply, non-navigate calls pass, malformed lines pass through unchanged), container config merge (keeps existing servers), bridge with FakeBackend streams + a fake MCP server process (echo) round-trips a JSON-RPC message, restart after the server exits, agent spawns the bridge only when configured. Docker: fake echo MCP server on host, `socat - UNIX-CONNECT:/run/kunj-mcp/chrome.sock` inside receives the echo.
- [ ] Commit `Containers: bridge host MCP servers (browser) into the container`.

---

After each task: update the Claude Docs specs ("Kunj Container System Spec" status table and the relevant section; "Container Phase 2 Spec" status) — the controller does this, not the implementer.
