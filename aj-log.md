# aj-log

Changes made with Claude, and why.

## 2026-10-24 — Review fixes for the container rows

- macOS: a container listing the app cannot decode no longer drops the repository's worktrees; port rows are
  identified by the whole port, not the host port (published and forwarded can share it). VS Code: terminal command
  lines quote `kunj.cliPath` split like the CLI wrapper (paths with spaces, `node …/index.js`). Why: adversary review.

## 2026-10-24 — macOS menu bar app: containers as rows

- Container rows (`ContainerRow`) next to the worktrees, ordered by `interleavePlaces()` in KunjBarCore (tested): a
  branch's container right after its worktree, the rest by name. Open attached (`kunj ct open`), stop and auto-forward
  through the CLI's JSON; start, rebuild, remove, shell, agent and prune in the terminal app. New Worktree window has a
  Worktree/Container choice; Settings has Show branch containers. Old CLIs without `--containers` are retried without.
  Why: same design as the extension, containers feel like local worktrees.
- User docs for both apps updated (docs-site worktrees/vscode-extension and macos-app pages).

## 2026-10-24 — VS Code extension: containers as rows

- The Worktrees view lists containers from `worktree list --containers` next to the worktrees (a branch's container
  right after its worktree), with open (attached), terminal, agent, ports, start/stop/rebuild/remove, PR actions and
  a container choice in Add Worktree…; Start Agent in Worktree. Long commands run in a terminal that closes on
  success. An older CLI without `--containers` is retried without it. Why: containers should feel like local
  worktrees (agreed design).
- Review fixes (adversary round): `worktree list --containers` gives up on a wedged Docker after 10s and kills its
  calls; `listJson` keeps warnings on stderr; the old-CLI fallback reads all of stderr.

## 2026-10-24 — `kunj worktree list --containers`

- `kunj worktree list --json --containers` adds the repository's containers (`kunj ct list --json` shape plus the
  branch's pull request). `ContainerCommand.listJson()` is the list code split out of `list`; the container module
  loads lazily; Docker down gives `available: false`. Why: the extension and the macOS app show containers as rows
  like worktrees, with PRs, from one CLI call and without matching logic of their own.

## 2026-10-24 — Containers in the VS Code extension and the macOS app: spec

- Added `docs/specs/containers-in-apps.md` and moved the work to In progress in the tracker. Why: user asked
  to start the roadmap item; agreed design: containers feel like local worktrees (same rows and actions, two
  rows when a branch has both), the CLI provides both lists in one call.




## 2026-10-23 — Phase 2 follow-ups landed; tracker updated

- Landed the three follow-up batches after review (8c88318, 1cb0c9b; 0637441, f47a9e0; 8f8f23c, 19151f4,
  a335d6a) and moved them to Done in `docs/specs/README.md`, leaving two small items under To do. Why: user
  asked for the phase 2 follow-ups to be done.
## 2026-10-23 — Containers: phase 2 follow-ups (helper refresh, services on resume, compose escapes)

- Resume replaces a running network helper whose image is not the current `kunj-nethelper:<ver>-<hash>`
  (same run spec, READY before anything else); a running container whose helper replacement fails is
  stopped. Why: helpers made before forwards moved into the helper lack socat, so forwards failed until a
  manual stop/start. The remove guard's `bringUp` already always made a fresh helper on the current image.
- Resume reads the declared services (blueprint, `container.services`, the devcontainer's compose file on
  origin) and creates the ones that do not exist yet, in dependency order with health checks; it never
  removes one. A failed resume stops the services it started (not ones already running; `--keep-on-error`
  keeps them). Why: services added after the container was made never started, and a failed resume left
  services running.
- `kunj ct open` resumes first when the helper (or an out-of-date one) or a service is down, not only when
  the container is stopped (`needsResume()` in lifecycle.ts). Why: the editor opened onto a half-up container.
- Compose import also refuses a double-quoted key with a backslash (`"\x69nclude":`, `"fi\x6ce":`) and an
  alias used as a key. Why: compose decodes them, the textual include/extends check did not.
- `start --rebuild` removes the volumes of services no longer declared unless `--keep-volumes`. Why: they
  were left for `prune --force` only.
- Docs (services and commands pages, README), the phase 2 spec and CLAUDE.md updated; `npm run gen`.

Fix round (review of the above):

- Compose refusal is now structural: the text is parsed with `yaml` (new dependency, loaded lazily)
  and refused on a top-level `include`, an `extends` that is not a service name, a parse error, more
  than one document or a tag other than `!reset`/`!override` (`!!binary` decodes to a key). The text
  checks stay as a backstop, plus explicit-key indicators (`? `). `escapedKey` is one pass. Why:
  explicit and alias keys (`? include`, `? *a`, a block-scalar key) bypassed the text checks.
- The auto-forwarder also watches the helper's run and ends when it is replaced, restarted or gone,
  and `start` ends the registered forwarders and MCP bridges of a running container before replacing
  its helper (one line says so). Why: they kept looping on the old helper's id and `agent` would not
  respawn them.
- firewall.sh builds its rules in `KUNJ-OUT-NEW` and swaps the chain in (jump to the new chain, drop
  the old, rename), recovering a half-done swap. The Docker test reloads the rules five times while the
  container probes the host and gateway; it fails on the old script. Why: flushing the live chain opened
  a short default-mode gap whose connections survived as ESTABLISHED.
- Only `start` replaces an out-of-date running helper (`open` passes `keepStaleHelper`); when the new
  helper image cannot be built the old helper is kept with a warning; when the old helper was gone or
  the new one failed, the container is stopped with "Stopped <container>: its firewall could not be
  re-applied (...); kunj ct start <branch> retries". Why: `open` could kill a running agent over a
  helper refresh.
- Resume reads the devcontainer's compose services according to how the container was made (its
  recorded image kind), not the current `container.image`.

Second fix round:

- Compose text with NEL, LS, PS, a BOM past the start, or any C0/C1 control character other than tab,
  LF and CR is refused. Why: yaml.v3 ends comments and block scalars at those, the `yaml` package and
  the text checks do not, so `#c\u0085include: [...]` reached compose.
- `env_file` and `label_file` refuse the compose file, and `docker compose config` runs with
  `--no-env-resolution` (retried without it on a compose that does not know the flag). Why: defence
  in depth, those name host files.
- firewall.sh recovery keeps `KUNJ-OUT-NEW` when it is jumped to and the old chain is not (a helper
  killed mid-swap), instead of dropping the live chain. The Docker test sets up that state before one
  of its reloads; it fails with the previous recovery.
- A registered forwarder/bridge pid is only signalled when `ps` shows a `ct|container forward|mcp`
  command line. Why: a reused pid must never be killed.
## 2026-10-23 — Containers: phase 2 follow-ups (visible forwarder errors, agent window size, logs --json, bridge minors)

- `kunj ct agent` runs the foreground forwarder's checks (network helper running, socat present) before
  spawning the detached forwarder and prints the problem in the agent's terminal instead. Detached
  forwarders and bridges now append their output to `~/.kunj/logs/<container>-forward.log` / `-mcp.log`
  (truncated past 1 MB) instead of `stdio: 'ignore'`. Not done: a `list` hint for a dead forwarder, because
  dead pids are pruned from the registry on read, so `list` cannot tell one died. Why: a failing detached
  forwarder (no socat) was invisible.
- `runAutoForward` checks the container's state before warning that it cannot read the listening ports, so
  stopping the container no longer prints a cosmetic warning.
- `kunj ct agent` sets tmux `window-size latest`, like `kunj agent`.
- `kunj ct logs --json` prints NDJSON `{ service, stream, line }` (`service` null for the branch container);
  `ContainerBackend.logs` takes an optional `onLine`.
- MCP bridge: a container reply is dropped unless the server issued that id (not only when the bridge had
  answered it); the "refused a request" log is limited to one per second with a count of the rest; removed a
  stale docstring sentence.
- Review fixes: the log directory is created 0700 and the files 0600 (fixed if they exist, `O_NOFOLLOW`);
  the container-supplied listener error text is stripped of control characters and capped before it is
  logged; the `boundedKeys` doc comment is back above it. Why: the logs hold container output.
## 2026-10-23 — Containers: opt-in functional test suite (real CLI, real Docker)

- Added `test/functional/` (8 `*.functional.test.ts` files, `harness.ts`, `global-setup.js`, its own
  `tsconfig.json`) and `jest.functional.config.js`, run by `npm run test:functional`. The tests drive
  `node dist/index.js ct …` in a throwaway repository with a `git daemon` origin and a throwaway `HOME`,
  against the real Docker daemon, and clean up everything labelled with the test repository after each
  test. Why: the user asked for end-to-end tests of the CLI as a user runs it; they were written but,
  as asked, not run.
- Opt-in: the global setup skips every file unless `KUNJ_FUNCTIONAL=1`, skips them when Docker does not
  answer, and builds the CLI otherwise. They live outside `src/`, so `npm test`, `npm run test:docker`
  and `npm run build` never pick them up. `npm run lint` now also type-checks them.
- Moved the Docker suite's origin helpers (git daemon, git proxy, freePort, waitFor, ...) into
  `src/lib/container/__tests__/git-origin.ts` and made `integration.docker.test.ts` import them, so both
  suites share one origin setup. Why: asked to share rather than copy; that suite's behaviour is unchanged.
- CLAUDE.md: a "Functional tests" paragraph under Branch Containers.

## 2026-10-23 — Containers: phase 2 follow-ups (remote-tracking ref in seeds, snapshot leftovers, faster tests)

- seed.ts: the fetch in the clone and snapshot-copy seeds now names its destination
  (`+refs/heads/<b>:refs/remotes/origin/<b>`); the bundle seed makes `refs/remotes/origin/<b>` from HEAD when
  the clone lacks it (no network call). Why: prune treats a branch as gone only when the clone has that ref,
  so containers seeded from a bundle or snapshot were never pruned. Unit tests per path; the Docker bundle and
  snapshot-start tests assert the ref.
- prune.ts: a `<branch>:snapshot` container that is stopped or older than 2 hours is planned with reason
  `snapshot-leftover` and removed without a guard or hooks. Why: a killed snapshot build left it behind for ever.
  Docs: prune page and phase 2 spec section 4.
- Review fixes: snapshot leftovers are now only `exited`/`dead`, `created` over 10 min, or live over 24 h (a
  `paused` build is in `docker commit`; the 2 h rule could kill it). A snapshot-copy seed deletes every
  `refs/remotes/origin/*` except the base before checkout, and the create path never runs a bare
  `git switch <branch>` (it could check out a stale remote-tracking ref of a re-used branch name, and prune
  would then call the branch gone). `:` in branch names needs no check: git refuses it in ref names.
- Tests: `jest.setTimeout(30000)` in the snapshot, seed, blueprint, lifecycle, services, presets and both events
  test files (fixture repositories and spawned processes hit the 5 s default when the machine is busy).
  Why: spurious timeouts; tests share nothing between cases, so they were not restructured.

## 2026-10-23 — MCP bridge landed; specs updated

- Landed the host MCP bridge on main (c4ac53d, cf544d8, 92b14ef, d235d85) after three security review
  rounds. Rewrote section 6 of `docs/specs/container-phase-2.md` to describe what shipped (transport,
  configuration, lifetime, filters both ways, origins, limits, what holds and what does not), added
  `container.mcp` and `kunj ct mcp` to its tables, and marked phase 2 done in `container-system.md` and the
  tracker. Why: the old section described the pre-review design.
## 2026-10-23 — `kunj agent` verified against a real tmux

- Ran the manual checks from the CLI contract's final fixes report with tmux 3.8: `KUNJ_*` are this
  branch's with another tmux server running, a second `kunj agent` reattaches to the same pane instead of
  starting a second agent, starting from inside a tmux pane works, and the session has `window-size
  latest`. Moved the item to Done in `docs/specs/README.md`. Why: user installed tmux and asked for it.
## 2026-10-23 — Containers: host MCP bridge (phase 2, Task 6)

Fix round 3 (second re-review), on top of round 2:

- Batches are refused outright with one error (id null, fixed message). Before, each element's error
  repeated the first reason, which quoted the container's method/tool/URL: a 124 KB line gave a 100 MB
  reply and a 1 MB line crashed the host process (`RangeError: Invalid string length`), leaving the
  temp profile behind. Refusals now quote at most 100 characters of container text, a refusal over 1 MB
  ends the session instead of being written, and the handling of each line (both directions) is in a
  try/catch that ends the session, never the process.
- Every server reply whose result has a `tools` array is filtered (by shape, not by id), and a
  request whose id is already in flight is refused, so neither eviction from the 1024 cap nor a
  duplicate id can carry an unfiltered list. Requests leave the in-flight map on any reply.
- Roots: the container's `capabilities.roots` is stripped from `initialize`, and its replies to server
  requests the bridge answered itself (roots/list) are dropped.
- Server lines over 16 MB end the session. The temp profile is removed on every way out: the session's
  end and, synchronously, the process 'exit'; `kunj ct mcp` also stops on SIGHUP.
- `new_page` no longer takes `isolatedContext`: an off-the-record browser context may not inherit the
  profile's download block (not verified either way, so refused; the directory pref would still keep a
  file in the temp dir).

Fix round 2 (security re-review), on top of round 1:

- Backpressure on everything sent to the container, not only the server's output. While a write to the
  container returns false, reading from the container (and the server's stdout) pauses until 'drain';
  more than 8 MB waiting for a container that does not read ends the session. Why: refusal replies were
  written without limit, so a container that sent refusable lines and never read grew host memory
  (batches amplified it).
- Watched requests (initialize, tools/list) are forgotten on any reply, error as well as result; at most
  1024 are kept (oldest dropped). Ids must be strings of at most 256 characters or safe integers;
  others get an error with id null (a response or notification is dropped).
- Downloads: from an allowed page the agent could start a download that landed in the Mac's ~/Downloads.
  chrome-devtools-mcp 1.12.0 has no download setting of its own but takes `--userDataDir`. So the default
  browser now gets a profile per session (`makeThrowawayProfile()`): a temp dir whose
  `Default/Preferences` set `download_restrictions: 3` (block all) and `download.default_directory`
  inside it, plus the server's TMPDIR (large screenshots); deleted when the session ends. This replaces
  `--isolated`. Checked with headless Chrome on this Mac: no prefs put the file in ~/Downloads, the
  directory pref put it in the temp dir, and the restriction blocked it. Docs no longer claim "cannot
  read or write files": they say no file path reaches the server, downloads are refused (by default),
  and with your own command/args a download lands in ~/Downloads.
- Pinned `chrome-devtools-mcp@1.12.0` (`CHROME_DEVTOOLS_MCP`, with how to bump it) and replaced the
  name-pattern check with a per-tool argument allowlist (`BROWSER_TOOL_ARGS`, read from 1.12.0's
  schemas; `pageId` on every tool). Unknown arguments such as `output` or `saveTo` are refused. The
  tools/list rewrite keeps only those properties, and `isPathKey` stays as a second layer, refusing
  past the depth limit (fail closed).
- The bridge answers the server's `roots/list` with no roots and drops the container's
  `notifications/roots/list_changed`; `--no-usage-statistics` added; custom `args` for the default
  command warn that the pin, the flags and the throwaway profile are dropped; help text fixed.

Fix round 1 (security review), on top of the entry below:

- Sandbox escape closed. chrome-devtools-mcp tools take host paths (evaluate_script `filePath`/
  `sourcePath`, upload_file `filePaths`, take_screenshot/take_snapshot `filePath`, heap snapshot, trace
  and Lighthouse output paths), so a request reaching it could read or write any file on the Mac. The
  container→host filter is now deny by default: `BROWSER_TOOLS` (checked against chrome-devtools-mcp
  1.12.0's tool definitions: pages/navigation, input, snapshot/screenshot, console and network reads,
  evaluate_script, emulate/resize_page; no upload_file, memory, performance, lighthouse, screencast,
  extensions, PWA, WebMCP), any key that looks like a path (`isPathKey`: filePath, sourcePath,
  outputDirPath, ...Path/Paths/File/Dir) anywhere in the arguments is refused, only listed JSON-RPC
  methods pass (resources/read and prompts/get are refused), and the tools/list reply is rewritten to
  the allowlist with path-like schema properties removed. Defence in depth: the default args add
  `--categoryPerformance=false --categoryMemory=false --fileNavigations=false` and the env
  `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1`, so a global cd4a config cannot switch them back on. There is no
  flag to switch off file output of screenshots or evaluate_script, so the filter is the guard.
- Root no longer writes into the user's directory. Root runs only `mkdir`/`chown`/`chmod 700` of
  `/run/kunj-mcp`, and refuses a symlink there. The listener (no socat `user=`), its pid file and the
  stop now run as the user. The stop signals the pid only when `/proc/<pid>/cmdline` is that socat
  listener. Why: a user-owned directory plus root writes allowed symlink attacks, and writing `1` into
  the pid file stopped the container.
- One container run: the bridge records `containerRun().startedAt` and ends as soon as the container
  is seen stopped or restarted; only a failed inspect gets two strikes. PREPARE runs before every
  listener. Why: after a quick stop/start the bridge exec'd into the new run before its READY.
- Host memory: a line over 4 MB from the container ends the session; while `server.stdin.write()`
  returns false the container stream is paused until 'drain' (and the other way round). The server
  starts only on the first complete message that passes the filter.
- Default origins: unset `allowOrigins` now means only the host ports forwarded or published for the
  container, read when the call arrives (http/https, localhost/127.0.0.1). An entry with a port allows
  that port, one without allows any port (documented as broad).
- Lines that are not JSON-RPC messages are dropped (fail closed), logged once per bridge.
- Shared `pidRegistry(file, isRecord)` (pidregistry.ts) under the forward and bridge registries (files
  and JSON unchanged). `spawnDetached`'s error names the command instead of "forwarder".
- Pre-existing hole closed: `migrateLegacyKunjDir` copied a repository's `./.kunj/` into
  `~/.kunj/<repo>/`, so a committed `.kunj/config.json` could set `hooks.*` or `container.mcp.command`
  on the host. It now copies only files `git ls-files` does not list, never `blueprint.json` or
  `presets/`, and nothing at all when git cannot list them.
- Docs say plainly that the agent drives a browser on the Mac's network, that the tool allowlist keeps it
  from your files, and that `allowOrigins` limits explicit navigation only (a navigate without a url,
  a click, a redirect or a script still goes anywhere).

- New setting `container.mcp` (host config only, never the blueprint; default `{}` = off). v1 bridges only
  `chrome`: `{}` runs `npx -y chrome-devtools-mcp@latest --isolated`; each entry takes `command`, `args`,
  `env`, `allowOrigins` (default `http://localhost`, `http://127.0.0.1`). Other names warn and are
  skipped. Why: phase 2 spec section 6, so the agent can open the dev server it started in a real
  browser, with the browser-only, isolated-profile, localhost-only decisions.
- New `src/lib/container/mcpbridge.ts`. The container cannot reach the host, so the host connects in: a
  root `docker exec -i <ctr> socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock,unlink-early,mode=600,user=<user>
  STDIO` (no `fork`, so one session at a time per server, as ruled). The server is spawned on the host
  on the session's first byte, with only `cfg.env` + PATH/HOME (never the forwarded container env); when
  either side ends both stop and a new listener waits. `/run/kunj-mcp` is created as root, owned by the
  user, mode 700; the listener writes a pid file so an abort (or a bridge that died) can kill it, since
  a pending `docker exec` cannot be cancelled from the host. Name and user are validated as plain words
  because they go into a socat address.
- Origin filter (container→host): `tools/call` of `navigate_page`/`new_page` with a `url` outside
  `allowOrigins` gets a JSON-RPC error (-32602) with the request id and never reaches the server;
  matching is scheme + hostname (any port) through `URL`, so `localhost.evil.com` and `localhost@evil.com`
  are refused; a non-string url is refused; a batch with a blocked call is refused whole; lines that are
  not JSON pass unchanged. Documented as best effort (a page can still link elsewhere).
- Port hint: the bridge appends the container→host forward map (from `~/.kunj/container-forwards.json`)
  to the `instructions` of the server's initialize result. Cheap: one id tracked per session.
- Container config: `installMcpConfig()` merges `mcpServers.<name> = { command: 'socat', args: ['-',
  'UNIX-CONNECT:/run/kunj-mcp/<name>.sock'] }` into the user's `~/.claude.json` as that user (read, merge
  on the host, write to a temp file and rename; unchanged files are not rewritten; invalid JSON is left
  alone with a warning). Called by `startContainer` after the seed and files (new and resumed), and by
  `kunj ct agent` before the agent starts (a container started before the setting). The snapshot build
  clears `container.mcp`.
