# kunj user docs

The user documentation site, built with [Astro Starlight](https://starlight.astro.build) from MDX
pages. It is published to GitHub Pages at <https://adrianj98.github.io/kunj/docs/>, next to the
landing page in `../site`.

```bash
cd docs-site
npm install
npm run dev      # http://localhost:4321/kunj/docs/
npm run build    # regenerates the reference data, then builds to dist/
```

`npm run dev` and `npm run build` first run `scripts/gen-reference.cjs`, which loads the CLI's
TypeScript sources (through the root `ts-node`, so run `npm install` in the repository root too) and
writes `src/data/{commands,settings,hooks}.json`. Those files are committed so the diff shows when a
change to the CLI changes the docs.

## Layout

- `src/content/docs/<section>/<page>.mdx` — one page per file; the sidebar groups are the
  directories (configured in `astro.config.mjs`), ordered by `sidebar.order` in the frontmatter.
- `src/components/` — components that render the generated reference data:
  - `<CommandReference name="worktree" />` — usage, aliases, options and the `--help` text of one
    command (`optionsOnly` hides the usage line and description).
  - `<SettingsTable category="worktree" />` or `<SettingsTable prefix="ai." />` — settings with type,
    default and description (`details={false}` drops the expandable long text).
  - `<HookTable filter="container" />` — hooks with their arguments.
  - `<AllCommands />` — every command (used by the command reference page).
- Starlight's own components (`Tabs`, `TabItem`, `Steps`, `Aside`, `Card`, `CardGrid`,
  `LinkCard`, `FileTree`) come from `@astrojs/starlight/components`.

## Writing a page

- Write for someone using kunj, not working on it: what a command does, when to reach for it, a
  realistic example, and what to expect. Leave implementation details to `CLAUDE.md` and the specs.
- Check behaviour against the source in `../src`; don't document from memory or old READMEs.
- Don't retype option tables: use `<CommandReference>` and `<SettingsTable>`, so they stay current.
- Link between pages with relative links ending in `/` (`../../worktrees/overview/`), because the site
  is served under `/kunj/docs/`.
- Commands go in fenced blocks with a language (`bash`, `json`, `zsh`).
