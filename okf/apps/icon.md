---
title: kunj icon
tags: [icon, branding, macos-app, workspace-app, vscode-extension, docs-site]
---

# kunj icon

The icon is a yellow (`#FFD23F`) rounded tile with a dark `>` prompt and a four-point sparkle. Its sources
are `assets/icon/kunj-icon.svg` (64 px and up) and `assets/icon/kunj-icon-small.svg` (heavier strokes, for
32 px and below).

`scripts/gen-icons.sh` renders them with headless Chrome (`CHROME` overrides the path) and writes:

| Output | Used by |
| --- | --- |
| `macos-app/Resources/AppIcon.icns` | the menu bar app (Finder; it has no Dock icon) |
| `workspace-app/Resources/AppIcon.icns` | the Workspace app's Dock icon |
| `vscode-extension/media/icon.png` | the extension's marketplace icon (128 px, full bleed) |
| `docs-site/public/favicon.svg` | the docs favicon (Starlight's default path) |

The `.icns` tile fills 824 of 1024 px, as Apple's icon grid has it. Both Info.plists set
`CFBundleIconFile` = `AppIcon` and both `bundle.sh` copy the file into `Contents/Resources`. The outputs
are committed, so building needs no Chrome; rerun the script after changing an SVG. The docs logo
(`docs-site/src/assets/logo.svg`) and the landing page's favicon and brand mark (`site/favicon.svg`) are
copies of the small SVG. The VS Code activity-bar icon (`media/kunj.svg`) is a separate one-colour glyph.