- `kunj ct agent` starts a detached `kunj ct mcp <branch>` (same model as the auto forwarder:
  `spawnDetached`, registered at once in `~/.kunj/container-bridges.json`, dead pids pruned on read)
  unless one runs; new `kunj ct mcp [branch]` runs the bridge in the foreground and refuses a second
  bridge for the container. The bridge exits when the container is seen not running twice in a row.
  A listener that ends without a client (socat failing) is logged with socat's stderr and retried with
  a doubling delay up to 30 s, so a broken setup does not spin `docker exec` every half second.
- `kunj ct list` shows `[mcp chrome]`; `--json` gains `bridges: [{ name, pid }]` per container (additive).
- FakeBackend gains `execHandler` for streaming execs. Tests: origin filter, config merge (keeps servers,
  idempotent), registry, bridge end to end with a node echo server (round trip, refusal, restart after
  client disconnect and after server exit, two-strike stop, port hint, env), agent only when configured,
  lifecycle write after the seed; Docker: echo server on the host reached with `socat - UNIX-CONNECT`
  from inside, socket mode 600, navigate to example.com refused, listener gone after abort.
- Docs: README, docs-site commands (`mcp`, agent), configuration ("A browser for the agent"), security
  (table row and "can" list), regenerated reference JSON; CLAUDE.md module list and a bridge paragraph.

## 2026-10-23 — Specs tracker: phase 2 progress brought up to date

- `docs/specs/README.md`: added the cross-feature fixes (a32bc90) to Done, the missing `forward --auto`
  commit, the MCP bridge under In progress (built on a worktree branch, first review found a sandbox
  escape, fixed, final review running), phase 2 review follow-ups and the test-timeout issue under To do,
  and the sysbox check, a stray test file and a duplicate doc under Waiting on you. Status rows in
  `container-phase-2.md` and `container-system.md` now say the bridge is built and in review. Why: user
  asked for an evaluation of what is done and what is left, recorded in the tracker.

## 2026-10-23 — Containers: phase 2 cross-feature fixes (forward via helper, compose deps, orphan grace, migrations docs)

