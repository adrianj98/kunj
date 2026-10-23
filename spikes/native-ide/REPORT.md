# Native IDE spike: AppKit + SwiftTerm + one WKWebView (Monaco)

Question: can the kunj workspace IDE be a native macOS app (AppKit shell, SwiftTerm terminals) with
only the code editor (Monaco) in one WKWebView, instead of Electron?

Machine: Apple Silicon MacBook Pro, built-in display 1512x982 @2x, macOS 26, Swift 6.4 (Command Line
Tools only, no Xcode). The machine was in normal use during the runs (Chrome, Slack, Docker, five
other Claude Code sessions; `top` showed 15 GB used, 127 MB free, 5 GB in the compressor). Memory
numbers are therefore given as **footprint** (`/usr/bin/footprint`, which counts compressed pages
and is what Activity Monitor shows as Memory). RSS is shown too, but under this much pressure it
swings a lot: WebContent's RSS ranged from 25 to 422 MB across runs while its footprint stayed at
340 to 420 MB.

Versions: SwiftTerm **1.20.0** (exact tag, see Workarounds), monaco-editor **0.57.0** (exact, AMD
`min/vs` build), Claude Code v2.1.309.

Raw results: `results/*.json` (one file per bench). Screenshots: `screenshots/`. To keep the repo
small, the screenshots were downscaled to 1400 px and some sizes were dropped, so `fidelity.json`
lists a few files that are not committed.

## How to run

```bash
cd spikes/native-ide
scripts/bundle.sh                     # SwiftTerm fetch+patch, Monaco copy, release build, .app
open build/NativeIDESpike.app         # demo window: 3 environments, shell/claude/top/diff tabs
build/NativeIDESpike.app/Contents/MacOS/NativeIDESpike --bench <name> --out r.json
#   name: throughput | multi | redraw | claudes | fidelity | monaco | keys | memory | all
#   env:  SPIKE_REPS, SPIKE_MULTI_SECS, SPIKE_REDRAW_GRID=0, SPIKE_LANG, SPIKE_WEB_QUERY,
#         SPIKE_CAT_FILE, SPIKE_SHOTS (screenshot dir); flag --metal (SwiftTerm's Metal renderer)
```

The window opens in every bench and the app quits by itself. All numbers below use SwiftTerm's
default CoreGraphics renderer; `--metal` exists but was not measured.

## A. Throughput, one visible tab

