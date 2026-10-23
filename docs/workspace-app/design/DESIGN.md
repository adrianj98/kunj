# Kunj Workspace — design direction

Companion to `spec/kunj-workspace-ide-spec.md`. The spec says what the app does and how it drives the kunj CLI; this file says what it looks like. Tokens are in `tokens.json`; rendered references are in `mockups/` (`warm.png`, `light.png`, `graphite.png`, plus the standalone HTML they were rendered from).

## Principles

1. **The agent is a terminal.** The agent pane is an xterm.js terminal attached to the tmux session kunj owns. No chat transcript, no composer, no message bubbles. Tool-call formatting is whatever Claude Code prints.
2. **Sessions are named by task, not branch.** A sidebar row is *task title · relative time*, with *branch · status verb* underneath. The branch is metadata; the status verb ("Waiting for input", "Running tests", "Merged #398", "Clean") is the thing you scan for.
3. **Monitor and review are two surfaces, side by side.** Left column: terminals (agent, shells, dev servers, preview) as tabs. Right column: Changes, always visible — file list and a Monaco diff. Nothing else competes for the main area.
4. **One tinted action.** Only the primary action (Create PR) is filled. Shell, Agent, Open in VS Code are outlined. Status colors (green running, amber waiting, red deletions) are the only other chroma.
5. **Tight geometry, hairline borders.** Radii 5–6px on controls, 12px on the window. 1px borders in `border`; no shadows, no gradients, no card-on-card.
6. **Keyboard hints inline.** ⌘K search, ⌘N new session, ⌘T shell, ⌘⇧A agent, ⌘O open in editor, ⌘⇧P create PR, ⌘1–9 switch session. Shown in mono at 10.5px next to the control.
7. **Navigation layer vs content layer** (Apple's Tahoe rule). Sidebar and header are the navigation layer; on macOS use `vibrancy: 'sidebar'` on the BrowserWindow with a transparent sidebar background so it picks up the desktop. Terminal and diff are content and stay opaque.

## Layout (1440×900 reference; everything fluid)

```
┌──────────┬────────────────────────────────────────────────────┐
│ sidebar  │ header  52px  (title, meta line, actions)           │
│ 272px    ├─────────────────────────────┬──────────────────────┤
│          │ tab bar 40px                │ Changes bar 40px     │
│ ⌘K       ├─────────────────────────────┼──────────┬───────────┤
│ groups   │ terminal (xterm.js)         │ file list│ diff      │
│ by repo  │ flex 11                     │ 196px    │ flex      │
│          │                             │          │ (Monaco)  │
│ + New    ├─────────────────────────────┴──────────┴───────────┤
│ session  │ status bar 28px                                     │
└──────────┴────────────────────────────────────────────────────┘
```

- **Sidebar row** (`padding 9px 10px`, radius 6): status dot 7px · title 13px/500 · time 11px mono, then branch (mono) · status (sans) at 11px, indented 15px to align under the title. Selected row: `raised` fill + `borderStrong` 1px border. Hover: `raised` at 50%.
- **Status dot**: `green` = agent running · `amber` = agent waiting for input · `idle` = no agent / stopped container. One dot per session, nothing else.
- **Header**: title 14px/600; meta line 11px mono in `muted` with `faintest` separators: repo / branch · kind · ahead/behind · PR (link) · ports. Actions right-aligned, 30px tall.
- **Tab bar**: segmented, 26px pills, active = `raised` fill. A tab shows a dot if its process has a notable state (agent waiting, dev server running). Right side: `tmux <session> · uptime`, split, new tab.
- **Terminal**: xterm.js with WebGL addon, 12.5px mono, line-height 1.6, 16–20px padding. Theme from `term*` tokens (background, foreground, brightBlack=termMuted, blue=termAccent, green, yellow=amber, red).
- **Changes**: header shows `N files · +adds −dels` and a scope select (vs origin/main · Uncommitted · Last commit). File list rows 28px: A/M/D letter in mono 10px (green/amber/red) · name · ± counts. Diff: Monaco diff editor, `addBg` for added lines, gutter numbers in `faintest`.
- **Status bar**: 11px mono in `muted`: container name · uptime · services · forwards, right side agent state + shortcut hint.

## Type

- Sans: Inter (or SF Pro via `-apple-system` on macOS). Body 13px, small 12px, caption 11px, letter-spacing −0.005em.
- Mono: JetBrains Mono (or SF Mono). Everything that is a branch, path, port, time, shortcut, or count is mono.

## Themes

Three themes share one token shape (`tokens.json → themes`). Each has a five-step text ramp (`text → text2 → muted → faint → faintest`), two surfaces above `bg` (`side`, `raised`), a hairline (`border`) and a control border (`borderStrong`).

| | warm (default) | light | graphite |
|---|---|---|---|
| Character | Warm charcoal, off-white primary | White content, warm-gray sidebar, near-black primary, light terminal | Cool neutral dark, indigo primary |
| Lineage | Warp | macOS Tahoe | Zed / Linear |

Implement as CSS custom properties on `:root[data-theme]`; the token names map 1:1. Follow `prefers-color-scheme` by default (light ↔ warm), with an explicit override in settings.

## Accessibility

- All text passes 4.5:1 on its surface, including 11px labels (`muted` on `bg`); `faint` and `faintest` are decorative only (separators, line numbers, hints) — never the sole carrier of information.
- Status is dot colour + status verb, never colour alone.
- Real `<button>`s, `aria-current` on the selected session/tab/file, `aria-label` on icon-only buttons.
- Touch/click targets ≥ 26px tall inside bars, 44px rows in the sidebar.

## Research notes (what the direction is based on)

- Conductor lists workspaces as task name + relative time with a status verb line; keeps a chat area and a changes panel side by side. → sidebar row shape, Changes column.
- Augment's survey of agent desktop apps: the common pattern is "one surface for spawning and monitoring agents and another for reviewing and integrating diffs." → two-column main area.
- Warp's design system: warm near-charcoal, off-white as the only "voltage", 3–6px radii, Inter + mono, no gradients. → warm theme and geometry.
- Apple's Liquid Glass guidance (macOS Tahoe): glass on the navigation layer (sidebar, toolbar) only, never on content; tint only the primary action. → vibrancy on sidebar, single filled button.