- Port forwarding (manual `forward <port>`, `--auto`'s listener poll and its tunnels) now execs in the
  network helper instead of the branch container; `socat` added to the nethelper image (its tag hash
  changes, so it rebuilds). Why: after a quick stop/start the forwarder could exec into the main container
  before the helper's READY (secrets env, no firewall yet), and connections opened then survive the rules.
  The helper shares main's network namespace and is kunj's own code. No helper running, or an older helper
  without socat, fails closed with a message. Service forwards still tunnel through the service container.
- The auto-forwarder is bound to one run of the container: new backend method `containerRun()` (state and
  `.State.StartedAt`, only docker.ts spawns docker); it exits on the first check that finds the container
  stopped or started again; only a failed inspect gets a second chance. Why: same race as above.
- Compose: a `depends_on` naming a service that was dropped is dropped too and listed in the one warning
  (`web: depends_on api (dropped)`). Why: it made every start fail. Blueprint and `container.services`
  keep the hard error.
- Prune/list: a branch with any object created in the last 10 minutes (`ORPHAN_GRACE_MS`, not a setting)
  is not orphaned; volumes and networks now carry `createdAt` from inspect. Why: a start or `--rebuild`
  waits minutes on service health checks with no main container, and `prune --yes`/`--force` could remove
  its services, network or the kept workspace volume.
- Docs (services, blueprints, README, phase 2 spec/design) and a `blueprint init` hint: migrations
  against services belong in `maintain` and must be idempotent. Why: `setup` runs only in the snapshot
  build, against its throwaway services, so its migrations never reach the branch's own database.
- Forward registry records `containerId` (and `service`); `forwarderFor`, `list` and prune's cleanup match
  by id (name for older records); `forwarderFor` only counts `--auto` forwarders (port 0). Manual
  `ct forward` now registers its forwards under its pid. Why: a recreated container of the same name is
  another container, and `list`/the IDE should see manual forwards.
- `--auto` skips ports already published with `start -p`; `start --rebuild` removes service containers no
  longer declared (volumes kept, with a warning naming them).
- One source of naming truth: `namesOfContainer`, `optionsLabel` (kunj.options parser) and `isMain` live in
  names.ts and are used by lifecycle, services, prune and the command.
- Docs drift: CLAUDE.md key commands gain `open` and `prune`; prune's image rule names `kunj-sandbox-dind`.
- forward.test.ts: "takes the next port above a taken one" no longer assumes port+1 is still free (it
  flaked when another test grabbed it).

## 2026-10-23 — Containers: Docker-in-Docker (phase 2, Task 5)

- New settings `container.dockerInDocker` (`off` | `sysbox` | `privileged`, default `off`) and
  `container.allowPrivileged` (default `false`). Why: phase 2 spec section 5, so a branch whose
  development needs `docker compose up` can run it inside its container, with its own daemon per branch.
- New `src/lib/container/dind.ts`: `checkDind()` refuses before anything is pushed or created (StartError
  code `dind`): `sysbox` unless `docker info` lists `sysbox-runc`, `privileged` unless `allowPrivileged`,
  `privileged` on Docker Desktop even with it. Docker Desktop is detected by `docker info`'s operating
  system and refused whatever the context is called (stricter than "desktop-linux/default", because a
  custom context to Desktop is the same shared VM). The messages name the setting to change.
- `StartError` moved to `src/lib/container/errors.ts` (re-exported by lifecycle.ts) so dind.ts can throw it
  without an import cycle.
- Backend: `info()` now reads `docker info --format '{{json .}}'` and returns `{ serverVersion, runtimes,
  operatingSystem }`; new `contextName()` (the configured context, else `docker context show`), so only
  docker.ts spawns docker. `ContainerSpec` gains `runtime` and `privileged`. FakeBackend gets both.
- New image `kunj-sandbox-dind:<version>-<hash>` from `src/container/sandbox-dind/` (FROM the sandbox via
  `BASE_IMAGE`; docker-ce, CLI, containerd, compose plugin, iptables; `dev` in the `docker` group;
  `kunj-dind-start`). Its hash covers the context and the base tag, so a new sandbox rebuilds it;
  `ImageSource.base` makes `ensureImage` build the sandbox first. A devcontainer/custom image is refused
  (documented limit).
- Run spec with DinD: no cap-drop (dockerd needs the capabilities), `--runtime sysbox-runc` or
  `--privileged`, `/var/lib/docker` on `<container>-docker` (labelled like the other volumes, so `list`
  orphans and `prune` see it; `remove` deletes it), `KUNJ_DIND=<mode>`, `dind` in `kunj.options`.
- `kunj-dind-start` (root, via exec) runs only after the helper's READY, on start and resume, before
  seed/setup/maintain; idempotent, clears the stale pid files and `/var/run/docker` a stopped container
  keeps (found by a manual restart test: containerd timed out otherwise), and waits 30 s; a daemon that
  does not come up is a warning, not a failure.
- Snapshots: `StartOptions.withoutDind` keeps the DinD image (the hash must match a start's) but never
  runs dockerd or creates the docker volume, so nothing of the inner daemon reaches the image.
- Allowlist mode adds Docker Hub, its CDN, `ghcr.io` and `pkg-containers.githubusercontent.com`
  (`firewallEnv`'s new `dindDomains`). `kunj ct list` shows `[dind <mode>]` and JSON `dind` (additive);
  `start` prints `docker <mode>` and a one-line services hint when the repo has a compose file and
  DinD is off (and no services). Resume warns when the setting differs from the container's mode.
- `prune` also knows `kunj-sandbox-dind` tags. Docker test: refusal against the real daemon always;
  a real DinD start (`docker run --rm alpine true` inside, `/var/lib/docker` on the branch volume) only
  with `sysbox-runc` or `KUNJ_TEST_DIND_PRIVILEGED=1` on a non-Desktop daemon.
- Docs: README (section, Colima profile with only an empty directory mounted), docs-site configuration,
  security (threat model of each mode: the firewall is not a boundary with Docker inside), commands,
  overview; regenerated settings.json; CLAUDE.md.
- Review fixes: `precheckDind()` (dind.ts: host checks plus the `container.image`/`--image` refusal) runs in
  `startOrResume` before the `pre-container-create` hook and the blueprint snapshot, so a refused mode
  builds nothing, runs no hook and pushes nothing (lifecycle keeps its own check as defence in depth).
  Resume refuses (StartError `dind`) a container recorded `privileged` once `allowPrivileged` is no longer
  true, and a `sysbox` one when the daemon lost the runtime (`checkRecordedDind()`); the remove/prune guard
  will not start a stopped privileged container without `allowPrivileged` (fails closed: `--force` only).
  `contextName()` failing no longer blocks DinD (messages say `?`). The real DinD Docker test is
  `it.skip` when it cannot run, so it shows as skipped. Docs: `privileged` lets the agent become root on
  the Docker host/VM with no vulnerability needed; OrbStack and default Colima share the home too (only
  Desktop is refused); sysbox is a kernel-escape boundary, not a network one; `--rebuild` reuses the
  sandbox base under the DinD image; `kunj ct prune` removed from "not yet supported".

## 2026-10-23 — Containers: `kunj ct prune` (phase 2, Task 4)

- New `src/lib/container/prune.ts`: `planPrune()` builds a serialisable `PrunePlan` (`containers` with
  reason `branch-gone`/`age`, guard and `kept` reason; `orphans`; `images`; `bytes`; `warnings`) and
  `applyPrune()` carries it out, reporting `removed`/`failed` and carrying on after a failure. Why: phase 2
  spec section 4, so merged branches' containers, leftovers and old images do not pile up in Docker.
- Branch gone = not in one `git ls-remote --heads origin` (no prompt, 15 s timeout). Origin unreachable:
  nothing is removed for that reason and the plan carries a warning (fail safe). Such a container is
  removed only when `inspectForRemove`/`describeGuard` is clean (or `--force`), through `removeContainer`,
  with the `pre/post-container-delete` hooks; otherwise it is listed as kept with the reason. Snapshot
  build containers (`<branch>:snapshot`) are left alone.
- Orphans are matched by the `kunj.repo`/`kunj.branch` labels, never by name: helpers, services, volumes and
  networks whose branch has no main container. This resolves the Task 1 finding about services left after
  a `docker rm` of the branch container. Volumes kept by `remove --keep-volumes` count as orphans (documented).
- Images: snapshots whose `kunj.blueprint.hash` is not the current hash (the command's `currentHash()`,
  the same computation `list` and `start` use; unknown hash keeps them all), and `kunj-sandbox`/
  `kunj-nethelper` tags other than this version's; an image any container uses is never removed. Sizes
  from `listImages`, each image once.
- `ContainerBackend` gains `listVolumes`/`listNetworks` (ls, then one inspect for exact labels, because
  ls mangles a label containing a comma) and `listImages(filter, { references })`.
- `kunj ct prune [--all] [--dry-run] [--force] [--yes]`: plans every repository first (`--all` runs each
  from its own directory over `~/.kunj/repos.json`), confirms once with inquirer (lazy), then applies.
  Dry run is the default when stdout is not a TTY unless `--yes` (keeps the guard) or `--force`; without
  that a script could never prune. `--json`: `{ success, dryRun, plan, removed, failed }`.
- Stale `~/.kunj/container-forwards.json` entries (containers that no longer exist) are dropped after a prune.
- New setting `container.pruneAfterDays` (default 0 = off). `kunj ct list` gains `orphans: [{ kind, name }]`
  in JSON and an `orphans:` line in text.
- Docs: README, docs-site containers commands (`prune`, list orphans) and configuration pages, regenerated
  reference JSON, CLAUDE.md Branch Containers paragraph.
- Fix round 1 (review): only `--yes` or the confirmation is consent. `--force` skips the guard and nothing
  else, and `--json` or a missing TTY without `--yes` means a dry run. The guard runs again in `applyPrune`
  before the pre hook, so commits made after the plan (or while the prompt waits, or during `--all`) keep the
  container, which is reported in `failed`. Volumes without a main container are listed as kept ("volume
  without a container; use --force to remove") because they can hold unpushed work that no guard sees.
  "Gone" now means missing from ls-remote *and* present as `refs/remotes/origin/<branch>` in the clone: the
  guard script gained an `@@remotes` section (`RemoveGuard.originBranches`), so a `start -c` branch that was
  never pushed is not gone, and a container that cannot be inspected is not gone either. An empty ls-remote
  answer counts as unreachable. `mergePlans`/`removalCount` moved to prune.ts. Why: the reviewer's
  data-loss findings on the removal path.

## 2026-10-23 — Containers: `kunj ct forward --auto` (phase 2, Task 3)

- New `src/lib/container/autoforward.ts`: `parseSsListen()` reads `ss -ltnH` (IPv4, IPv6, wildcard and
  loopback listeners; skips Docker's embedded DNS on 127.0.0.11 and addresses the tunnel cannot reach
  through 127.0.0.1), `diffPorts()` (never < 1024 or `container.forward.ignore`), and `runAutoForward()`,
  which polls with one exec every 2 s, forwards new listeners with `forwardPort` and drops gone ones, and
  returns when the container is no longer running (state polled every 5 s through the new
  `ContainerBackend.containerState()`). Why: phase 2 spec section 3, so a dev server the agent starts is
  reachable without knowing its port in advance.
- `forwardPort` takes `nextFree`: when the container's port is taken on the host, the next free one above
  it is used rather than any port, so the host port stays recognisable. Forwards only listen on 127.0.0.1.
- Forward registry `~/.kunj/container-forwards.json` (`{ pid, container, port, hostPort, kind: 'forward' }`,
  port 0 marking a running forwarder): dead pids pruned on every read via `process.kill(pid, 0)`, writes
  go to a temp file and are renamed, because several forwarders write it at once.
- `kunj ct forward [branch] --auto [--detach]`: one line per change (`--json`: NDJSON
  `{ event, port, hostPort }`); `--detach` re-runs kunj in the background (`process.execPath`, detached,
  stdio ignored, unref'd) and registers its pid (`--json`: `{ success, branch, pid }`).
- `kunj ct agent` starts a detached auto-forwarder unless `container.forward.auto` is `false` (new
  setting, default `true`) or one is already registered for the container. Why: spec decision; the
  agent's servers should just work.
- `kunj ct list --json`: `ports` gains `kind: 'forward'` entries with `pid` (additive).
- New settings `container.forward.auto` and `container.forward.ignore` (a list, or the single number
  `config --set` stores). README, docs-site containers pages (commands, configuration, overview,
  security), the generated reference JSON and CLAUDE.md updated.
- Fix round 1 (review): the listener source is now `cat /proc/net/tcp /proc/net/tcp6`
  (`parseProcNetTcp()`, replacing `parseSsListen()`), because `ss` (iproute2) is missing from most
  devcontainer images (e.g. `node:20`) and the forwarder then polled forever and forwarded nothing,
  silently. The output counts when it has the header, so a kernel without IPv6 (cat exits 1) still
  works; when it cannot be read `onError` warns once each time reading starts failing. Ports bound
  only on `::1` are no longer forwarded (the tunnel connects to 127.0.0.1, so they could never work).
  The forwarder now exits only after two state checks in a row see the container not running, so one
  failed `docker inspect` no longer ends it. `spawnDetached` runs the package's `dist/index.js` when
  `argv[1]` is a `.ts` file (ts-node). Each registry write rewrites the forwarder's own entries from
  memory (marker + live ports), repairing an update lost to a concurrent writer.

## 2026-10-23 — Containers: `kunj ct open` (phase 2, Task 2)

- New `src/lib/container/editor.ts`: the attached-container URI (`vscode-remote://attached-container+<hex>/workspace`,
  hex of `{"containerName":"/<name>"}`), the VS Code and Cursor `imageConfigs` directories (macOS, Linux,
  Windows) and `writeImageConfig()`, which merges `remoteUser` and `workspaceFolder` into the per-image file and
  leaves a file with comments alone. Why: the Dev Containers extension takes the user and folder of an attached
  container from that file, so the window opens as the sandbox user in `/workspace`.
- File name escaping copied from the extension (checked in 0.470.0): only `:`, `/` and `%` become
  `%<lowercase hex>` (`kunj-sandbox%3a1.2.3-abc.json`); it is not `encodeURIComponent`, whose `%3A` the
  extension would not decode on a case-sensitive file system.
- `kunj ct open [branch] [--new-window]`: resumes a stopped container through the same routine as `start`
  (extracted as `startOrResume()`), writes the image config, then launches `worktree.editorCommand` with
  `--folder-uri` via `openWorktree()`/`buildOpenCommand()` (which now take several arguments, and
  `isVSCodeLike()` is exported). Other editors get the `docker exec` command printed; allowlist mode warns
  about the marketplace/update domains. `--json`: `{ success, branch, name, editor, uri }`. Why: phase 2
  spec section 2.
- README, docs-site containers pages and the generated command reference updated.
- Fix round 1 (review): `open` prints `EDITOR_CREDENTIALS_WARNING` (JSON: `warning`), because an attached
  Dev Containers window copies the host gitconfig, installs a host-backed git credential helper and forwards
  the SSH and GPG agents into the sandbox. It names `dev.containers.copyGitConfig: false` and
  `dev.containers.gitCredentialHelperConfigLocation: "none"`; the 0.470.0 bundle has no setting for SSH/GPG
  forwarding, so the warning says so. Why: that channel breaks "origin is the only channel in and out".
  `open` now only resumes (start's --rebuild/--create/--image/--publish are not passed on); the printed
  `docker exec` line uses the same shell as `kunj ct shell`; docs narrowed to VS Code and Cursor (the only
  editors whose config dirs are written and that run the extension), the other-editor JSON shape is
  documented; CLAUDE.md says `open` exists and how it works.

## 2026-10-23 — Workspace IDE: research and design spec

- Added `docs/superpowers/specs/2026-10-23-workspace-ide-design.md`, mirroring the Claude Doc "Kunj Workspace
  IDE Spec" (environment list on the left, every terminal/agent/editor for the selected environment on the
  right). Why: user asked for a spec for a custom IDE for containers and worktrees with the runtime options
  researched and compared.
- Compared Electron, Tauri 2, Eclipse Theia, an embedded VS Code server and native SwiftUI; recommends
  Electron in `workspace-app/` importing kunj's library, xterm.js + node-pty, Monaco diff editor, tmux for
  agent persistence, VS Code as the hand-off. Not approved yet; no plan.
- Decision (user): the app drives the installed `kunj` CLI through `--json` instead of importing `src/lib`,
  so the GUI, the VS Code extension and the macOS app share one contract and cannot drift from the CLI.
  VS Code's remote protocol is not used: it is internal to Microsoft's VS Code, and VS Code attaches to
  kunj containers on its own over `docker exec`, so kunj maintains no second protocol.

## 2026-10-23 — Specs saved to disk in `docs/specs/`

- Added `docs/specs/{container-system,branch-containers,blueprints,container-phase-2,workspace-ide}.md` plus a
  README index: on-disk copies of the five Claude Docs (umbrella spec, phase 1, blueprints, phase 2, workspace
  IDE). The first four were rebuilt from the edits made through Claude Code because the docs live in another
  organization than the session; the IDE spec is a direct export. Why: user wants to start clean sessions from
  files, not from docs the session may not be able to reach. Drawings are noted in italics.

## 2026-10-23 — Container spec: workspace IDE as phase 3

- CLAUDE.md (Branch Containers) and the phase 2 design now name the workspace IDE as phase 3, after phase 2,
  pointing at docs/superpowers/specs/2026-10-23-workspace-ide-design.md and stating the rule that it drives
  `kunj … --json` and never imports `src/lib`. Why: user asked for the full container spec to include the IDE,
  to be built once the current phase 2 work is done.

## 2026-10-23 — Containers: sidecar services (phase 2, Task 1)

- New `src/lib/container/services.ts`: services from the blueprint's `services`, `container.services`
  and the devcontainer's `dockerComposeFile` (first wins by name), validated (names `[a-z0-9-]`, image
  required, named volumes only), ordered by `dependsOn` (cycles rejected). Why: branches need their own
  Postgres/Redis, reachable by name, isolated per branch.
- Each service runs as `<container>-svc-<name>` on the branch network with `--network-alias <name>`,
  only its declared env and named volumes, no added capabilities, no privileged, no published ports,
  no firewall helper. Why: the image is chosen by the branch, so it must get nothing from the host.
- Compose files are parsed by `docker compose config --no-interpolate` on stdin (new backend method
  `composeConfig`, empty project dir, stripped env), so real YAML works with no new dependency;
  dangerous keys, bind mounts, published ports and host variables are dropped with one warning.
- `startContainer` starts services after the network and before the branch container and waits for
  each health check (2 s / 120 s, then a warning); they are in the rollback list. Resume starts stopped
  services, stop stops them, remove deletes them and their volumes. Snapshot builds start them too, so
  `setup` can run migrations; they go with the temporary container.
- `kunj ct logs [branch] [service] [--follow]` (backend `logs`), `kunj ct forward <branch> <svc>:<port>`
  (tunnels into the service with socat, bash or nc, refuses without any), `list --json` gains
  `services: [{ name, state, port }]`, `start` reports `services`. `container.services` is registered;
  `kunj config` prints object values as JSON.
- Tests: services unit tests, lifecycle (order, rollback, resume, stop, remove, compose import, snapshot
  build), command (list JSON, logs, forward), Docker (reachable from its branch only, no host
  privileges/env, forward, migration during a snapshot, nothing left labelled).
- Review fix round 1: image references are validated (no leading `-`, no spaces) in blueprint and
  config services, compose services (dropped with the warning), devcontainer `image`, `--image` /
  `container.image`, and in `runArgs` as a last line of defence. Why: the image is the first
  positional of `docker run`, so `--privileged` as an image became a flag. Compose files with
  `include` or an `extends` naming a file are refused before `docker compose config` (they read host
  files, e.g. another project's passwords). `findServices` now matches services by `kunj.repo` and
  `kunj.branch` labels, not only the name prefix, so a branch named like `<x>-svc-y` cannot make
  stop/remove touch another branch's services. Also: resume starts services dependencies first
  (`dependsOn` recorded in the label), compose `entrypoint`/`user`/`working_dir`/`tmpfs` and
  relative volume targets are reported as dropped, sub-second health timeouts print correctly.

## 2026-10-23 — User docs site (MDX, Astro Starlight) in `docs-site/`

- Added `docs-site/`: an Astro Starlight site (MDX pages) with 40 pages covering getting started,
  branches, commits/PRs, worktrees, containers, work logs, configuration, integrations and a reference.
  Why: user asked for user docs on an MDX system, written by going through everything.
- `docs-site/scripts/gen-reference.cjs` loads the CLI's TypeScript sources and writes
  `src/data/{commands,settings,hooks}.json`; the `CommandReference`, `SettingsTable` and `HookTable`
  components render them, so option/setting/hook tables come from the code and cannot drift.
  Why: hand-written option tables in the old READMEs had gone stale.
- Pages were checked against `src/`, not the old markdown docs, and describe what the code does today
  (several old docs were wrong: `kunj config set`, `jira branch`, completion of options, etc.).
- `.github/workflows/pages.yml` now builds the docs (Node 22, Astro needs >=22.12) and publishes them at
  `/kunj/docs/` next to the landing page; it also redeploys on changes to commands, settings and hook
  definitions. The landing page and README link to the docs; CLAUDE.md has a "User Docs" section.

## 2026-10-23 — Sandbox: default zsh config and KUNJ_* env (Task 11)

- Added `src/container/sandbox/zshrc` (installed as `/etc/zsh/zshrc`: history, compinit, prompt with branch, aliases, no first-run wizard, sources `/etc/profile.d/*.sh`) and `KUNJ_CONTAINER/KUNJ_BRANCH/KUNJ_REPO` in the main container env (after `containerEnv`, so a branch cannot spoof them). Why: the home is a volume, so defaults must live in the image; shells should show which branch they are in.

## 2026-10-23 — Merged branch containers + blueprints to main

- Fast-forwarded `main` to `feature/blueprints` (2ee7853): phase 1 of `kunj container` (PR #15) plus
  blueprints Tasks 1–10. Why: user asked to merge. Still open: Task 11 (zsh defaults, KUNJ_* env)
  and a final whole-branch review of the blueprint work.

## 2026-10-23 — Blueprints: `kunj ct start` builds the snapshot itself (Task 10)

What: before a new container (not on resume, not with `--no-snapshot` or `--image`), `kunj ct start`
resolves the blueprint and calls `ensureSnapshot()` (src/lib/container/snapshot.ts) for the default
branch: nothing when the current snapshot exists; otherwise prints `Building blueprint snapshot (first
use; this runs setup once)…` or `Blueprint changed; rebuilding the snapshot…` and runs
`snapshotBlueprint`. A failed build never fails the start: it warns and falls back (to the stale
snapshot when one exists, else tools + `setup` in the container). The command passes the same
blueprint and `snapshotHandled: true` to `startContainer`, so lifecycle prints no hint of its own.
`resolveBlueprint` gains `repoRoot`: the working tree's `.kunj/blueprint.json` (`source: 'worktree'`)
now wins over origin and the host copy, so `start`, `blueprint status`/`snapshot` and `list` work
before the file is pushed; the "commit and push it" hint is gone, `init` now says
`Next: commit .kunj/blueprint.json; kunj ct start <branch> builds the snapshot on first use`.
`maintain` is skipped right after `setup` in the same run (`provisionNew` reports `setupRan`), and
npm's inferred `maintain` is `npm install` (also in kunj's own blueprint).
Why: users should not have to know about `kunj ct blueprint snapshot`; the flow is `init` → `start`.
`npm ci` as maintain wiped node_modules on every start (~16 s), and running maintain right after
setup repeated the install.

- Tests: blueprint (worktree file wins), snapshot (`ensureSnapshot` build/exists/stale keep vs
  rebuild/failure), lifecycle (maintain skipped after setup, still after presets-only, hints
  silenced by `snapshotHandled`, `worktreeRoot`), command (ensure before start with the same
  blueprint, stale, failure fallback, `--no-snapshot`/`--image`/no blueprint, resume, unknown
  default branch), infer. Docker: `start with a blueprint and no snapshot builds one and starts from
  it` under a fresh repo id (cleaned up by afterAll too).

## 2026-10-22 — Blueprints: snapshots from a host-made bundle (Task 9)

What: `kunj ct blueprint snapshot` no longer clones origin inside the temporary container. The host
runs `git fetch origin <branch>` with its own credentials, bundles `origin/<branch>` as the single
ref `refs/heads/<branch>` (`makeBranchBundle()` in src/lib/container/snapshot.ts; `git bundle
create` cannot rename refs, so the ref is set in a scratch bare repo that borrows the host's objects
through `objects/info/alternates`), and `startContainer` streams it to `/tmp/kunj-origin.bundle` as
the sandbox user (mode 0600). `seedScript({ bundlePath })` clones it with `--no-checkout -b <branch>`,
sets `origin` back to the real URL, skips the fetch and switches; submodules are then updated from
their own URLs. The bundle is `rm -f`ed in the container before the commit and the host temp dir is
removed in `finally`. With a bundle, start skips the SSH `no-token` refusal and the unpushed gate.
The command's SSH refusal is gone; `--no-bundle` keeps the old in-container clone (public origins).
`SnapshotResult` gains `viaBundle`; text output says "(from a host bundle)".
Why: snapshots forward no env, because a token could reach the committed image (older engines keep
`container_config` Env, and repo-controlled `setup` could write it to disk), so private and SSH
origins could not be snapshotted. The host already has credentials.

- Tests: seed (script shape; real run from a bundle with an unreachable origin URL, re-runnable),
  lifecycle (bundle streamed before the seed with the exact bytes, removed after; gates skipped),
  snapshot (`makeBranchBundle` holds only `refs/heads/<branch>`; cleanup on success and failure;
  `noBundle`), command (SSH origin accepted, `--no-bundle`). Docker: `snapshot via bundle never
  clones from the network` (the host reaches the git daemon through a `core.gitProxy` script, since
  only containers resolve host.docker.internal). The suite's cleanup now lists images with `-a`: a
  rebuilt snapshot under the same tag leaves the old image dangling, which `docker images -q` hides.
- Limits: the bundle is read into memory to build the tar (fine for v1, large repos cost RAM); the
  hash is still computed before the fetch, from the host's existing `origin/<default>`.

## 2026-10-22 — Blueprints: `kunj ct blueprint` and snapshot-started containers

What: a repository's `.kunj/blueprint.json` (`tools`, `setup`, `maintain`, `lockfiles`, `notes`) is
set up once in a temporary sandbox and committed as `kunj-blueprint-<repo>:<hash>` with the checkout
at `/opt/kunj/seed`; new branch containers copy the seed and run `maintain` instead of installing.
Why: Devin-style blueprints, so an agent's container starts with dependencies installed and the
project built.

- Tasks: 1 backend images (commit/list/remove), 2 blueprint file/resolve/hash, 3 root-run presets
  (`src/container/presets/`, `_lib.sh`), 4 inference (`blueprint init`), 5 snapshot-aware start/seed/
  maintain and `--no-snapshot`, 6 snapshot build/status/prune, 7 `kunj ct blueprint init|snapshot|
  status|remove`, 8 Docker tests, docs and kunj's own blueprint. Task 10 (start builds the snapshot
  itself, working-tree blueprint first) follows.
- Review findings that changed the design: tool values reach root-run scripts, so an apt value like
  `-o APT::...` could run code as root; every word is now validated (`TOOL_WORD`) and re-checked in
  the preset. Setup was gated on "seeded", so a kept volume skipped it forever; presets and setup now
  run on every new container without a snapshot. A seed that died mid-copy could be mistaken for a
  checkout, or a checkout wiped; the `.kunj-copying` / `.kunj-fresh` sentinels decide that now.
  Snapshots carry no tokens (no `container.env`, keep files or files in the build container), so an
  SSH or private origin cannot be snapshotted yet.
- Task 8: the Docker suite gained six blueprint tests (snapshot labels, jq from apt, seed contents,
  no secret ENV; start from the snapshot with no clone and maintain run; stale hint; `--no-snapshot`;
  failing setup leaves nothing; `removeSnapshots`). Bug found: Docker 29's CLI appends
  `exit status 1` to `docker network rm` errors, so removing objects already gone threw (the
  snapshot's pre-clean failed on every first run); `LocalDockerBackend.remove` ignores that line.
  Older Docker tests now pass `blueprint: null` so a host copy never leaks into them.
- Tests: `npm test` 21 suites / 361 tests; `npm run test:docker` 15 tests in ~48 s.
- Manual run in this repo: the snapshot needs an HTTPS origin (this one is SSH), so it was built from
  a temporary HTTPS clone of the public repo (same repo id): ~62 s (`npm ci` + `npm run build` +
  `maintain`), image `kunj-blueprint-kunj:1b93f4cc8070`, 361 MB content (1.57 GB with the base).
  `kunj ct start bp-smoke -c` from it took 22 s, 16 s of which is `maintain: npm ci` reinstalling
  `node_modules` from scratch (`npm install` there takes 0.6 s when nothing changed).
- Docs: README `### Blueprints` (file, presets, flow, what a snapshot holds, security notes, kunj and
  driveday_planner examples); CLAUDE.md Branch Containers gains a Blueprints paragraph.
- Deferred: private/SSH origins (Task 9, host-made bundle), lint/test/run commands and `kunj ct test`,
  agent prompting, devcontainer `customizations.kunj`, sidecar services.

## 2026-10-22 — Branch containers: final review fix wave

- Added a `supabase` preset (CLI from GitHub releases into /usr/local/bin; smoke-tested: 2.121.0) and
  inference from `supabase/config.toml`. Why: driveday_planner's blueprint lacked it.

- Blueprints task 5 fix round 2: a snapshot seed wipes and recopies `/workspace` only when there is no `.git` or its own `.kunj-copying` sentinel is left from a copy cut short, and resets the branch to origin's only while `.kunj-fresh` marks an untouched copy. Why: the seed marker is an ignored file `git clean -x` removes, so deciding by it could wipe a user's checkout.
- Blueprints task 5 review fixes: presets and setup run in every new container without a snapshot, also on a kept workspace volume; a seed moves its branch to origin's (`switch -C`) and a partial copy is redone; lockfiles for the hash are read at `blueprintRef()` (blueprint ref, else origin/<default>, else HEAD) so the hash does not depend on the worktree; the no-snapshot hint names only what will run; resume reports no `stale`. Why: review found starts that skipped setup forever, stale checkouts and a cwd-dependent hash.
- Blueprints task 5: start uses the repo's blueprint snapshot (`kind: 'blueprint'`, seed copied from `/opt/kunj/seed`, origin reset; newest snapshot with one stale hint), else runs presets as root and `setup` as the user on a new container; `maintain` every start (warns); `--no-snapshot`/`namesFor`/`presets` start options, `imageKind`/`blueprintHash` in `kunj.options`; blueprint steps in `src/lib/container/provision.ts`. Why: new branch containers start with dependencies installed.
- Blueprints task 3 review fixes: every word of a `tools` value must match `^[A-Za-z0-9][A-Za-z0-9._+:=~@-]*$` at parse time (and apt/java/python/rust/playwright re-check their words), `kunj_env` single-quotes profile exports, `_lib.sh` is part of each preset hash, a missing `kunj_done` result warns, node clears old npm/corepack, and node/go version selection is tested against a fake curl (`KUNJ_PREFIX`/`KUNJ_ENV_FILE`/`KUNJ_PROFILE_DIR` overrides). Why: a blueprint value must never become an option or path in a root command.
- Blueprints task 3: `src/lib/container/presets.ts` (resolve repo/host/built-in presets, order, run as root with env in a file and the version read from `kunj_done`'s result file), `nodejs.org` always allowed by the firewall, preset fixes (go version lookup never matched, node `22.12` picked the newest 22.x, arch helpers yielded "" on unknown machines) and allowlist notes. Why: blueprint snapshots install their `tools` through these scripts.
- Blueprints task 2: `src/lib/container/blueprint.ts` (parse, resolve repo/host/file, lockfile ids, hash, snapshot tag, labels) and blueprint label keys in `LABEL`. Why: the blueprint file and its identity hash feed snapshot, status and start.
- Blueprints task 1: `ContainerBackend` gains `commitContainer`, `listImages` and `removeImage` (docker commit with LABEL changes, image ls + one inspect, tolerant image rm); FakeBackend's tag set is now `existingImages` and `images` holds `ImageInfo[]`. Why: blueprint snapshots are committed, listed and pruned as labelled images.
- Design: blueprints (`kunj ct blueprint init|snapshot|status|remove`) — a repo's `.kunj/blueprint.json`
  (`setup`/`maintain` commands) is run once in a sandbox and committed as `kunj-blueprint-<repo>:<hash>`
  with the tree at `/opt/kunj/seed`; new branch containers copy the seed instead of installing. Why:
  asked for a Devin-style blueprint so containers start with dependencies installed. Spec:
  `docs/superpowers/specs/2026-10-22-blueprints-design.md`; branch `feature/blueprints`.

- UTF-8 in the sandbox: `debian:bookworm-slim` has no locale, so Claude Code and tmux drew box glyphs as
  underscores. The image now sets `LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color`, tmux runs with `-u`,
  and interactive execs pass the host's `TERM`/`COLORTERM` plus `LANG=C.UTF-8`. Why: first real session
  looked broken in the VS Code terminal.

Why: the whole-branch review found one critical and ten important problems (plus five minors) in
`kunj container`; all landed in one pass, one commit per fix.

- Agent container runs with `--cap-drop ALL` plus CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID
  (`ContainerSpec.capDrop/securityOpt`). Why: root inside kept NET_RAW and could bypass the firewall.
- A recorded user of `''` means no `-u` everywhere; the effective user is resolved with `id -un`
  after READY and reported (labels cannot change after `docker run`). Why: images without `dev` broke.
- git-credential-kunj is streamed into `$HOME/.kunj/bin` of every container with a token, and
  `KUNJ_CREDENTIAL_HOST` is host:port. Why: only kunj-sandbox had the helper; git sends the port.
- Origin URL credentials are stripped before anything uses the URL. Why: tokens reached argv,
  `.git/config` and error output.
- Devcontainer image tags are lowercased; kunj-sandbox/kunj-nethelper tags carry a hash of their
  build context. Why: Docker rejects uppercase; edited Dockerfiles/firewall.sh were never rebuilt.
- Failed starts remove exactly what they created (new `volumeExists()`, main container listed
  before `run`); `--keep-on-error` still stops a container whose firewall never came up.
- Firewall accepts origin's addresses on origin's port before the private-range rejects; main
  container gets `--add-host host.docker.internal:host-gateway`. Why: a LAN/host origin could not clone.
- Hook `${...}` quoting follows the shell context (`"${worktree}"` works again).
- Warn before building a Dockerfile changed on the branch (builds have full network access).
- Remove guard fails closed when `git stash`/`git status` fail; create hooks skip on resume;
  README security notes; package.json `files` whitelist.
- Tests: `npm test` 257, `npm run test:docker` 9. Old `kunj-sandbox:1.0.0`/`kunj-nethelper:1.0.0`
  tags removed after the new ones built.

## 2026-10-22 — Implement branch containers, phase 1

Why: executed the phase-1 plan so `kunj container` (alias `ct`) exists end to end.

- 12 tasks: hook quoting fix, settings and hooks, names, devcontainer subset, backend + docker CLI,
  images, seed, lifecycle, forward, command + fast path, docs (this entry, README, CLAUDE.md), Docker
  integration tests.
- Review findings that changed the design: the main container runs `--entrypoint sleep` so no
  image code runs before the firewall is up; the firewall is a network-helper sidecar sharing the
  agent's network namespace (the agent holds no capabilities); names carry a hash suffix and reuse
  checks labels; the git credential helper is scoped to origin's host; `${...}` in `hooks.*` config
  commands is now shell-quoted (users must not add their own quotes).
- Docs: README section "Run a branch in a sandboxed container", CLAUDE.md "Branch Containers", and a
  line in `kunj hooks --help` about quoting.
- Tests: `npm test` 235, `npm run test:docker` 8.
- Deferred to phase 2+: sidecar services, `open`, `prune`/`--auto`, Docker-in-Docker, remote backend
  (`kunj serve`), VS Code extension and macOS app UI.

## 2026-10-21 — Design: branch containers (`kunj container`)

Why: asked for a feature that starts a session for a branch inside a Docker container, like
`kunj worktree` but sandboxed, mainly to run an AI agent with permissions skipped; later the Docker
daemon should be able to live on a remote machine behind a kunj service.

- Wrote `docs/superpowers/specs/2026-10-21-branch-containers-design.md`. Decisions reached in the
  brainstorm: real sandbox (own clone, no bind mounts, origin is the only channel in and out — the
  bundle idea was dropped as unnecessary), image from the repo's devcontainer else a kunj default,
  configurable credential forwarding, optional egress allowlist adapted from Anthropic's reference
  devcontainer, per-branch network with sidecar services, opt-in Docker-in-Docker (sysbox /
  privileged in an isolated VM), port forwarding over `docker exec`, agents in tmux, and a
  `ContainerBackend` interface so a remote backend can be added without redesign.
- Second pass (same day): an adversarial review found 15 issues; verified the two about existing
  code (`branchToDirName` collapses `feature/x`/`feature-x`; `hooks.*` config commands substitute
  `${branch}` as text into a `shell: true` command). Spec revised: hash suffix on names + label
  match on reuse, stronger remove guard, credential helper scoped to origin's host, root refused,
  firewall moved to a network-helper sidecar (agent container has no capabilities), host/LAN
  blocked by default, AWS keys only with Bedrock, DNS pinned, allowlist re-resolved, privileged
  needs an explicit setting, hook quoting fix as a prerequisite, idempotent seed, prune/`--auto`
  moved to later phases. A "what the sandbox does and does not protect" table was added.
- Spec approved. Wrote the phase-1 implementation plan
  `docs/superpowers/plans/2026-10-21-branch-containers-phase-1.md` (12 tasks: hook quoting fix,
  settings/hooks, names, devcontainer subset, backend + docker CLI, images, seed, lifecycle,
  forward, command + fast path, docs, Docker integration tests).
- Added `src/lib/container/names.ts` (+ tests): repo id from remote URL, hashed container/volume/network names and `kunj.*` labels, because `branchToDirName` collapses `feature/x` and `feature-x` and repo names can repeat.
- Added `src/lib/container/backend.ts` (`ContainerBackend` interface) and `docker.ts` (`LocalDockerBackend`, + tests): the single seam to Docker so lifecycle/forwarding/command code can be faked and a remote backend added later; docker is spawned with argv only, env goes through a 0600 `--env-file` so secrets stay out of `ps`, and a listing costs two subprocesses.
- Added `src/lib/container/image.ts` (+ tests), the `kunj-sandbox` (Debian, no sudo, uid 1000 `dev`, origin-scoped `git-credential-kunj`) and `kunj-nethelper` (Alpine + iptables/ipset `firewall.sh`) build contexts in `src/container/`, and `scripts/copy-container-assets.js` in `npm run build`: image resolution (setting, devcontainer hashed by Dockerfile/tree/args, else sandbox), build-on-first-use, and a dependency-free ustar writer, because containers need an image and the firewall must live outside the agent's container so the agent cannot undo it.
- Review fixes to `firewall.sh`: allowlist refreshes only add (a DNS timeout no longer drops a host), a start fails if origin or a required host does not resolve, `host.docker.internal`/`gateway.docker.internal`, 100.64/10 and 0/8 are blocked too, IPv6 without ip6tables refuses to start, a restarted helper swaps fresh sets in instead of flushing the live ones, and only connect-type curl errors count as "example.com blocked".
- Added `kunj container` (alias `ct`; `src/commands/container.ts` + tests) on the fast path: start/shell/exec/agent/attach/forward/list/stop/remove over the container library, `{ error: { code, message } }` in `--json`, `aliases`/`allowUnknownOption` in `CommandConfig`, `getVersion()` moved to `src/lib/version.ts` and `getOriginUrl()`/`getRepoCommonDir()` exported from config, so the branch containers have a user-facing command that lists in ~0.1 s without loading AWS.
- Added Docker integration tests (`src/lib/container/__tests__/integration.docker.test.ts`, `npm run test:docker`, excluded from `npm test`) against a `git daemon` origin, and fixed the allowlist's origin check, which only probed 443/22 and so refused any origin on another port: `KUNJ_FW_ORIGIN_PORT` (from `originPort()` in seed.ts) is now probed first, because this was the first end-to-end run of `kunj container` against real Docker.

## 2026-10-16 — Remove several worktrees at once (VS Code + macOS app)

Why: asked to multi-select worktrees to delete in both the macOS app and the VS Code extension.

- VS Code (`vscode-extension/src/extension.ts`, `package.json`): the Worktrees tree has
  `canSelectMany`; "Remove Worktree…" (inline trash or context menu) removes every selected
  worktree when the clicked one is part of the selection. From the command palette or the view's
  `…` menu it opens a multi-select quick pick. The main worktree and worktrees open in this window are
  skipped (and named in the confirmation). One modal lists every worktree with its warnings (open
  elsewhere, uncommitted changes); open/dirty ones are force-removed, and those git still refuses
  are offered a single "Force Remove" afterwards. The command is no longer hidden from the palette.
- macOS app: a checklist toggle in the panel header (or ⌘-click a row, or "Select" in a row's
  context menu) enters selection mode — rows show checkboxes (main cannot be checked), clicking toggles,
  and the footer shows "N selected" with Cancel and "Remove N Worktrees…". `AppStore.remove(_:)` now
  takes a list (the single remove goes through it): one confirmation, sequential removal, rows show
  "Removing…", one force prompt for refusals, one summary flash. Closing the panel leaves selection mode.
- `Support/Snapshot.swift` also renders `rows-selecting-light/dark.png`.
- Verified: extension builds and type-checks; macOS app builds, Swift tests pass (49), snapshots
  checked in light/dark, app reinstalled. Not clicked through live (removing real worktrees).

## 2026-10-15 — Organize Windows removes empty desktops

- After arranging, Organize Windows removes every desktop that has no window on it, on every attached
  display, last to first; each display's current desktop always stays. Why: asked for the rearrange to
  delete the empty desktops it leaves behind.
- "Empty" (`emptyDesktops()` in `KunjBarCore/EmptyDesktops.swift`, 4 tests): no ordinary (layer 0)
  window of any app is on it, minimized and off-screen windows included, read with
  `CGWindowListCopyWindowInfo` + `CGSCopySpacesForWindows` (`Spaces.spacesOfAllWindows()`). A window on
  several spaces (assigned to all desktops) keeps none of them alive.
- `MissionControl.removeDesktop()`: opens Mission Control, hovers the desktop's button and uses its
  remove action when it has one, else presses the close button that appears on hover (found near the
  button by its title/description/subrole), then polls until the space is gone. A failure is logged and
  stops removal on that display; the rest of the run is unaffected. Remembered desktops that were removed
  are forgotten.
- Settings → Organize: "Remove empty desktops afterwards" (on by default). The finish message adds
  "removed N empty desktops".
- Not verified live: running Organize moves the user's windows and needs a click in the menu, so the
  Mission Control removal (which button/action macOS 26 exposes) still has to be tried by hand; the log
  window shows what happened.

## 2026-10-15 — Release v1.2.0

- Tagged v1.2.0: the macOS app's Organize Windows (desktops per worktree pair, tiled editor/terminal
  windows) and the open worktree switcher (⌥⌘K, coloured PR badges). Minor bump because both are new
  features. Why: asked to push and create a new release.

## 2026-10-15 — Open worktree switcher (global hotkey) in the menu bar app

- `macos-app/Sources/KunjBar/Support/HotKey.swift`: system-wide shortcut through Carbon's
  `RegisterEventHotKey` (no Accessibility / Input Monitoring permission needed) and a `Shortcut` type
  that displays itself (e.g. "⌥⌘K") using the current keyboard layout.
- `Support/Switcher.swift` + `Views/SwitcherView.swift`: the shortcut (default **⌥⌘K**) toggles a
  borderless, non-activating panel centred on the screen with the mouse (a little above the middle,
  like Spotlight), on the current desktop or full-screen space. It lists only worktrees open in an
  editor, across every repository; ↑/↓ move the selection (wrapping), ↩ or a click opens it
  (`AppStore.open`, which brings the existing editor window forward), esc or clicking elsewhere closes
  it, and pressing the shortcut again hides it. It refreshes the listing when shown and follows the store
  while visible. Why: asked for a hotkey that lists only open worktrees in the middle of the screen,
  usable with arrow keys + Enter or the mouse.
- Settings: "Open worktree switcher" section with an on/off toggle and a shortcut recorder (click, press
  a shortcut with ⌘/⌥/⌃; esc cancels; Reset returns to ⌥⌘K). The hotkey is suspended while recording.
  If another app owns the shortcut, the panel flashes a message instead of failing silently.
- The switcher's PR badge uses the panel's `PullRequestBadge`, so it is coloured the same way (green checks
  passing, red failing, amber pending, purple merged, outlined for drafts/closed), with a white outline on
  the selected row; clicking it opens the PR. Why: asked to show the PR colour in the switcher.
- `Support/Snapshot.swift` also renders `switcher-light/dark.png`; `SwitcherView(scrolls: false)` exists
  because ImageRenderer draws nothing inside a ScrollView.
- Verified: builds, snapshots render in light and dark mode, app reinstalled. The hotkey itself could
  not be pressed from the agent (osascript has no permission to send keystrokes) — needs a manual try.

## 2026-10-14 — Organize Windows in the menu bar app

- `macos-app/Package.swift`: a `KunjBarCore` library target for the pure decisions and a
  `KunjBarCoreTests` target (swift-testing; the Command Line Tools have no XCTest). `scripts/test.sh`
  runs them with the SDK that has the macro plugins and clears the module caches when a failed
  compile leaves "plugin for module 'TestingMacros' not found" behind.
- `Sources/KunjBarCore/`: `Layout`/`WindowKind` and `slots()` (left/right or above/below halves,
  one kind fills the screen), `fits()` (4 pt tolerance), `axFrame()` (Cocoa → Accessibility
  coordinates); `matchWindows()` (document path first, then the title as a whole path component,
  longest worktree name first); `chooseDesktop()` (keep / remember / create); `resolveScreenName()`
  and `placements()`. 30 tests.
- `Sources/KunjBar/Support/AXWindows.swift`: the editor (VS Code, Cursor, VSCodium, Windsurf) and
  terminal apps' windows through Accessibility, frames, raise, un-minimize. `Spaces.swift`: desktops
  per display, the current one, and which desktop a window is on, through SkyLight's read-only
  `CGSCopyManagedDisplaySpaces` / `CGSCopySpacesForWindows` (dlsym). `MissionControl.swift`: add a
  desktop, switch to a space and drag a window thumbnail onto a desktop by driving Mission Control's
  Accessibility tree in the Dock (probed on macOS 26: `mc > mc.display > mc.spaces > mc.spaces.list`,
  `mc.spaces.add`, `mc.windows`), with a mouse-click fallback when a press changes nothing.
- `Organizer.swift`: the run. Accessibility lists only each display's current desktop, and the
  remote-token trick (`_AXUIElementCreateWithRemoteToken`) answers nothing on macOS 26, so when the
  window server knows of more windows the organizer visits the other desktops and switches back.
  Full-screen windows are left alone. Per worktree: keep its desktop when its windows already share
  one, else the remembered one, else a new one; windows on another display get a frame on the chosen
  screen, windows on another desktop of the same display are raised and dragged in Mission Control;
  then each window gets its slot unless it already fits. `AppStore.organizeWindows()` runs it off the
  main actor and flashes the outcome; the ⚙ menu has **Organize Windows**; Settings has an Organize
  section (screen, layout, editor/terminal toggles). Why: asked for the mac app to create desktops
  and organize the windows, as a separate action from opening, keeping windows that already fit.
- `scripts/bundle.sh`: `CODESIGN_IDENTITY` signs with a named certificate so the Accessibility
  grant survives rebuilds (ad-hoc signatures change every build; a stale TCC row for the bundle id
  had to be cleared with `tccutil reset Accessibility dev.kunj.KunjBar`). A self-signed "Kunj Dev"
  identity lives in `~/Library/Keychains/kunj-dev.keychain-db` on this Mac.
- Full-screen windows are organized too: discovery visits full-screen spaces as well, a matched
  window gets `AXFullScreen` set false and is moved once it is back on a desktop. `arrange()` puts
  two windows of one kind on the two halves (editors and terminals keep their own half when both are
  present; a lone window fills the desktop). `fits()` allows a character cell (16 pt) of slack
  because Terminal snaps to whole cells and was re-placed on every run. Why: the first run left one
  window per desktop and skipped the full-screen ones, which was not what was wanted.
- Two windows per desktop, not one worktree per desktop: `groupWindows()` cuts each worktree's
  windows (editors first) into pairs and pairs the leftover single windows across worktrees; the
  organizer works per pair (keep / remembered / new desktop, each worktree in the pair remembers it)
  and the flash counts windows and desktops. Why: asked for two per desktop, several times; the
  per-worktree rule left one window per desktop when a worktree had no terminal.
- `worktreeEntries()`: editor windows that match no listed worktree take part as their own entry
  (keyed `window:<id>`), so they pair up too; terminals outside every worktree are still left alone.
  Why: a VS Code window for an unlisted folder sat alone on its desktop.
- Verified by hand on this Mac (macOS 26, two displays): a desktop added on the external screen,
  switching, one worktree kept its desktop and the other got a new one with its editor dragged there
  and placed on the left half; a second run moved nothing.

## 2026-10-14 — Organize Windows design spec

- `docs/superpowers/specs/2026-10-14-organize-windows-design.md`: design for an **Organize Windows**
  action in the menu bar app: one desktop per worktree on a chosen screen, editor on one half and
  terminal on the other, with Settings for the screen, the layout and which kinds to include.
  Windows already in place stay put; desktops are remembered per worktree so a rerun reuses them.
  Driven through the Accessibility API and Mission Control, with read-only SkyLight calls to learn
  which desktop a window is on. Why: asked for the mac app to create desktops and organize the
  windows, as a separate action from opening a worktree. No code yet; the plan comes next.

## 2026-10-08 — Still no colour; live CLI output in New Worktree

- A brand-new window still had `NO_COLOR=1 FORCE_COLOR=0`. Cause: the Kunj app itself had them. It was
  relaunched by `bundle.sh --install` from a Claude Code session in a window that still had them, and `open`
  passes its environment to the app, which passed it to kunj, then to VS Code, then to the terminals.
  Fixes: the app removes both variables from kunj's environment (KunjCLI.swift), and `bundle.sh` relaunches
  the app without them.
- New Worktree window shows a terminal-style box with what the CLI is doing, live. `kunj worktree add` now
  reports progress (creating, fetching the base, branching from, git's own output, keep files restored) - on
  stderr in `--json` mode so stdout stays one JSON document; hook output already went to stderr there. The app
  streams stderr through a new `onOutput` callback on `run()`.
- Released as v1.1.4.

## 2026-10-08 — New Worktree in a bare repository: "Could not list branches"

- `getGitRoot()` (src/lib/git.ts) used `git rev-parse --show-toplevel`, which fails in a bare repository, so
  `kunj list` found no branches and the macOS app's New Worktree sheet showed "No branches found". It now falls
  back to the repository directory (`--absolute-git-dir`) when the repository is bare.
- `kunj list --json` printed plain text when there were no branches; it now prints `{"branches": []}`.
- Released as v1.1.3.

## 2026-10-08 — Colour in editors opened by KunjBar, click feedback

- The macOS app and VS Code extension no longer run kunj with `NO_COLOR=1 FORCE_COLOR=0`. `kunj worktree open`
  inherited them and VS Code handed them on to every terminal in the window, so tools there (e.g. Claude Code)
  lost all colour. Instead the CLI turns chalk off itself whenever `--json` is passed (src/index.ts), which
  also covers an inherited `FORCE_COLOR=1` - chalk already skips colour when output is piped.
- macOS app: clicking a worktree row now shows it was clicked — the row tints blue and shows "Opening…" with a
  spinner until the open finishes (at least 0.6s so it is visible). Repeat clicks while opening are ignored.
  A first version also tracked the mouse-down with a `DragGesture(minimumDistance: 0)`; that swallowed the
  row's tap so clicking opened nothing, and it was removed.
- The spinner replaces the row's icon and stays until the editor registers its session (the worktree turns
  "open"), up to 15s, instead of disappearing as soon as the CLI returns.
- Released as v1.1.1.
- macOS app: the panel closes after clicking a worktree, "Open in New Window" or "Open Terminal"
  (`MenuBarAnchor.closePanel()`). Released as v1.1.2.
- Colour was still missing in a window opened at 10:51: the installed VS Code extension was the old build,
  which still set NO_COLOR when it ran `kunj worktree open`. Reinstalled it from the repo. VS Code itself
  doesn't need restarting (its main process never had the variables); only windows opened before the fix do.

## 2026-10-07 — Release v1.1.0

Released everything since v1.0.1 so `kunj repos` / `kunj install` reach npm and the release carries the
macOS app zip (`kunj install macos` needs a release that has one).

- `kunj repos` — registry of repositories kunj has been used in (`~/.kunj/repos.json`), so the macOS app can discover them.
- macOS menu bar app (`macos-app/`) — same features as the VS Code extension; open worktrees first and highlighted,
  "Open only" toggle, adaptive light/dark palette, panel stays pinned under the menu bar when it shrinks.
- Release workflow attaches `Kunj-macos-<version>.zip` (unsigned) next to the `.vsix`.
- `kunj install [vscode|macos|all]` — downloads and installs the companion apps; offered at the end of `kunj setup`.
- Also in this release: hooks, new branches from the fetched default branch, `worktree add -c`, config variables,
  bare repository support, keep files.

## Shell-quote hook variables
- `shellQuote` / `expandVariablesQuoted` in src/lib/config-vars.ts; configured hook commands (src/lib/hooks.ts) now
  substitute `${branch}`-style values shell-quoted. Why: a branch name like `x$(cmd)` was executed by the shell.
  Hook commands that wrapped variables in their own quotes now see literal single quotes.
- Container settings (task 2): `container.*` settings (src/settings/container.ts), `container` block in KunjConfig, defaults in src/lib/container/defaults.ts, and four `pre/post-container-create/delete` hooks in hook-defs.ts. Why: foundation for `kunj container`.
- Devcontainer parser (task 4): src/lib/container/devcontainer.ts parses the supported devcontainer.json subset (JSONC, build paths, ports, post commands) and refuses root/0 remoteUser. Why: the file comes from the branch, which an agent can edit, so it must not grant root.
- Devcontainer build paths (task 4 fix): parseDevcontainer rejects absolute or repo-escaping build.dockerfile/context. Why: the file is agent-editable.
- Container seed script (task 7): src/lib/container/seed.ts builds the in-container clone/switch script and runs the host-side origin checks (inspect, ls-remote, push, git identity). Why: the container clones the branch from origin, so the host must know whether it is pushed first.
- Container lifecycle (task 8): src/lib/container/lifecycle.ts starts (origin/push checks, image, network, volumes, container, network helper, seed after the firewall is ready, keep files, devcontainer post commands, rollback), resumes, stops, removes behind an unpushed-work guard and reports per-container status; pure env/firewall/parsing helpers in src/lib/container/env.ts, FakeBackend for tests. Why: the orchestration `kunj container` start/stop/remove/list sit on.
- Container lifecycle fixes (task 8 review): the main container runs with `--entrypoint sleep` (new `ContainerSpec.entrypoint`), nothing is exec'd in it before the network helper is ready (start, resume and the remove guard share one bring-up), resume no longer requires the branch on origin, and the remove guard counts a detached HEAD and failed rev-lists as unpushed and runs git with fsmonitor/hooks off. Why: code from the branch could open connections before the firewall existed, and the guard had false negatives.
- Port forwarding (task 9): src/lib/container/forward.ts listens on 127.0.0.1 and tunnels each connection through `docker exec -i <ctr> socat` (bash /dev/tcp fallback), with port-spec parsing and free-port lookup; FakeBackend's stdin reader no longer attaches an error listener, matching docker.ts. Why: `kunj ct forward` reaches container ports without publishing them, and a reset client must not crash the CLI.
- Port forwarding fix (task 9 review): each connection feeds exec through a PassThrough that is ended when the socket closes, and FakeBackend's stdin reader finishes only on 'end' and records `stdinEnded`. Why: a reset or destroyed socket never emits 'end', so the piped `docker exec`/socat kept running and could hold the CLI open.
- Blueprint inference (task 4): src/lib/container/infer.ts `inferBlueprint()` reads package manager, node/python/go/rust/ruby, .tool-versions, playwright and Makefile hints from the checkout into a draft blueprint with one reason line per decision; `TOOL_WORD` is now exported from blueprint.ts. Why: `kunj ct blueprint init` needs a starting blueprint.
- Inference fixes (task 4 review): .nvmrc/.node-version detection no longer depends on package.json, .tool-versions lookup uses Object.hasOwn, and tests cover malformed package.json, bun.lockb, yarn berry/classic, engines ranges. Why: nvmrc was skipped for malformed package.json and `constructor 1.0` wrote a bogus tool.

## 2026-10-22
- Blueprint snapshots (task 6): src/lib/container/snapshot.ts builds a snapshot (temporary `<branch>@snapshot` start with no env/keep files/hooks, seed copied to /opt/kunj/seed as root, /etc/kunj/env turned into image ENV, commit, temp container always removed, older snapshots pruned), plus `snapshotStatus`/`removeSnapshots`; `baseImageTag()` exported from lifecycle, `commitContainer` takes extra `--change` lines, presets report versions through StartResult. Why: `kunj ct blueprint snapshot` needs to build once and reuse, hashing exactly like a start.
- Snapshot review fixes (task 6): a leftover `<branch>:snapshot` container and its volumes are removed before the snapshot starts, the ref label is the commit checked out in the container, temp names use `:` (invalid in branch names), `ignoreForwardPorts` binds no host port, `removeSnapshots` warns and continues, a reused snapshot reports its ref label. Why: an interrupted run could otherwise commit an old checkout, and the host's origin ref may be stale.
- `kunj ct blueprint` (task 7): src/commands/container.ts gains `blueprint init|snapshot|status|remove`, `--no-snapshot`, `--global`, `--yes`, `--blueprint <path>`, a blueprint line in the start summary and `imageInfo: { tag, kind }` + `blueprint: { hash, stale }` in `ct list --json`; `planSnapshot()` split out of snapshot.ts so status and list hash exactly like a snapshot. Why: the commands that make and inspect blueprint snapshots; an SSH origin is refused until private origins land (task 9).
- `kunj ct blueprint` review fixes (task 7): one `computeBlueprintHash()` in blueprint.ts used by start (lifecycle.ts) and `planSnapshot` (snapshot.ts), pinned by a test; `status`/`snapshot` hint at a `.kunj/blueprint.json` that is not pushed; `init` keeps the overwritten file's `notes`. Why: two hash computations could drift and make every snapshot look stale; an unpushed blueprint was a silent "No blueprint".

## 2026-10-23 (workspace IDE review)
- Workspace IDE spec reviewed against the code and decided (docs/superpowers/specs/2026-10-23-workspace-ide-design.md rewritten; docs/specs/workspace-ide.md Package layout and Decisions updated). Why: the spec assumed tmux sessions named `kunj-<branch>` (the CLI uses `agent` inside containers), read `~/.kunj/container-forwards.json` directly, used `docker cp` for files, never said kunj resolves the repo from cwd, and claimed importable JSON types the package did not publish. Decisions: Electron (macOS only in v1), CLI-only contract (no library import), `kunj agent` for worktrees, `kunj ct file read|write`, ports via `ct list --json`, `kunj events --json` before the app, diff default against the base branch, layout state in `~/.kunj/<repo>/workspace.json`.
- Two plans: docs/superpowers/plans/2026-10-23-workspace-cli-contract.md (JSON types, `kunj agent`, `kunj ct file`, `kunj events`) and docs/superpowers/plans/2026-10-23-workspace-app-v1.md (the Electron app). Why: the CLI additions are useful on their own and must ship before the app can be built against them.

## 2026-10-23
- Added src/lib/json-types.ts (published JSON contract types, `types` in package.json) and made `worktree list`, `ct list` and `repos` build their JSON with `satisfies` against it. Why: the GUI consumers read these shapes and the package .d.ts must not drift from the output.
- Added `kunj agent [start|status|stop] [branch]` (src/commands/agent.ts, src/lib/agent-session.ts, src/lib/repo-identity.ts, setting `agent.command`), and `agent: { running, session }` on `worktree list --json` from one `tmux list-sessions` per listing; AgentStatusJson/AgentStopJson in json-types.ts; docs page worktrees/agent.mdx. Why: the workspace app needs to start, reattach to and see agents of local worktrees without touching tmux itself; session names carry a branch hash because one host tmux server is shared.
- BaseCommand `--json` errors now print `{ error: { code, message } }` when the error has a string `code` (plain `{ error: "<message>" }` otherwise); `repoIdentity({ commonDir, repoRoot })` reads origin from `<commonDir>/config` so the worktree listing and `kunj agent` share one session name with no git subprocess. Why: GUI consumers need the agent error code, and the listing must not add subprocesses on the fast path.
- BaseCommand coded `--json` errors are now opt-in via a string `jsonCode` (AgentError exposes it as a getter of `code`); other errors, including Node system errors with `code`, keep `{ error: "<message>" }`. Why: existing commands and the VS Code extension must not change error shape.
- Added `kunj ct file read|write [branch] <path>` (src/lib/container/files.ts, `FileReadJson`/`FileWriteJson`); `ContainerError` moved to src/lib/container/errors.ts with an optional code exposed as `jsonCode`, and `ct --json` errors stay always `{ error: { code, message } }` (code from StartError, 'hook', the error's `jsonCode`, else 'error'); only BaseCommand's generic path is opt-in. Why: the workspace app reads and writes container files only through the CLI and needs error codes.
- Fix round: restored the always-object `ct --json` error shape (see above) after it briefly became opt-in. Why: `kunj ct --json` documents every error as an object.

- Merged the workspace CLI contract branch (JSON types, `kunj agent`, `kunj ct file`) into main; `ContainerListJson` gains main's `orphans` and `dind`, and `StartError`/`ContainerError` share src/lib/container/errors.ts. CLAUDE.md now says to work on main with no branches or worktrees. Why: the user works on main only, and the plan had been run in a worktree.
- Added `kunj events [--json] [--repo <path>...]` (src/lib/events.ts, src/commands/events.ts, `EventJson`, `ContainerBackend.events()` with `docker events`): an NDJSON change stream of git dirs, ~/.kunj registry files, kunj- tmux sessions and Docker events, ended by SIGINT/SIGTERM or stdin closing. Why: the workspace app refreshes on events instead of polling every repository.
- kunj events fix: `git status` in worktree listings runs with `GIT_OPTIONAL_LOCKS=0`, and the git watch covers only the common dir top level plus `refs/` and `worktrees/` (started when they appear). Why: an index rewrite by the listing re-triggered the app refresh in a loop, and a recursive watch of `.git` also watched worktree checkouts in `.git/kunj/worktrees` with their node_modules.

- Documented the published JSON contract in CLAUDE.md ("Workspace app contract") and marked the CLI additions shipped, with commit hashes, in the workspace IDE design spec. Verified from outside the package that `import type ... from "kunj"` resolves and a wrong `EventJson` fails. Why: the macOS app and workspace app depend on these types staying additive.

- Doc fix: events spec item now describes the actual git watch scope and GIT_OPTIONAL_LOCKS=0, worktree list agent shape includes `session`, CLAUDE.md says JSON is built against the types (`satisfies` or annotation). Why: match shipped behaviour.

## 2026-10-23 — Specs consolidated into `docs/specs/`

- Merged each discussion doc in `docs/specs/` with its engineering design from `docs/superpowers/specs/`
  into one file per topic (container-system, branch-containers, blueprints, container-phase-2,
  organize-windows, then workspace-ide), checked every behaviour claim against `src/` and `macos-app/`
  and fixed the specs where the code differs; updated the links in CLAUDE.md and the plans. Why: two
  folders said the same things twice and had drifted from each other and from the code.
- Merged the workspace IDE design into `docs/specs/workspace-ide.md` (CLI contract marked shipped with its
  commits, events and `agent` field described as the code does, Electron decision reopened by the
  native-shell spike, app plan on hold) and deleted `docs/superpowers/specs/`. Why: one spec per topic.
- Workspace CLI contract final fixes: `kunj agent` passes KUNJ_* with tmux `-e`, drops TMUX and runs without tmux (`--no-tmux`); `kunj events` gains a 10 s worktree/container status poll, origin-based repo ids, `hello` once armed, abort-raced Docker calls and restarted subwatchers; tmux failures are no longer read as "no agents". Why: final review of the contract (app depends on the stream being complete and prompt).
- docs/specs/workspace-ide.md: tmux-optional and events status poll marked shipped. Why: the fix wave landed both.
- docs/specs/container-system.md: secret manager design (encrypted vault in ~/.kunj, explicit targets, env or file delivery, .env import) and a roadmap to-do. Why: the user asked for a secret manager in the containers spec.
- docs/specs/README.md is now the project tracker (done with commits, in progress, to do, waiting on you); CLAUDE.md says to keep it current. Why: the user asked to keep track of what is done in one place.
- scripts/check-tmux-agent.sh: the tmux behaviour kunj agent relies on (-e on a running server, -A reattach runs set-option, window-size latest, nesting refusal and TMUX removal), run in a Debian container; passes on tmux 3.3a and 3.5a. Why: to cover the tmux versions Linux users get, besides the macOS 3.8 check.
- spikes/native-ide/: native IDE spike (AppKit + SwiftTerm 1.20.0 + one WKWebView running Monaco 0.57 diff) with --bench scenarios, results/*.json, screenshots and REPORT.md. Why: measure whether a native shell can replace the planned Electron app.
- docs/specs/README.md: native IDE spike moved to Done (1c2aaa3); runtime decision waits on the user. Why: the spike reported.
- docs/specs/README.md: spike row lists 1730cd1; the runtime decision row says key presses and live resize passed the user's manual check, and what is still unmeasured. Why: the user ran the manual checks in the demo app.
- docs/specs/README.md: spike closed (0e41a24), remaining checks dropped as not needed. Why: the user closed the spike.
- docs/specs/workspace-ide.md, docs/specs/README.md: runtime decided as native (AppKit + SwiftTerm, Monaco in one WKWebView); app design, spike results and decisions updated, the open question removed. Why: the user chose native after the spike.
- docs/specs/workspace-ide.md: removed the runtime options table and the other runtimes' sources; the spec now states only the native choice and the spike results. Why: the user asked to drop the options once decided.
- src/lib/container/docker.ts, src/commands/events.ts: LocalDockerBackend tracks its docker children and killChildren() ends the ones still running; kunj events calls it on stop. Why: a hung docker info/ps kept kunj events alive after Ctrl-C (user approved the fix).
- docs/superpowers/plans/2026-10-23-secret-manager.md: implementation plan for the secret manager (8 tasks) with six rulings correcting the spec (env changes need --rebuild, secretsChanged from a ciphertext digest, tmux agents under kunj run, keychain writes via stdin, passphrase fallback, inspect shows env-file vars). Why: the user approved the design.
- docs/workspace-app/: the workspace app design package (DESIGN.md, tokens.json, mockups) added from the 2026-10-23 handoff; its Electron spec and prompt dropped, README says it is design only. Why: the user said the handoff knows only design, anything technical in it is ignored.
- docs/specs/workspace-ide.md: layout section rewritten to the design (sidebar rows by task, header actions, terminals left, Changes column always right, themes from tokens.json); status table, decisions and code map updated. Why: the user said the UI must look just like the design.
- docs/specs/workspace-ide.md: "App design (proposed)" replaced by an Architecture section (process model, package targets, data flow, agent state via Claude Code hooks, terminals, Changes column, editor tabs, layout file, actions, window, distribution, v1/v2); decisions for scope, titles, hooks and fonts recorded. Why: the user asked for the technical architecture to be thought out before building, and answered the open questions (amber waiting state and editor tabs in, previews and splits out, branch names as titles, bundled fonts, no release).
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: rewritten for the native runtime, 12 tasks (CLI agent state hooks, package + tokens, KunjCLI, model, events/store, sidebar/header/status bar, terminals, layout, Changes, editor tabs, actions/settings/themes, distribution + docs). Why: the Electron plan no longer matched the runtime decision.
- docs/specs/README.md: Workspace app v1 moved from To do to In progress. Why: work started.
- src/lib/agent-session.ts, src/commands/agent.ts, src/commands/container.ts, src/lib/container/env.ts, src/lib/worktree.ts, src/lib/events.ts, src/lib/json-types.ts, src/settings/agent.ts: agent waiting-for-input state. kunj agent / kunj ct agent pass Claude Code hooks (--settings) that write running|waiting to KUNJ_AGENT_STATE; worktree list and ct list report agent.state, kunj events watches it. New setting agent.hooks (default true). Why: the workspace app's amber "Waiting for input" dot, which the user put in v1. Verified live: the state went running then waiting, and SessionEnd removed the file.
- docs/specs/container-system.md: restored "external vaults" (a stray edit turning it into "externs" was swept into ace71b1). Why: the wording was broken.
- src/lib/apps.ts, src/lib/__tests__/apps.test.ts: 'workspace' companion app (asset Kunj-workspace-*.zip), MAC_APPS table (bundle + executable to quit), installMacApp(zip, { app, launch, quit, dirs }) and installedMacApp(app, dirs) generalised to an app name; staging dir now always removed. Why: kunj install workspace (workspace app v1, Task 12).
- src/commands/install.ts, src/commands/setup.ts: `workspace` install target, in `all` and the interactive list on macOS, help text. Why: install the Workspace app from the release like the menu bar app.
- .github/workflows/release.yml: `workspace-app` job (macos-15, npm ci in workspace-app/web, scripts/bundle.sh with VERSION, zip Kunj-workspace-<v>.zip, attach) and a release notes paragraph. Why: ship the Workspace app with each release.
- docs-site/src/data/commands.json: regenerated (npm run gen). Why: install command description and help changed.
- docs/specs/workspace-ide.md, docs/superpowers/plans/2026-10-23-workspace-app-v1.md: folded in the architecture review (time-budgeted hidden tabs, scoped refreshes, full refresh after a stream restart, MIN_KUNJ_VERSION 1.3.0, layout key kind:branch, pr tab stays open, one call for untracked counts, OFL text, no paths from the web view, layout/decision inconsistencies fixed); open items for the two kunj events/STATUS_SCRIPT bugs, the tmux-less flow, the second web view and Monaco ESM. Why: the user asked to update the doc with the review.
- src/lib/events.ts, src/lib/container/env.ts, src/lib/json-types.ts: agent-state fixes from the architecture review and the adversarial review: events only on a change, with the repo, none for a deleted file (was running:true on SessionEnd); the container status script and parseStatus report the state only while the agent session exists; ContainerJson.agent and EventJson.agent declare state/repo. Spec and tracker updated. Why: confirmed findings (refresh storm, stale waiting, undeclared field, false running).
- workspace-app/ (Package.swift, Package.resolved, .gitignore, README.md, Resources/Info.plist, Resources/web/index.html, web/, scripts/, Sources/KunjWorkspaceCore/Design/, Sources/KunjWorkspace/{main,AppDelegate,Views/MainWindowController}.swift, Tests/KunjWorkspaceCoreTests/{DesignTokensTests,FakeKunjTests,Support}.swift, Tests/Fixtures/fake-kunj): workspace app Task 2, the Swift package, generated design tokens, build/test scripts and the skeleton window. Why: plan Task 2 of the workspace app v1.
- workspace-app/Tests/Fixtures/fake-kunj, Tests/KunjWorkspaceCoreTests/Support.swift, FakeKunjTests.swift: the fake kunj CLI with its naming rule (`--json` dropped, `--` stripped, `/` -> `-`, joined by `_`) and FAKE_KUNJ_RESPONSES/VERSION/STDOUT/EXIT/LOG switches, tested. Why: every KunjCLI test from Task 3 on runs against it, so its rule must be fixed and documented first.
- workspace-app/scripts/bundle.sh: one scratch dir per architecture (<SCRATCH>/release-<arch>) and a plain lipo call. Why: the build system writes every triple to the same out/Products/Release, so the app had two x86_64 slices and no arm64.
- workspace-app/scripts/test.sh, bundle.sh: a remembered SDK may still fall back to the others; test.sh retries once with cleared module caches on "plugin for module 'TestingMacros' not found". Why: that error hit an incremental build with the remembered (working) SDK and the fallback never ran.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Global Constraints and Tech Stack say Swift Testing (XCTest snippets are shorthand), the per-triple + lipo universal build, per-agent SCRATCH, and the session's Co-Authored-By line instead of "Claude Fable 5.1"; Task 2 lists fake-kunj/Support.swift as shipped there and says DesignTokens.Fonts are PostScript prefixes; Task 3 modifies Support.swift instead of creating it and states fake-kunj's real naming rule and switches; Task 9's XCTSkip becomes an .enabled(if:) trait. Why: Review 2 of Task 2 found the plan describing a build and test setup that no longer exists.
- docs/specs/workspace-ide.md: Architecture describes the lipo build, Swift Testing, SCRATCH and the README; status row records the scaffold (0e8ab41); two open questions from the scaffold (sidebar vibrancy blend #242220 vs #201d1b, status bar font not yet the bundled mono). Why: keep the spec in step with what Task 2 built and hand Task 6 the unresolved points.
- docs/specs/README.md: the workspace app v1 in-progress line lists the tasks done (1, 2, 12 CLI part). Why: tracker in step with the spec.
- workspace-app/Sources/KunjWorkspaceCore/CLI/{Version,ShellEnvironment,ProcessRunner,KunjCLI}.swift: SemVer + checkVersion (MIN 1.3.0, 1.0.0 = dev), login-shell PATH (marker trick, 5 s cap, fallback), terminal environment (TERM/COLORTERM/LANG, markers removed), a process runner (background pipe draining, stdin written then closed, kill at timeout, no wait on grandchildren), KunjCLI (discover via `kunj -V`, run with --json and error documents, runRaw, spawnSpec, splitArguments). Why: plan Task 3, the app's only channel to kunj.
- workspace-app/Tests/KunjWorkspaceCoreTests/{VersionTests,KunjCLITests}.swift, Support.swift, Tests/Fixtures/responses/version.txt: tests for the above against fake-kunj (env vars passed through `env K=V` in the command, so the test process's environment is untouched). Why: TDD for Task 3.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift, Views/MainWindowController.swift: discovery at launch off the main thread (`kunjCommand` default, else `kunj`); the version shows at the sidebar's foot as in warm.png, a discovery error in red on the status bar's right; --screenshot waits for discovery; labels use the bundled JetBrains Mono. Why: plan Task 3 Step 3.
- workspace-app/Sources/KunjWorkspaceCore/CLI/KunjCLI.swift, Tests/KunjWorkspaceCoreTests/KunjCLITests.swift: env exit 127/126 is `not-found` only when env names the kunj command itself; when kunj is found but its `#!/usr/bin/env node` is not (nvm not loaded by the login shell) it is `command-failed` with env's line, tested with a kunj script naming a missing interpreter. Why: Review 3 of Task 3 found the app telling a user with kunj installed to `npm install -g kunj`.
- docs/specs/workspace-ide.md: Binary bullet names the `kunjCommand` default, `-kunjCommand`, the dev label, the not-found vs missing-interpreter rule and the sidebar-foot version; kunj calls get the terminal environment; status row records e6feedc; open questions for fish's `$PATH` and the interim status-bar error. Why: keep the spec in step with Task 3.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 3 lists the API and error mapping as built and the version at the sidebar foot; Task 6 replaces Task 3's temporary error label with the window's error state; Task 11's settings reuse the `kunjCommand` key and rebuild the store. Why: Review 3, the plan must describe what exists and what later tasks consume.
- workspace-app/README.md: `kunjCommand`/`-kunjCommand`, `fakeKunjCLI`, and the `rm -rf <scratch>/out` fix for a persistent TestingMacros error. Why: Task 3 docs notes.
- docs/specs/README.md: workspace app line lists Task 3 (e6feedc). Why: tracker in step.
- workspace-app/Sources/KunjWorkspaceCore/JSON/KunjJSON.swift: Decodable mirrors of `kunj repos|worktree list|ct list|ct file --json` and the error document (both shapes). Why: Task 4, the app reads the CLI's JSON contract only.
- workspace-app/Sources/KunjWorkspaceCore/Model/Environment.swift, Model/EnvironmentList.swift: `Environment` (id `<repo>|<kind>|<branch>`, status verb, dot, meta line) and `mergeEnvironments`/`listEnvironments` (repos, then per repo worktree list + ct list in parallel; a failing ct list marks the backend unavailable and keeps the worktrees). Why: Task 4, the single model every view reads.
- workspace-app/Tests/Fixtures/responses/{repos,worktree_list,ct_list,ct_list_error}.json, Tests/KunjWorkspaceCoreTests/EnvironmentTests.swift: fixtures shaped like this machine's real output with the mockup's branches, and 18 tests. Why: Task 4 TDD; also checked once against the real kunj (4 repos decode).
- 2026-10-23 Review 4 (workspace app): no code defects found in the JSON mirrors and environment model (57/57 Swift tests pass; Docker's nanosecond `Created` parses); nothing changed in code.
- 2026-10-23 Plan: Global Constraints say `kunj repos --json` runs in the home directory (there is no repository yet), so the "cwd = repo root" rule has its one exception written down.
- 2026-10-23 Plan Task 4: as-built notes (public var mirrors and inits, optional AgentState.session, agentActivity, repo-name ids, container verbs and meta line, listEnvironments' error slot, fixture roots) so Tasks 5-11 build on what exists.
- 2026-10-23 Plan Task 5: the store's scoped refresh needs per-repo listWorktrees/listContainers factored out of listEnvironments, which only returns merged results.
- 2026-10-23 Plan Task 6: the status bar's uptime is for containers only (a worktree has no createdAt).
- 2026-10-23 Spec workspace-ide.md: status row names 53fdf6b; Data flow says ids use the repo name, bare/detached worktrees are left out, repos runs in home, containers have no count/upstream/PR; open questions for repo-name id collisions, detached-during-rebase rows vanishing, and container PR/upstream.
- 2026-10-23 docs/specs/README.md: tracker lists Task 4 (53fdf6b).
- 2026-10-23 workspace-app/Sources/KunjWorkspaceCore/Diff/DiffModel.swift: DiffScope/FileStatus/ChangedFile/DiffSummary, parseNumstat (binary `-` as 0, `a => b` and `pre/{a => b}/post` renames, C-quoted paths), parseNameStatus, diffArgs per scope, chooseBase. Why: Task 9, the Changes column's pure model.
- 2026-10-23 workspace-app/Sources/KunjWorkspaceCore/Diff/GitRunner.swift: CommandRunner protocol, ProcessRunner, GitContext.Target, gitArgv/execArgv (worktree `/usr/bin/git -C` with GIT_OPTIONAL_LOCKS=0, container `kunj ct exec <b> -- …`). Why: Task 9, diff content is read-only git and the runner is the test seam.
- 2026-10-23 workspace-app/Sources/KunjWorkspaceCore/Diff/DiffService.swift: summary (base from one for-each-ref + merge-base, numstat/name-status/untracked in parallel, untracked line counts from one `find -type f -exec wc -l {} +`) and contents (`git show ref:path`, working file through FileAccess). Why: Task 9; one exec for all untracked files in a container (spec), `--no-optional-locks` because a container does not see the host env.
- 2026-10-23 workspace-app/Sources/KunjWorkspaceCore/Files/FileAccess.swift: read/write by relative path (no `..`, not absolute) on disk or through `kunj ct file read|write`, kunj's not-found/bad-path mapped, atomic write keeping the mode, SHA-256 digest. Why: Task 10, DiffService's working-file reads and the editor tabs' saves.
- 2026-10-23 workspace-app/Tests/KunjWorkspaceCoreTests/{DiffModelTests,DiffServiceTests,FileAccessTests}.swift, Tests/Fixtures/responses/ct_file_{read,write}_feature-x_src-a.ts.json: model tests, a temp repo with an origin (modified, added, deleted, renamed, untracked files; three scopes; PR base and origin/HEAD), a recording runner for the container path, FileAccess round trips and container calls. Why: Tasks 9 and 10 tests.
- workspace-app/Sources/KunjWorkspaceCore/Design/RelativeTime.swift, Model/EnvironmentFilter.swift (+ tests): relativeTime/uptime, the ⌘K filter, the agent count and sidebar-order ids. Why: Task 6's sidebar and status bar text, kept in Core so it is tested without a window.
- workspace-app/Sources/KunjWorkspace/Theme/Theme.swift: Theme (NSColor/NSFont from the tokens, Inter/JetBrains Mono by PostScript name), ThemeChoice and ThemeManager (`theme` default, auto = light/warm by system appearance, a per-run override). Why: every view colour and font comes from the tokens, and three themes share one shape.
- workspace-app/Sources/KunjWorkspace/Views/Controls.swift: BoxView/FillView, DotView, Icon/IconView, LinkLabel, ActionButton (Outlined/Filled/iconOnly/wide), PillView, SearchField, BadgeView, all drawn in draw(_:). Why: the design's controls; cacheDisplay (--screenshot) does not render layer backgrounds or radii.
- workspace-app/Sources/KunjWorkspace/Views/SidebarView.swift, SidebarRowView.swift: search, repo groups, rows (dot, branch, time, kind · verb), New session, agent count and kunj version. Why: Task 6 sidebar to warm.png.
- workspace-app/Sources/KunjWorkspace/Views/HeaderView.swift, StatusBarView.swift: title, meta line with PR/port links, the five actions; status bar place/uptime/services/forwards and agent state. Why: Task 6 header and status bar.
- workspace-app/Sources/KunjWorkspace/Views/TerminalColumn.swift, ChangesColumn.swift: placeholder columns with their 40 px bars. Why: separate files so Tasks 7 and 9 fill them without touching each other.
- workspace-app/Sources/KunjWorkspace/Views/MainWindowController.swift: render(repos:selected:), selection, discovery error state, "Select an environment", theme application, traffic lights moved into the 52 px top, side tint 0.94. Why: the window driven by [RepoEnvironments] so Task 7 wires the store in one call.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift, main.swift, Demo/DemoData.swift: --demo with the mockup's environments (warm unless -theme), one live listing after discovery, one function per menu (app, edit, view with Theme, window). Why: Task 6 demo/screenshot and menus later tasks extend.
- 2026-10-23 Review 9-10 core: DiffService reads a worktree symlink's working side as its target text (as git stores it), not the file it points at, so a changed link diffs correctly and a link to /dev/zero cannot hang the column (test symlinkWorkingSideIsItsTarget).
- 2026-10-23 Review 9-10 core: FileAccess reads only regular files in a worktree (a fifo, device or directory is notFound), so an editor tab or diff never blocks on one (test readRefusesWhatIsNotARegularFile).
- 2026-10-23 Review 9-10 core: plan Tasks 9/10 describe the as-built core (label(base:), chooseBase checks the PR base, one for-each-ref, find/wc counts, execArgv, DiffError cases shown by the column, FileAccess rules, status lines); Task 10 no longer moves anything out of DiffService.
- 2026-10-23 Review 9-10 core: spec Changes column/editor paragraphs as built, status row 831d215, open questions (last on a one-commit repo, container symlinks, wc -l without final newline, git rm --cached listed twice, stderr dropped); docs/specs/README.md tracker lists 9-10 core.
- workspace-app/Sources/KunjWorkspaceCore/CLI/EventStream.swift (+ EventStreamTests): KunjEvent, parseEventLine and EventStream, the long-lived `kunj events --json` child with stdin held open, doubling restart backoff, stop() closing stdin then SIGTERM after 2 s. Why: Task 5, refresh from kunj events and leave no orphan child on quit.
- workspace-app/Sources/KunjWorkspaceCore/Model/EnvironmentStore.swift (+ EnvironmentStoreTests): the store with scoped, coalesced refreshes per event type, serialised in order, a full refresh on a hello after a restart. Why: Task 5, the views' only source of environments.
- workspace-app/Sources/KunjWorkspaceCore/Model/EnvironmentList.swift: factored listWorktrees(cli:repo:) and listContainers(cli:repo:) out of listEnvironments. Why: a scoped refresh needs one repo's half on its own.
- workspace-app/Tests/Fixtures/fake-kunj, responses/events.ndjson: `events` case streaming the fixture 20 ms apart, waiting for stdin EOF unless FAKE_KUNJ_EVENTS_EXIT=1. Why: EventStream tests.
- workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift (+ TerminalSpecTests, CoreTestEnvironments): TabKind, TerminalSpec, TerminalSpecError and terminalSpec(): login shell in the worktree, kunj agent / ct shell / ct agent / kunj <action> through env, refusals for a missing worktree or stopped container, cleaned PTY environment. Why: Task 7 core, never start a PTY that exits at once.
- workspace-app/Sources/KunjWorkspaceCore/Layout/WorkspaceLayout.swift (+ WorkspaceLayoutTests): SavedTab, BranchLayout, WorkspaceLayout (the spec's object keyed "<kind>:<branch>"), layoutPath, loadLayout (empty when missing or corrupt, bad entries skipped), atomic saveLayout, LayoutStore with a debounced save and flush. Why: Task 8 core, tabs and last activity survive a relaunch.
- workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift (+ ActionSpecTests): EnvAction, ActionPlan (.terminal with a cwd), actionPlan() with disabled reasons, NewSessionRequest/newSessionPlan, isValidBranchName. Why: Task 11 core, one table of what every action runs.
- workspace-app/Sources/KunjWorkspaceCore/Design/RelativeTime.swift (+ RelativeTimeTests.justUnderAnHourIsMinutes): relativeTime truncates minutes instead of rounding. Why: Review 6, 59m30s–59m59s rounded to 60 and fell through to "0h".
- workspace-app/Sources/KunjWorkspace/Views/MainWindowController.swift: onSelect's comment says render never calls it. Why: Review 6, the comment claimed render reports a replaced selection, which it does not.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 6 status and as-built notes (list view, tint 0.94, radii, Theme override, MainWindowController API, helpers); Task 3's interim error marked replaced; Tasks 7 and 9 modify the TerminalColumn/ChangesColumn placeholders; Task 8 sets lastActivity; Task 11 search already filters, ⌘1–9 over the filtered ids, View > Theme exists. Why: Review 6, plan in step with what was built.
- docs/specs/workspace-ide.md: status row for 95410df/d7b79fa, Task 2/3 open questions on tint, fonts and interim error closed, new Task 6 open questions (traffic lights over header buttons, uptime from createdAt, filtered-out selection), SidebarRowView/DemoData in the Architecture table. Why: Review 6.
- docs/specs/README.md: tracker lists Task 6. Why: Review 6.
- workspace-app/README.md: --demo and -theme for screenshots; discovery error is the window's message. Why: Review 6.
- workspace-app EventStream.restart() and EnvironmentStore: a clean full listing whose repository roots differ from the ones `kunj events` started with restarts the stream (tests restartReplacesTheChild, restartBeforeStartIsHarmless, aChangedRepositorySetRestartsTheStream, aFailedListingDoesNotRestartTheStream). Why: Review 5 — kunj events resolves its repositories once, so a repo added or un-hidden after launch was listed but never live-updated, and a hidden one kept triggering full refreshes.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 5 status and as-built notes (agent repoRoot, pid/restart, injectable listers, event rules, makeEventStream wiring), coalesce test at 250 ms, Step 3 moved to Task 7 (Task 7's Modify entry names it). Why: Review 5, plan in step with what was built.
- docs/specs/workspace-ide.md: status row for 8f49f54, Data flow describes the stream (home cwd, stdin, stop, backoff), coalescing rules, first hello skipped and the restart on a changed repo set; Task 5 open questions (repo-less agent/container events run full refreshes, a full refresh's partial error outlives a scoped recovery). Why: Review 5.
- docs/specs/README.md: tracker lists Task 5 core. Why: Review 5.
- workspace-app/Resources/web/index.html, workspace-app/Resources/web/app.js: the Monaco page (?mode=diff): read-only diff editor with JetBrains Mono 11.5/19, theme from the tokens (monochrome code, addBg/red signs), hidden unchanged regions; a whole added/deleted file shows in a single-side editor marked +/−. Why: Task 9 Step 4; Monaco diffs an empty side as a changed empty line, which showed a deleted row above every new file.
- workspace-app/Sources/KunjWorkspace/Editor/MonacoWebView.swift: WKWebView host (shared process pool, kunj://app/ scheme serving web/ and fonts/, ready queue, call(fn,args), reload after a content-process crash, snapshot). Why: Task 9 Step 4.
- workspace-app/Sources/KunjWorkspace/Views/ChangesColumn.swift, ChangedFileRowView.swift: the Changes bar (counts, scope menu button), file list (NSTableView, 28 px rows as warm.html) and the diff; reloads on environment/scope change and 500 ms after repoChanged(root:); empty and error states. Why: Task 9 Step 4.
- workspace-app/Sources/KunjWorkspaceCore/Diff/ChangesList.swift (+ ChangesListTests): row display names (basename, widened until unique), selection kept across reloads, "N files". Why: testable column logic.
- workspace-app/Sources/KunjWorkspaceCore/Model/EnvironmentStore.swift (+ test): onRepoChanged(root) for git events and container status events. Why: the column refreshes on changes in its repository.
- workspace-app/Sources/KunjWorkspace/Demo/DemoChanges.swift, AppDelegate.swift, MainWindowController.swift: --demo feeds the mockup's 14 files and diff; DiffService set after discovery; --screenshot composites the WKWebView's snapshot and waits for Monaco. Why: Task 9 Step 5 (compare with warm.png).
- src/lib/agent-session.ts, src/commands/container.ts: kunj agent and kunj ct agent set 'status off' on their tmux session (session option; reapplied on reattach). Spec and tracker updated. Why: the user wants no tmux status bar in the agent tabs; verified live with tmux 3.8 (session off, global still on).
- workspace-app/Sources/KunjWorkspaceCore/Diff/ChangesList.swift, Views/ChangesColumn.swift (+ ShownDiffTests): the column no longer re-sends a diff identical to the one shown (ShownDiff/diffNeedsShowing; reset on clear and page reload). Why: Task 9 review: every git event of the repo (any worktree) refetched the file and showDiff scrolled the diff back to the top while it was being read.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 9 marked done as built (page functions take one argument object, single-side editor, ScopeButton, row drawing, display names, MonacoWebView/ChangesColumn API, onRepoChanged); Task 7 wires onRepoChanged; Task 10's page functions follow the one-object shape. Why: Task 9 review, docs in step with the code.
- docs/specs/workspace-ide.md, docs/specs/README.md: status row and tracker list f3c01a5; Changes column paragraph as built; open questions (binary/large files sent to Monaco, no hunk headers / place for Edit, reloads on other worktrees' git events). Why: Task 9 review.
- src/settings/agent.ts, src/types/index.ts, src/lib/agent-session.ts, src/commands/agent.ts, src/commands/container.ts: settings agent.tmux (default true; false runs kunj agent / kunj ct agent directly, no hint) and agent.tmuxStatus (default false; true keeps tmux's status line). Spec, tracker, docs-site reference and plan Task 11 (Settings window toggles via kunj config --global) updated. Why: the user wants the status line and tmux itself selectable in settings; verified live with a temporary HOME.
- src/commands/agent.ts, src/commands/container.ts: with agent.tmux off, an agent still running in its tmux session is reattached instead of starting a second one (host and container); kunj ct attach explains that agent.tmux is off instead of suggesting ct agent. Spec updated. Why: adversarial review findings (two agents on one worktree; misleading attach error); verified live (one session, one agent, two clients).
- workspace-app/Sources/KunjWorkspaceCore/Terminal/HiddenFeedScheduler.swift, Tests/.../HiddenFeedSchedulerTests.swift: HiddenFeedScheduler and HiddenFeedQueue (hidden tabs' output fed in slices under a shared 4 ms budget per run-loop turn, round robin, never dropped; drainAll when shown). Why: Task 7, spec Terminals (parsing on the main thread is the cost; truncation breaks escape sequences).
- workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift, TerminalSpecTests.swift: tabDot(kind:running:agent:) (live agent tab amber while waiting else green, live action tab green). Why: Task 7 tab bar dots, testable without a window.
- workspace-app/Sources/KunjWorkspace/Terminal/TerminalTab.swift: SwiftTerm LocalProcessTerminalView per tab from a TerminalSpec (JetBrains Mono 12.5, line spacing for 1.6, term* colours, ANSI palette from tokens), inBackground queues output to the scheduler, close() sends SIGHUP then SwiftTerm's SIGTERM. Why: Task 7.
- workspace-app/Sources/KunjWorkspace/Model/TabRegistry.swift: tabs per environment, active tab, open/openDemo/activate/cycle/close/closeAll; shells and closeOnExitZero actions close on exit 0, others print the exit code. Why: Task 7.
- workspace-app/Sources/KunjWorkspace/Views/TabBarView.swift, Views/TerminalColumn.swift: the tab bar (pills, dots, `tmux <session> · uptime`, disabled split, +) and the column holding every tab view, showing the active one, an inline message for a refused Shell/Agent. Why: Task 7, warm.png.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift: EnvironmentStore + kunj events stream instead of one listing; applicationShouldTerminate closes every tab and stops the stream (reply through the run loop so a terminate from a main-actor task cannot deadlock); header Shell/Agent and Environment (⌘T, ⌘⇧A) and Tabs (⌘⇧], ⌘⇧[, ⌘W) menus; -openTabs launch argument for checks without a person. Why: Task 5 Step 3 and Task 7.
- workspace-app/Sources/KunjWorkspace/Views/MainWindowController.swift: --screenshot composites visible terminals (SwiftTerm's layer background is not drawn by cacheDisplay; scrollers hidden while rendering). Why: compare the tab bar and terminal with warm.png.
- workspace-app/Sources/KunjWorkspace/Demo/DemoTabs.swift: --demo opens the mockup's agent (transcript), zsh and bun dev tabs. Why: the demo screenshot matches warm.png's terminal column.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift: store.onRepoChanged → changesColumn.repoChanged(root:). Why: plan Task 7 (after Task 9), so the Changes column follows git events.
- src/lib/agent-session.ts, src/commands/agent.ts: hasTmuxSession (exact-name has-session); with agent.tmux off and a failed tmux listing, kunj agent asks tmux for its session and reattaches instead of starting a second agent. Why: verdict-pass finding (the duplicate-agent case remained when the listing failed); checked against real tmux (exact match only).
- workspace-app review 7: tab exit codes come from the wait status (`exitCode(waitStatus:)`, test exitCodesFromWaitStatus): SwiftTerm passed waitpid's raw status, so `exit 1` printed "[process exited with code 256]".
- workspace-app review 7: closing a tab whose process already exited no longer sends SIGTERM to its old pid, which may belong to another process by then.
- workspace-app review 7: a newly opened agent or action tab shows its dot at once (the registry notifies after starting the process, not before; it waited up to 30 s).
- docs review 7: plan Task 7 marked done as built (inBackground, close, exit codes, registry/column API, AppDelegate wiring, menus, -openTabs, what was checked live), Task 8 handoff notes; spec status row, Terminals paragraph, code map entries, Task 4 rebase question updated, Task 7 open questions; specs tracker lists Task 7.
- docs/specs/workspace-ide.md, docs/superpowers/plans/2026-10-23-workspace-app-v1.md: the Changes column is hidden by default and opened with a toggle (tab-bar Changes pill with the file count, View > Show Changes ⌘⇧C, remembered app-wide; no diffing while hidden); Task 11 builds it. Why: the user asked for the changes panel hidden by default and openable.
- workspace-app/Sources/KunjWorkspaceCore/Layout/WorkspaceLayout.swift, Tests/KunjWorkspaceCoreTests/WorkspaceLayoutTests.swift: tabsToSave (drops action tabs), restorePlan (waits for a usable environment, agent tabs only while the agent runs) and ActivityTracker (first listing primes). Why: Task 8 Step 2 needs testable save/restore/activity rules.
- workspace-app/Sources/KunjWorkspace/Model/LayoutKeeper.swift, AppDelegate.swift, Model/TabRegistry.swift: restore an environment's saved tabs on first selection, save its tabs on every change after that, bump lastActivity on listing changes and key presses in its tabs; the sidebar shows it; -openTabs entries without #kind only select. Why: Task 8 Step 2 (layout persistence and last activity in the sidebar).
- Review 8 (workspace-app): ActivityTracker remembers environments missing from a listing and ignores a pull request appearing/disappearing, because a failed `ct list`/`worktree list` or a failing `gh` marked every container/worktree as active "now" when the listing recovered (tests environmentsBackUnchangedAfterAFailedListingAreNotActivity, aPullRequestLookupComingAndGoingIsNotActivity).
- Review 8 docs: plan Task 8 status and as-built (LayoutKeeper, restorePlan, ActivityTracker, Task 10 handoff); spec status row, App state key, lastActivity and Layout file paragraphs as built, Architecture table, Task 8 open questions, -openTabs question updated; specs tracker lists Task 8.
- workspace-app/Sources/KunjWorkspaceCore/Files/EditorSave.swift, Tests/KunjWorkspaceCoreTests/EditorSaveTests.swift: saveDecision (write / alreadySaved / conflict, deleted or changed on disk), editorTabTitle, editorRefusal (binary or over 5 MB). Why: Task 10, the testable part of Save and its conflict check.
- workspace-app/Resources/web/app.js, index.html: ?mode=editor (openFile, showFile, closeFile, getContent → {content, version}, markSaved, focus; posts dirty and save with the tab id only; ⌘S in Monaco). Why: Task 10 editor tabs in the second Monaco page.
- workspace-app/Sources/KunjWorkspace/Editor/EditorTab.swift, Model/TabRegistry.swift, Views/TerminalColumn.swift, Views/TabBarView.swift: editor tabs in the registry beside terminals (WorkspaceTab protocol), one shared editor page shown for the active editor tab, dirty dot, Save with the changed-on-disk alert, Save/Don't Save/Cancel when closing a dirty tab. Why: Task 10 Step 2.
- workspace-app/Sources/KunjWorkspace/Views/ChangesColumn.swift, Views/HeaderTextButton.swift: a diff header (path + Edit) and double-click on a file open it in an editor tab. Why: Task 10, the ways to open an editor.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift, Model/LayoutKeeper.swift, Views/MainWindowController.swift: File > Save ⌘S, FileAccess after discovery, a save reloads the Changes column, quitting with unsaved editors asks, editor tabs saved and restored through the layout file with their path. Why: Task 10 wiring and Task 8's handoff.
- Review 10 (workspace-app): editorRefusal also refuses text holding U+FFFD ("not UTF-8"), because FileAccess and `kunj ct file read` decode lossily and saving a Latin-1/UTF-16 file from an editor tab would overwrite its bytes with replacement characters (test refusesTextThatWasNotUTF8).
- Review 10 (workspace-app): TabRegistry.shownEditor (set by TerminalColumn.sync) lets key presses in the editor page bump the environment's lastActivity, as the spec says for key presses in any of its tabs; before, only terminal tabs counted.
- Review 10 docs: plan Task 10 status and as-built interfaces (EditorSave, page functions, WorkspaceTab, registry/EditorTab/ChangesColumn/AppDelegate API, LayoutKeeper), Task 11 notes (allTerminals, theme reaches the editor page, Edit needs the Changes column open); spec status row, tab bar dot, Editor tabs and layout restore paragraphs as built, Architecture table, Task 9 hunk-header question updated, Task 10 open questions; specs tracker lists Task 10.
- workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift, Tests/KunjWorkspaceCoreTests/ActionSpecTests.swift: KunjSetting (agent.tmux, agent.tmuxStatus), configGetArgs/configSetArgs and ConfigValueJson (bool or "true"/"false", absent = nil). Why: Task 11 Settings shares the agent toggles with the CLI through kunj config.
- workspace-app/Sources/KunjWorkspace/Actions/ActionRunner.swift: runs action plans (action tabs, `kunj … --json` with an alert on failure, URLs, copy/reveal), confirms removals with a Force checkbox, builds the header's overflow menu, runs New session in the repo's main worktree and selects the new environment (and opens its agent) when it appears. Why: Task 11 Step 2.
- workspace-app/Sources/KunjWorkspace/Sheets/NewSessionSheet.swift: the New session sheet (repo, branch, base, worktree/container, start an agent; branch checked with isValidBranchName; Container disabled while Docker is unavailable). Why: Task 11 Step 2.
- workspace-app/Sources/KunjWorkspace/Settings/SettingsWindow.swift: Settings (kunj command → rediscovery, theme, agent tmux toggles through kunj config with inline error and revert). Why: Task 11 Step 2.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift, Views/{MainWindowController,HeaderView,SidebarView,TabBarView,TerminalColumn,ChangesColumn,Controls}.swift: menus (Settings ⌘,, Open in VS Code ⌘O, Create PR ⌘⇧P, New Session ⌘N, Search ⌘K, Switch to Session ⌘1–9, View > Show Changes ⌘⇧C), header buttons enabled by plan, Esc clears search, the Changes column hidden by default (setChangesVisible, `showChanges` default, tab-bar Changes pill with the file count, isActive skips loading), `--theme <name>` and `--changes`/`--no-changes` for screenshots, reconnect on a new kunj command. Why: Task 11 Step 2 and the user's 2026-10-23 rulings (Changes hidden by default, agent toggles in Settings).
- workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift, Tests/KunjWorkspaceCoreTests/ActionSpecTests.swift, Sources/KunjWorkspace/Actions/ActionRunner.swift: `.run` answers go through `runOutcome` (RunResultJson); `worktree open` answering `success: false` (editor not on the PATH, or worktree.editorCommand empty) now shows an alert instead of doing nothing. Why: Task 11 review, Open in VS Code failed silently.
- workspace-app/Sources/KunjWorkspace/AppDelegate.swift: a discovery or first listing still running when Settings changes the kunj command is dropped (Task.isCancelled, store identity) instead of starting a second `kunj events` nothing stops. Why: Task 11 review, reconnect race.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 11 status and as-built (ActionSpec additions, ActionRunner, sheets, Settings, Changes toggle, menus, launch flags, unchecked items); pill count wording, configGetArgs, --theme. Why: Task 11 review docs.
- docs/specs/workspace-ide.md, docs/specs/README.md: status row and tracker list Task 11 (fb62af9); Changes pill at 0, Actions and Settings paragraphs as built, ActionSpec in the Architecture table, Task 11 open questions. Why: Task 11 review docs.
- docs-site/src/content/docs/workspace-app.mdx, docs-site/astro.config.mjs: a Workspace app page (what it is, install, the window, terminals and actions, editing, how agents persist through tmux, tab restore, shortcuts, settings and themes, build from source) and a top-level sidebar entry. Why: Task 12, user docs for the new app.
- docs-site/src/content/docs/integrations/apps.mdx: the Companion apps page lists the third app and `kunj install workspace`. Why: it said "two apps" after 7d497a6 added the workspace target.
- README.md: `kunj install workspace`, the manual download, build from source and a Workspace app section next to the menu bar app. Why: Task 12.
- CLAUDE.md: a Workspace App section after the macOS app one, and `workspace` in the `kunj install` line. Why: Task 12, so later sessions know the app's contract and build.
- workspace-app/README.md: intro (install, requirements, state), Running with every launch argument (--demo, --screenshot, --theme, --changes/--no-changes, -kunjCommand, -openTabs), a code map and the release job; `-theme` corrected to `--theme`. Why: Task 12, README complete.
- workspace-app ShellEnvironment.swift (+ KunjCLITests): `resolveLoginPath` returns `{ path, timedOut }` and retries with `$SHELL -l -c` when `-l -i` runs past its cap; `discoveryErrorDetail` explains a `kunj not found` after that timeout. Why: Task 12 review, launched from Finder the interactive shell timed out (likely a privacy prompt from .zshrc) and the app only said kunj was not found.
- workspace-app AppDelegate.swift, MainWindowController.swift: discovery uses `resolveLoginPath`, logs a timeout, and the error state shows the timeout line (wrapping) under the message. Why: same fix, so Settings' kunj command is the visible way out.
- workspace-app/README.md, docs-site workspace-app.mdx: the login-shell timeout, the `-l` retry and the message. Why: docs in step with the fix.
- docs/specs/workspace-ide.md: the app marked Shipped with its commits, the PATH paragraph as built, `discoveryErrorDetail` in the Architecture table, Task 12 open questions (timeout cause, release job not run yet, loop not checked with the installed app, pkill skips the quit prompt), plan marked done. Why: Task 12 review.
- docs/specs/README.md: "Workspace app v1" moved to Done with its commits; workspace-ide.md's state is Shipped. Why: Task 12 ships the app.
- docs/superpowers/plans/2026-10-23-workspace-app-v1.md: Task 12 status and as-built (MAC_APPS, installMacApp options, release job, docs page location, checks, the login-shell fix). Why: Task 12 review.
- docs/specs/README.md, workspace-ide.md: the Task 12 review commit named (c09bbd7). Why: commits listed by hash.
- workspace-app FileAccess: worktree paths resolved with realpath and refused outside the worktree, read and write. Why: final review, a branch's `config.ts -> ~/.zshrc` let ⌘S overwrite a file outside the worktree.
- workspace-app prepare-swiftterm.sh: SwiftTerm's forked child closes descriptors above 2 (stamp 1.20.0+kunj2); test target depends on SwiftTerm for PtyDescriptorTests. Why: final review, terminal tabs inherited kunj events' stdin and other pipes, so a background job kept kunj events alive after a crash.
- kunj repos --json: additive `kunjName` (RepoJson in json-types.ts, kunjDirName() in repo-identity.ts); kunj events watches agent state under it. Why: final review, kunj names ~/.kunj/<name> after origin, the registry's name is the folder, so a bare or renamed clone never got waiting events.
- workspace-app RepoRef.dirName / KnownRepo.kunjName: workspace.json goes to ~/.kunj/<kunjName>. Why: same finding, the layout file landed in a stray directory.
- workspace-app EnvironmentStore: refreshes queued per repository, a full refresh waits for all. Why: final review, one slow ct list held up every repository.
- docs: spec, plan (final review note), workspace-app README updated for the four fixes; deferred minors listed in the spec. Why: review after each task.
- docs/specs/README.md, workspace-ide.md: the final review fix commit named (22336bb). Why: commits listed by hash.
- workspace-app LayoutStore: reads ~/.kunj/<folder name>/workspace.json while ~/.kunj/<kunjName>/ has none. Why: adversarial review of 22336bb, tabs saved before kunjName were dropped for bare or renamed clones.
- workspace-app: a spinner with "Loading sessions…" and the step (Finding kunj, Listing worktrees and containers) while the app starts, from emptyStateText() in Core; `--demo --loading` renders it. Why: user asked for a loading signal; the window said "No repositories yet" for the seconds discovery and the first listing take.
- docs: spec login-PATH paragraph, workspace-app README launch flags, docs-site workspace-app page describe the loading state. Why: same change.
- workspace-app: Files column at the right edge (FilesColumn; FileLister + buildFileTree in Core, gitTarget() shared with DiffService), Files pill, View > Show Files ⌘⇧E, `showFiles` setting, `--files`/`--no-files`; tmux label in the tab bar gives way before the tabs. Why: user asked for a file explorer that opens on the right side.
- docs: spec layout and decision, docs-site workspace-app page, workspace-app README for the Files column. Why: same change.
- cli: `kunj worktree shell [branch] [--session <id>] [--kill]` (host tmux session `kunjsh-…-sh-<id>`, `shellSessionName()`) and `kunj ct shell --session <id> [--kill]` (tmux session `sh-<id>` in the container); `ShellKillJson`. Why: the workspace app's shell tabs should survive the app quitting, like agent tabs; `kunjsh-` keeps them out of the `kunj-` agent matching.
- docs: CLAUDE.md (Key Commands, Worktree agents), workspace-ide.md status table row, docs-site worktrees overview and containers commands pages, regenerated commands.json for `worktree shell` / `ct shell --session`. Why: document the persistent shell sessions.
- cli: many agents per worktree/container: `kunj agent --session <id>` (`<agent session>-a-<id>`, own state file), `agent stop --session|--all` (exit 0, `stopped`), `agent.sessions` in `worktree list`/`agent status`; `kunj ct agent --session <id>` (tmux `agent-<id>`, `/tmp/kunj-agent-state-<id>`), `ct agent --kill [--session]`, `ct attach --session`, STATUS_SCRIPT lists every agent session (`agent.sessions` in `ct list`); `--kill` without `--session` on `worktree shell`/`ct shell` ends every shell session of the branch. Why: the workspace app gives each tab its own tmux session and ends them when a tab or a whole environment closes.
- docs: CLAUDE.md, workspace-ide.md status row, docs-site agent/containers/worktrees pages and commands.json for several agents per environment and kill-all. Why: document ead40a6.
- workspace-app: shell and agent tabs each get a tmux session id (kunj worktree shell / ct shell / agent / ct agent --session), saved with the tab and reattached on relaunch; closing a tab ends its session; Agent opens a new agent every time. Why: user asked that tabs pick up where they left off after the app closes, that closing a tab ends its session, and for many agents.
- workspace-app: the sidebar lists only open sessions (sidebarGroups) with an `N more…` row per repository; Close Session (row menu, ⌘⇧W) closes every tab and ends all the branch's tmux sessions; the selected environment is remembered across launches. Why: user asked for only open sessions in the list, a way to open the others, and closing a session to close its tmuxes.
- docs: spec sidebar/tabs/restore, docs-site workspace-app page. Why: same changes.
- workspace-app Close Session: unsaved editors are asked about once before anything closes (Cancel keeps every tab and tmux session, Save saves first), then tabs close without asking (TabRegistry.discard); closing the selected session forgets it as the last selection. Why: adversarial review of f6b7efb, Cancel still killed the shells and agents, Save skipped the close, and a closed session came back on relaunch.
- workspace-app New session: stays on its action tab until kunj (and the create hooks) finish, keeps the tab open afterwards, then selects the new environment; a failure stays on the tab (TabRegistry.open onFinish). Why: user did not see the worktree hooks run: they did run (checked with the app's exact command), but the tab closed on exit 0 and the app had already switched away.
- workspace-app: sidebar row right-click menu (ActionRunner.rowMenu) with the menu bar app's row actions opening into the panel, plus Close Session and Delete Worktree…/Delete Container…; EnvAction.worktreeOpenNewWindow and .copyBranch in Core. Why: user asked for the macOS app's actions on the list, with delete worktree and delete container.
- Secrets Task 1: `src/lib/secrets/dotenv.ts` (`parseDotenv`, `isSecretName`, `NAME_PATTERN`) with a table test; spec "Secrets" section gets the plan rulings (env reaches a container only on recreate, `kunj.secrets` stamp label, agent under `kunj run` instead of `tmux -e`, keychain writes via stdin, passphrase kdf, `docker inspect` shows env-file vars); tracker line moved to In progress. Why: first task of docs/superpowers/plans/2026-10-23-secret-manager.md; `kunj secret import` needs a shell-faithful .env parser, and the spec must carry the plan corrections.
- Secrets Task 1 review: `parseDotenv` errors no longer quote file text (only the line number), with a test; spec and plan updated (Task 1 done, `bad-dotenv` error code for import, renderFiles escaping note). Why: an unquoted base64 continuation line or a mispaired quote put secret material into the error message, which reaches stderr and `--json` output.
- `kunj ct start`: with no GH_TOKEN/GITHUB_TOKEN/GITLAB_TOKEN in the host env and a GitHub origin, forward `gh auth token --hostname <origin host>` as GH_TOKEN in the env-file only (src/lib/container/tokens.ts; lazy, never for snapshots); new setting `container.useGhToken` (default true); the no-token refusal mentions `gh auth login`; new `kunj ct token status [--json]` (`ContainerTokenStatusJson` = `{ github: { source, enabled } }`); docs, CLAUDE.md, spec line. Why: the user logs in with `gh` (token in the Keychain, not env), so `kunj ct start -c` from the workspace app refused the SSH origin; the Claude token half moves to the secret manager.
- Secrets Task 2: `src/lib/secrets/vault.ts` (`readVault`/`writeVault` AES-256-GCM envelope with version/kdf/salt as AAD, atomic 0600 write in a 0700 dir, `vaultFiles`, `vaultStamp`) and `errors.ts` (`SecretError` with `jsonCode`), added to BaseCommand's no-stack list; tests for round trip, tamper, truncation, wrong key/passphrase, kdf mismatch, corrupt file never overwritten, stamp; spec, plan and tracker updated. Why: second task of docs/superpowers/plans/2026-10-23-secret-manager.md; every later task stores and reads secrets through this vault.
- Secrets Task 2 review: `writeVault` now decrypts an existing `secrets.enc` with the key before replacing it and gives `secrets-corrupt` (file byte-identical) when it does not, with two tests (tampered file, other key); spec Storage, plan Task 2/3 notes updated. Why: a tampered file or one under another key (e.g. a regenerated Keychain key) passed the envelope-shape check and was silently overwritten, losing every secret in it (Review Focus 2).
- Secrets Task 3: `src/lib/secrets/keyprovider.ts` (`getUnlock`: `KUNJ_SECRETS_KEY`, macOS Keychain via `security find-generic-password` / `security -i` with the command on stdin, libsecret `secret-tool` with the key on stdin, scrypt passphrase with a hidden readline prompt and 3 tries; injectable `Runner`/`prompt`), `Unlock.attempts` + `keyFor(salt, attempt)` so `readVault`/`writeVault` re-ask on a decrypt failure only; setting `secrets.keyProvider` (src/settings/secrets.ts); tests with a fake runner (never the real Keychain) assert the key is never in argv; docs-site settings JSON regenerated; spec, plan and tracker updated. Why: third task of docs/superpowers/plans/2026-10-23-secret-manager.md; the vault needs a key that is never in argv and never silently replaced (no `-U`, read-back, no new key over an existing keychain vault or a denied read).
- Secrets Review 3: `hiddenPrompt` in src/lib/secrets/keyprovider.ts now rejects with `secrets-locked` on Ctrl-C or end of input (Ctrl-D) and takes an `io` test seam; tests "returns the typed line without echoing it", "gives secrets-locked when input ends before a line (Ctrl-D), instead of hanging". Why: on end of input the readline question never answered, the promise never settled and kunj would exit 0 having done nothing.
- docs/specs/container-system.md (Secrets) and docs/superpowers/plans/2026-10-23-secret-manager.md: Task 3 marked done with 8901b6b and the review fix, `Unlock` interface updated in Task 2, `hiddenPrompt` exported for Task 5, Task 4 gets `vaultKdf` and the existingKdf/mixed-kdf rules for `loadSecrets`, Task 5 write paths pass `create: true` only when no vault exists, Global Constraint on test fakes made exact. Why: Review 3, so later tasks do not mint a second key next to an existing vault.
- Secrets Task 4: `src/lib/secrets/resolve.ts` (`resolveSecrets` global → repo → branch then target filter, `envOf`, `loadSecrets` glue that unlocks only when a `secrets.enc` exists, one `getUnlock` per kdf, `create: false`), `src/lib/secrets/deliver.ts` (`renderFiles` as escaped `NAME="value"` lines that `parseDotenv` reads back, `writeHostFiles` with a `git check-ignore` refusal before writing, mode 0600, temp + rename, no path outside the worktree), `vaultKdf` in vault.ts; tests with temp git repos and fake key providers (never the real Keychain); spec, plan and tracker updated. Why: fourth task of docs/superpowers/plans/2026-10-23-secret-manager.md; `kunj secret`, `kunj run`, `kunj agent` and containers all resolve and render secrets through these.
- Secrets Review 4: `writeHostFiles` (src/lib/secrets/deliver.ts) checks every path's deepest existing ancestor through symlinks before creating any directory or file, and refuses a path with a `.git` component; tests "refuses a path through a symlinked directory before writing any file or creating any directory", "refuses %p inside a .git directory even when git ignores it"; spec, plan (Task 4 done, branch-passing and path rules carried to Tasks 5–7) and tracker updated. Why: with `--force` a symlinked directory made kunj create directories outside the worktree and write earlier files before refusing; `git check-ignore` reports `.git/config` as ignored under `*` or `config`, so a file delivery could overwrite git's own files without `--force`.
- Secrets Task 5: `kunj secret` (src/commands/secret.ts: set, import, list, get, rm, env, apply [-a] [--force]) on the fast path and in the registry; `openVaults`/`configuredMode` exported from src/lib/secrets/resolve.ts (`loadSecrets` now resolves `openVaults`); `SecretListJson`, `SecretWriteJson`, `SecretImportJson`, `SecretApplyJson` in json-types.ts; tests in src/commands/__tests__/secret.test.ts with a temp HOME and `KUNJ_SECRETS_KEY` (never the real Keychain); docs-site commands JSON regenerated; spec, plan and tracker updated. Why: fifth task of docs/superpowers/plans/2026-10-23-secret-manager.md; users need a way to store, import and inspect secrets (values only via hidden prompt/stdin, printed only by `get`/`env`, never in `--json`) before `kunj run` and containers can deliver them.
- Secrets Review 5: `kunj secret import --delete` (src/commands/secret.ts `deleteSource`) removes a symlinked source itself instead of the file it points to, and a link into the keep store removes the keep copy and the link; tests "--delete of a symlinked source removes the link, not the file it points to", "--delete of a symlink into the keep store removes the keep copy and the link"; spec (import section, status), plan (Task 5 done with 6c08cd1, `openVaults`/unlock seam carried to Task 6, list hint scope in Task 8) and tracker updated. Why: the source path was resolved with realpath before `rmSync`, so `--delete` of a `.env` symlink deleted the shared file outside the worktree and left a dangling link.
- Secrets Task 6: `kunj run [--branch b] -- <cmd…>` (src/commands/run.ts, fast path and registry) runs a host command with the host-targeted env secrets, file deliveries rendered first, exit code passed through; shared `hostSecrets`/`runAttached` in src/lib/secrets/host.ts; `kunj agent` and `kunj worktree shell --session` start their tmux command under `kunj run --branch <b>` (`hostRunArgv`/`kunjSelf` in agent-session.ts, `kunjEntry` in new src/lib/self.ts, shared with `spawnDetached`), and their direct no-tmux paths get the secrets in-process (`hostSecretEnv`); `addWorktree` renders the new branch's secret files after keep files (warnings only, `secretFiles` in `worktree add --json`); tests in src/commands/__tests__/run.test.ts, agent.test.ts, worktree-shell.test.ts, agent-session.test.ts; docs-site agent page and commands JSON, spec, plan and tracker updated. Why: sixth task of docs/superpowers/plans/2026-10-23-secret-manager.md; agents, workspace-app terminals and new worktrees need their secrets without any value in argv (tmux `-e` would expose them in `ps`).
- Secrets Task 7: container delivery. `StartOptions.secrets` in src/lib/container/lifecycle.ts: container env secrets merged over `container.env` before the `gh auth token` fallback (a stored `GH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` wins and gh is not asked), file deliveries rendered into `/workspace` as the user (mode 0600, tar on stdin, `/<path>` added to `.git/info/exclude` first) on create and on every resume, the `kunj.secrets` label (`LABEL.secrets`) set to the vault stamp, a `--rebuild` hint on resume when the stamp changed and env secrets exist, snapshot (`namesFor`) starts get none, bad paths and multi-line env values refused before anything is created; `kunj ct start` loads them (`containerSecrets()` in src/commands/container.ts, before the create hook) and `kunj ct list --json` reports `secretsChanged` (`ContainerJson.secretsChanged`) from the files without unlocking; FakeBackend tests in lifecycle.test.ts and container.test.ts, a Docker test in integration.docker.test.ts; spec, plan and tracker updated. Why: seventh task of docs/superpowers/plans/2026-10-23-secret-manager.md; containers need their tokens and `.env` without hand-exported host variables, through the env file only (never argv, exec env, labels or snapshots).
- Secrets review 7: `kunj ct start` now refuses a multi-line env secret or a bad secret file path before the pre-container-create hook and the snapshot build (`checkSecrets()` in lifecycle.ts, called from `containerSecrets()`), because the spec says nothing is created first; and a secret file path with a control character is refused (`bad-path`), because a newline split the `.git/info/exclude` line and left the rendered file committable. Spec, plan and specs/README updated.