The command runs as `/bin/sh -c '<cmd>; printf "\n@@SPIKE_DONE@@\n"'` in a PTY. "Exit" is
SwiftTerm's process-exit callback. "Drawn" is when the marker had been fed to the terminal plus one
forced display pass (`displayIfNeeded()` after SwiftTerm's 16.7 ms redraw throttle). SwiftTerm's
`draw(_:)` is not `open`, so a draw hook was not possible. MB/s = bytes received (after the PTY's
`\n` to `\r\n`) / spawn-to-drawn. The view was 144x52 cells. Each case ran twice (run 1 / run 2).

| Case | Bytes | SwiftTerm spawn→exit | SwiftTerm spawn→drawn | MB/s | Main-thread CPU | Terminal.app spawn→exit (120x30) | No terminal (`> /dev/null`) |
|---|---|---|---|---|---|---|---|
| `seq 1 2000000` (macOS seq prints `2e+06` style) | 20.8 MB | 3407 / 3465 ms | 3531 / 3672 ms | 5.9 / 5.7 | 96% / 96% (3.4 s) | 5520 / 5773 ms | 270 ms |
| `cat` 50 MB of TypeScript source | 51.3 MB | 1405 / 1351 ms | 1503 / 1457 ms | 34.1 / 35.2 | 93% / 94% (1.4 s) | 2876 / 3687 ms | 20 ms |
| `yes \| head -c 200000000` | 300 MB | 269.0 / 266.2 s | 269.1 / 266.9 s | 1.11 / 1.12 | 90% / 71% | 218.4 / 179.1 s | not measured |

The Terminal.app baseline was opened with `osascript` (`do script`); the script timed itself with
perl `Time::HiRes`. While SwiftTerm streamed, the main run loop still answered: a block queued on
the main queue every 50 ms waited p50 4.0 ms, p95 6.3 ms, max 40 ms.

What this says:

- SwiftTerm is bound by lines, not bytes: about 600k lines/s for `seq`, about 370k lines/s for
  `yes` (single-character lines), and 35 MB/s when lines are long. `sample` puts the main thread in
  `BufferLine.clear`, `memmove` and Swift retain/release, which is the cost of scrolling.
- It beats Terminal.app on `seq` (1.6x faster) and `cat` (2 to 2.6x faster). It is 1.2 to 1.5x
  slower on the `yes` flood. The window sizes differ (Terminal 120x30, SwiftTerm 144x52), so treat
  this as the same order of magnitude, not as a ranking.
- iTerm2 is not installed, so there is no iTerm2 baseline.

Screenshot: `screenshots/A-seq.png`.

## B. Many tabs at once

### B1. Five tabs firehosing `while true; do seq 1 20000; done` for 20 s per phase

There was also a sixth, idle tab running `cat`. Once a second, a keystroke was injected into the
visible streaming tab's PTY and another into the idle tab's PTY, each timed until its echo was fed
back.

| | One visible + four hidden | All five + idle visible (2x3 grid) |
|---|---|---|
| Main-thread CPU | 94.9% | 94.8% |
| Process CPU (rusage) | 219% | 222% |
| `ps` %cpu p50 / p95 | 124 / 342% | 230 / 335% |
| Throughput per tab | 0.85 to 0.95 MB/s (4.6 MB/s total) | 0.89 to 1.08 MB/s (5.0 MB/s total) |
| Echo in the **visible streaming** tab | 511 to 1073 ms; 9 of 11 tries got no echo within 2 s | 1246 ms; 9 of 10 got no echo within 2 s |
| Echo in the **idle** tab | p50 22.4 ms, max 22.7 ms | p50 21.6 ms, max 22.7 ms |
| Main run-loop wait | p50 22 ms, p95 23 ms, max 96 ms | p50 22 ms, p95 23 ms, max 87 ms |
| App footprint | 93 MB before → 464 MB | 435 MB |
| App RSS | 663 to 924 MB | 725 to 840 MB |

Every SwiftTerm `LocalProcessTerminalView` parses on the **main thread**, so the five floods share
one core. Hidden tabs cost as much as visible ones: hiding skips drawing, not parsing. The rest of
the app stays usable (idle-tab echo about 22 ms, run loop about 22 ms). A flooding tab's own echo
waits behind its output queue, about 0.5 to 1.2 s, or longer than 2 s. The memory growth during a
flood is SwiftTerm's per-tab pending-chunk buffer (up to 4 MB before it applies backpressure) plus
allocator churn. It falls back once the flood stops (37 MB footprint at rest; see F). Screenshots:
`screenshots/B-oneVisibleFourHidden.png`, `screenshots/B-allFiveVisibleGrid.png`.

### B2. Five TUI-style full-screen redraw loops (the Claude Code pattern, exaggerated)

Each tab redraws its whole screen in 256 colours 30 times a second (a perl loop on the alternate
screen). A sixth idle tab measured echo.

| | 2x3 grid, all visible (46x26 cells each) | One visible full-size (144x52), four hidden |
|---|---|---|
| Frames each tab got through in 20 s (target 600) | 598 to 600 | 594 to 597 |
| Process CPU (rusage) | 32.7% | 31.9% |
| Main-thread CPU | 25.9% | 24.8% |
| Idle-tab echo | p50 5.6 ms, p95 11.0 ms | p50 6.9 ms, p95 15.2 ms |
| Main run-loop wait | p50 0.02 ms, p95 3.9 ms | p50 0.02 ms, p95 6.7 ms |

Screenshot: `screenshots/B-redraw-grid.png`.

### B3. Five real, idle Claude Code TUIs (`claude` started, no prompt sent)

Measured over 15 s after an 8 s warm-up: app CPU **6.0%** (rusage), main thread **2.1%**, app RSS
76 MB. The five `claude` processes themselves add up to **2081 MB RSS**, about 416 MB each. That is
Claude Code's own cost and is the same under any terminal or Electron.
Screenshot: `screenshots/B-five-claudes-grid.png`.

## C. TUI fidelity: claude, vim, top, 256-colour/truecolor

`screencapture -l <windowid>` failed with "could not create image from window", the same as
`screencapture -x` of the whole screen. This process has no Screen Recording permission. The
screenshots were therefore rendered by the app itself (`cacheDisplay` per view, `takeSnapshot` for
the WKWebView). Two caveats:

- SwiftTerm leaves default-background cells transparent and relies on its layer's background
  colour, which `cacheDisplay` does not paint. A plain capture shows light text on white, so each
  terminal is composited over its background colour.
- In some captures the 28 pt tab strip shows as a black band. That is an artifact of the capture,
  not something the window does.

These captures show what SwiftTerm draws, not what WindowServer puts on screen.

| Check | Result |
|---|---|
| Claude Code welcome screen, prompt box, status line, colours, block-art logo | correct at 144x52, 88x34 and 187x59 (`C-claude-*.png`) |
| After 20 rapid programmatic resizes between 900x600 and 1400x900 | claude redrew correctly at the final size, 160x58 (`C-claude-after-resize-stress.png`) |
| Time for one resize (setContentSize + layout + display) | p50 2.8 ms, p95 4.1 ms, max 4.6 ms |
| `vim -R`, `top -o cpu` (with reverse-video header) | correct (`C-vim-1280x820.png`, `C-top-1280x820.png`) |
| 256-colour cube, truecolor gradients, bold/italic/underline/strike, box drawing, CJK, emoji | all render (`C-colors-*.png`). The narrow 860 px window wraps the 96-column gradient, which is expected. |

Inherited environment: the first claude capture showed "Transcript saving is off — inherited
CLAUDE_CODE_CHILD_SESSION". The spike was launched from a Claude Code session, so it now strips
`CLAUDE_CODE*` and `CLAUDECODE*` from tab environments. The real app must do the same if it can be
launched from an agent.

## D. Container agent: not measured

`node dist/index.js ct list --json` returned `"containers": []` (only orphaned volumes and a network
for `feat-y`). The brief says not to start one, so this is a manual step (below).

## E. Monaco diff editor in one WKWebView

Monaco is served from `spike://app/` by a `WKURLSchemeHandler`; the handler served 23 requests with
0 failures. Swift sends `{original, modified, language}` with `callAsyncJavaScript`, and the page
posts back through `WKScriptMessageHandler`. The diff is `src/commands/container.ts`. The brief
asked for `HEAD~1`, but HEAD did not touch the file (another session kept committing), so the spike
falls back to the parent of the last commit that did (`diffBase` in the JSON): 1408 → 1411 lines.

| Metric | Value |
|---|---|
| WKWebView created → Monaco loaded (`ready`) | 674 ms (final run); 300 to 704 ms across 8 runs |
| WKWebView created → diff computed (`onDidUpdateDiff`) | 870 ms (final); 469 to 939 ms |
| WKWebView created → diff on screen (two rAFs after `onDidUpdateDiff`) | 888 ms (final); 487 to 965 ms |
| Inside the page: `setModel` → diff on screen | 160 to 320 ms |
| WebContent footprint, language `typescript` | 338 to 421 MB |
| WebContent footprint, `typescript` with `?diagnostics=0` | 312 to 370 MB |
| WebContent footprint, language `plaintext` | **169 MB** |
| GPU process / Networking process footprint | 13 to 26 MB / 6.6 MB |

Monaco's TypeScript language worker adds 170 to 250 MB on its own. A read-only diff viewer does not
need it: highlight with a Monarch tokenizer, or keep the TS worker out of the build.

`requestAnimationFrame` does not run while WebKit thinks the window is hidden or occluded. One run
never got "on screen" (the window was behind the user's other apps), so the page also posts
`diffComputed`.

Keys with the WKWebView focused, sent through `NSApp.sendEvent` (see Key routing for what this
covers):

| Key | Result |
|---|---|
| Cmd+F | Monaco's find widget opens (`.find-widget.visible`; `E-monaco-find.png`) |
| Cmd+C after select-all in the modified side | pasteboard holds 76,206 chars, equal to the selection |
| Cmd+Shift+] (menu "Next Tab") | fires from the webview and from a terminal |
| Cmd+W (menu "Close Tab") | fires from a terminal and from the webview |

The page also saw every one of these keydowns (`metaKeysSeenByPage: f, c, }, w`). WebKit gives the
page the key first, and the menu gets it when the page does not `preventDefault`.

## F. Memory overall: 5 shell tabs + 1 diff tab (TypeScript)

| Process | Footprint | RSS |
|---|---|---|
| NativeIDESpike (AppKit + 5 SwiftTerm views), sampled from outside at steady state | **37 MB** | 64 to 87 MB |
| same, measured from inside right after a full-window capture (capture bitmaps included) | 112 to 281 MB | |
| WebContent (Monaco + TS worker) | 387 to 402 MB | 25 to 352 MB (compressed under pressure) |
| WebKit GPU + Networking | 22 MB | 22 to 40 MB |
| 5 login shells (zsh) | | 24 to 40 MB |
| **App + WebKit total** | **about 445 MB with the TS worker, about 230 MB with `plaintext`** | |

Electron comparison (not measured here; the brief's documented figure): about 150 MB idle for
Chromium alone, before Monaco. That Electron app would also run Monaco, with the same TS-worker cost,
in its renderer, plus xterm.js for every terminal. The native shell's own share is about 37 MB plus
the WebKit helpers' 22 MB, against Chromium's 150 MB base. The Monaco page costs about the same in
either design.

## Key routing: what was needed

- **A standard Edit menu** (Undo, Redo, Cut, Copy, Paste, Select All, all sent to the first
  responder) is required. WKWebView and SwiftTerm both implement `copy:`/`paste:`/`selectAll:`, and
  Cmd+C only reaches them as a menu key equivalent. **Do not add a Find (Cmd+F) item.** It would
  take Cmd+F before Monaco sees it.
- **Cmd+Shift+] is the key equivalent `}` with Cmd**, like Safari's tab shortcuts. AppKit compares
  `charactersIgnoringModifiers`, which keeps Shift, so `]` with Shift+Cmd would never match.
- Nothing else. No `performKeyEquivalent` overrides were needed on SwiftTerm or WKWebView. Menu
  actions use nil-targeted selectors, and the window controller is in the responder chain.
- Menu key equivalents only fire while the app is active. During the runs the user's apps took
  activation back several times and the menu shortcuts then did nothing. The bench re-activates the
  app before each key; the log in `results/monaco.json` shows the app was active for every key.
- **Not verified with real hardware events.** `osascript` → System Events keystrokes are denied
  ("osascript is not allowed to send keystrokes", error 1002: no Accessibility permission). Events
  sent with `NSApp.sendEvent` exercise AppKit's dispatch (key window → `performKeyEquivalent` →
  main menu → first responder, and WebKit's round trip to the web process), but not WindowServer
  delivery. See manual checks.

## Workarounds needed

1. **SwiftTerm and the Command Line Tools.** SwiftTerm 1.12 and later list `Shaders.metal` as a
   `.process()` resource, which needs the `metal` compiler, and only Xcode ships it (`error: unable
   to spawn process 'metal'`). `scripts/prepare-swiftterm.sh` clones tag v1.20.0 into `vendor/`
   (gitignored) and changes that one line to `.copy()`. SwiftTerm's `makeLibrary()` then compiles
   the shader source at runtime, which is its documented fallback. Package.swift depends on the
   patched path. A real app would want an upstream fix or an Xcode build. Older SwiftTerm releases
   would build without the patch but lack the 2026 backpressure and redraw work.
2. **SDK.** The app is AppKit only, so the newest CLT SDK works. The macos-app SDK fallback loop is
   kept in `bundle.sh` but was not needed.
3. **Scheme handler, not file://.** Monaco 0.57's AMD build loads from `spike://app/vs` and starts
   its workers from the same origin with no errors. (0.57 deprecates the AMD build; a real app would
   bundle the ESM build with its own `getWorker`.)
4. **Login-shell PATH** (`$SHELL -l -i -c …`) took 1.3 to 2.0 s on this machine (the user's zsh
   startup). The spike blocks on it at launch; the real app must resolve it off the main thread.
5. **App Nap and occlusion.** Each bench calls `beginActivity(.userInitiated, .latencyCritical)`. The
   real app needs a policy for background tabs; WebKit already pauses rAF when occluded.
6. **In-app screenshots.** Without Screen Recording permission, see C.
7. **One crash.** One `--bench all` run crashed **after its last bench** (SIGSEGV in
   `WebKit::RemoteLayerTreeHost::updateLayerTree` → `swift_task_isCurrentExecutor`, i.e. a WebKit
   layer commit landing during teardown). That run wrote no JSON. The benches were then run one per
   process (`results/*.json`, saved after each bench) and did not crash in 9 more runs. It looks
   like a teardown race in the spike, but it is a WebKit-in-AppKit crash worth watching.

## Manual check by the user (2026-10-23)

The user ran the demo app (`open build/NativeIDESpike.app`) and reported "all good" for checks 1
and 2 below: real Cmd+F, Cmd+C, Cmd+Shift+] and Cmd+W in the diff and terminal tabs, and the
on-screen look while dragging the window to resize it. Checks 3 to 5 are still open.

