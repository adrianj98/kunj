# Workspace app: design package

The visual direction for the workspace app (`docs/specs/workspace-ide.md`). Received 2026-10-23 as a
design handoff; it is the source of truth for what the app looks like, not for how it is built.
Technical remarks in these files (xterm.js, Electron, `vibrancy` on a BrowserWindow, CSS custom
properties) predate the runtime decision and are ignored: the app is native (AppKit + SwiftTerm,
Monaco in one WKWebView), see the spec.

```
design/DESIGN.md                      principles, layout, type, themes, accessibility
design/tokens.json                    three themes as one token shape, plus layout constants
design/mockups/{warm,light,graphite}  rendered reference (1440×900 @2x) and the standalone HTML
design/source/                        canvas source the mockups were generated from
```

The app must look like `design/mockups/warm.png`. `tokens.json` is read by the app's build
(`workspace-app/scripts/gen-tokens.*`) so colours and layout constants are never retyped by hand.
