---
type: Application
title: Docs Site and Landing Page
description: The Astro Starlight user documentation in docs-site/ and the static landing page in site/, published together to GitHub Pages under /kunj/.
resource: docs-site
tags: [app, docs, astro, starlight, github-pages, landing-page]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

kunj has two web properties, deployed as one GitHub Pages site by `.github/workflows/pages.yml`:

* `site/`: a static landing page (`index.html`, `css/styles.css`, `js/main.js`) served at
  `https://adrianj98.github.io/kunj/`.
* `docs-site/`: the user documentation, an Astro Starlight site of MDX pages served at `/kunj/docs/`.

The docs are written for people using kunj. Implementation detail stays in `CLAUDE.md`, `docs/specs/`
and this bundle. The command, settings and hook reference is generated from the CLI's own definitions,
so those tables cannot drift from the code.

# docs-site

`astro.config.mjs` sets `site: 'https://adrianj98.github.io'`, `base: '/kunj/docs'`, a logo, a GitHub
social link, an edit link into `docs-site/` on `main`, `lastUpdated`, `src/styles/custom.css`, and the
sidebar groups. Each group except Workspace app autogenerates from a directory under
`src/content/docs/`:

| Sidebar group | Directory / slug |
| --- | --- |
| Getting started | `getting-started/` (introduction, installation, quick-start, setup) |
| Branches | `branches/` (create-and-switch, delete, diff-and-graph, git-flow, list, metadata, stash) |
| Commits & pull requests | `commits-and-prs/` (commit, commit-styles, pull-requests) |
| Worktrees | `worktrees/` (overview, agent, events, keep-files, macos-app, vscode-extension) |
| Containers | `containers/` (overview, commands, configuration, blueprints, presets, security, services) |
| Workspace app | `workspace-app` (single page) |
| Work logs & team | `work-logs/` (work-log, jira, slack, team, web-ui) |
| Configuration | `configuration/` (overview, files-and-data, hooks, secrets) |
| Integrations | `integrations/` (apps, aws-bedrock, shell) |
| Reference | `reference/` (commands, settings, hooks) |

Pinned dependencies: `astro` 7.3.5, `@astrojs/starlight` 0.42.5, `@astrojs/markdown-remark` 7.3.1.

# Generated reference

`scripts/gen-reference.cjs` (`npm run gen`, run first by `npm run dev` and `npm run build`) registers
the repository root's `ts-node` (`transpileOnly`, root `tsconfig.json`), so `npm install` is needed in
the root too. It loads the CLI sources and writes three committed files to `src/data/`:

| File | Source | Fields |
| --- | --- | --- |
| `commands.json` | `getAllCommands()` from `src/commands`, `getConfig()` of each | `name`, `usage`, `description`, `arguments`, `aliases`, `options` (plus a `--json` entry), `helpText` (ANSI stripped) |
| `settings.json` | `initializeSettings()` + `settingsRegistry.getAll()` | `key`, `type`, `category`, `default` (null when `sensitive`), `description`, `detailedDescription`, `options`, `examples`, `relatedSettings`, `sensitive` |
| `hooks.json` | `HOOKS`, `argVariableName` from `src/lib/hook-defs` | `name`, `description`, `args` (`name`, `env`, `variable`), `abortsOnFailure` |

`HOME` is set to a fake directory during generation and replaced with `~` in the output, so paths do
not depend on who built the docs. After changing a command's options, a setting or a hook, run
`npm run gen` and commit the JSON. Components in `src/components/` render it:
`CommandReference` (`name`, `optionsOnly`), `SettingsTable` (`category` or `prefix`, `details`),
`HookTable` (`filter`) and `AllCommands`. See the [Command System](/architecture/command-system.md),
[Settings Registry](/architecture/settings-registry.md) and [Hooks](/features/hooks.md).

Authoring rules (`docs-site/README.md`): check behaviour against `../src`, use the reference components
rather than retyped option tables, and link between pages with relative links ending in `/` because of
the `/kunj/docs/` base.

# Landing page

`site/index.html` (title "kunj — Git branches, evolved") has sections `hero`, a strip, `#features`,
`#commands`, `#ai`, `#graph`, `#integrations` and `#install`, and links to `docs/`. `site/js/main.js` adds
interactions with no build step: nav scroll state, a typed terminal demo (`typeTerminal`), a command
explorer (`renderExplorer`), commit style samples (`renderAI`) and an SVG branch graph (`drawGraph`),
honouring `prefers-reduced-motion`.

# Deployment

```
push to main touching site/**, docs-site/**, src/commands/**, src/settings/**,
src/lib/hook-defs.ts or pages.yml   (or workflow_dispatch)
  └─ npm ci (root, for ts-node and the CLI sources)
  └─ docs-site: npm ci && npm run build      (gen + astro build -> docs-site/dist)
  └─ _site/ = site/*  +  docs-site/dist -> _site/docs
  └─ configure-pages, upload-pages-artifact, deploy-pages   (concurrency group "pages")
```

Node 22 is used, with npm caching on both lockfiles. Because the reference is generated from `src/`,
CLI changes to commands, settings or hooks redeploy the docs.

# Related Concepts

* [Release Process](/architecture/release-process.md) - the other workflows
* [Command System](/architecture/command-system.md) - `getAllCommands()` and `CommandConfig`
* [Settings Registry](/architecture/settings-registry.md)
* [Hooks](/features/hooks.md) - `hook-defs.ts`
* [Workspace App](/apps/workspace-app.md), [macOS Menu Bar App](/apps/macos-app.md), [VS Code Extension](/apps/vscode-extension.md) - each has a user page here

# Citations

[1] [docs-site/astro.config.mjs](/docs-site/astro.config.mjs)
[2] [docs-site/package.json](/docs-site/package.json)
[3] [docs-site/scripts/gen-reference.cjs](/docs-site/scripts/gen-reference.cjs)
[4] [docs-site/README.md](/docs-site/README.md)
[5] [site/index.html](/site/index.html)
[6] [site/js/main.js](/site/js/main.js)
[7] [.github/workflows/pages.yml](/.github/workflows/pages.yml)
[8] [CLAUDE.md](/CLAUDE.md)