## Manual checks left for you

1. **Real keystrokes.** Run `spikes/native-ide/scripts/bundle.sh`, then `open
   spikes/native-ide/build/NativeIDESpike.app`. In "kunj (host)", click the "diff container.ts" tab
   and click into the right-hand editor, then:
   - press Cmd+F: Monaco's find bar opens; Esc closes it;
   - press Cmd+A, Cmd+C, then paste into another app: the file text arrives;
   - press Cmd+Shift+]: the next tab (claude) shows;
   - in a terminal tab, press Cmd+Shift+] and Cmd+W: they switch and close tabs; Cmd+C/Cmd+V copy
     and paste in the terminal.
   Optional: give the terminal app that runs the bench Accessibility permission and run
   `build/NativeIDESpike.app/Contents/MacOS/NativeIDESpike --bench keys --out k.json`;
   `systemEvents` in the JSON then holds the HID-path results.
2. **On-screen look.** The screenshots are in-app renders. Look at the demo window yourself:
   claude's prompt box, the status line, and live resizing by dragging the window corner (the bench
   only resized programmatically). Check that the redraw looks smooth and the text reflows.
3. **Container agent (D).** With a kunj branch container running (`kunj ct start <branch>`), open
   the demo app, select "feature/y (container)", run `node dist/index.js ct shell <branch>` in its
   tab, then run `claude`, `vim`, `top` and the colour test (the `colortest` string in
   `Sources/NativeIDESpike/Bench.swift`) inside it. Resize the window and look for drawing faults.
4. **iTerm2 baseline.** iTerm2 is not installed. If you want one, run `time seq 1 2000000` and
   `time cat <50 MB file>` in an iTerm2 window of about 144x52.
5. **Metal renderer.** `--bench throughput --metal` and `--bench multi --metal` were not run. The
   runtime shader compile inside the bundled .app also depends on SwiftPM's resource-bundle lookup,
   which was not verified.

## Verdict

**SwiftTerm is good enough for many live Claude Code agents, with one design caveat.** Five
full-screen 30 fps colour redraws, a heavier load than Claude Code produces, all kept their frame
rate at about 32% of one core with a 6 ms keystroke echo elsewhere. Five real idle Claude TUIs cost
the app 6% CPU and about 75 MB, and claude, vim, top and truecolor all render correctly through
repeated resizes. The caveat: every tab parses on the main thread, hidden or not. Five tabs dumping
output at full speed hold the main thread at 95% and push the app's footprint to about 450 MB while
it lasts. The UI still answers within about 22 ms, but the flooding tabs' own echo lags 0.5 to
1.2 s. The real app should move parsing off the main thread per tab, or throttle hidden tabs,
before many agents can run builds or test floods at once. Raw speed equals or beats Terminal.app
for `seq` and `cat` and trails it on single-character-line floods.

**A single WKWebView is good enough for the editor.** Monaco's diff editor boots and renders a
1400-line diff 0.5 to 0.95 s after the webview is created. Cmd+F, Cmd+C and the app's menu shortcuts
all route correctly with nothing more than a standard Edit menu (confirmed by the user with real
key presses). Its memory cost (about 170 MB without the TypeScript worker, about 400 MB with it) belongs
to Monaco and would be the same in Electron. The native shell itself is about 37 MB plus 22 MB of
WebKit helpers, against Chromium's about 150 MB baseline.
