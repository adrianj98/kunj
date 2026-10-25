# Architecture

Cross-cutting concepts that explain how the kunj CLI is built and the rules that govern its code.

# Concepts

* [System Overview](/architecture/system-overview.md) - What kunj is, the pieces it ships as, how they talk to each other at runtime, and what lives under ~/.kunj.
* [Command System](/architecture/command-system.md) - How kunj commands are declared (BaseCommand + CommandConfig), collected (getAllCommands, CommandRegistry) and wired into Commander, including --json and error printing.
* [Fast Path](/architecture/fast-path.md) - The startup shortcut that loads only the requested command for frequently invoked commands, and the performance rules that keep those commands cheap.
* [Settings Registry](/architecture/settings-registry.md) - The central registry where every kunj setting is declared with its type, default, category and help text, and from which the default config is generated.
* [Configuration](/architecture/configuration.md) - Two-tier JSON config (global ~/.kunj/config.json, per-repository ~/.kunj/<repo>/config.json), how the per-repo directory is resolved, the legacy ./.kunj migration, and loadConfig vs loadResolvedConfig.
* [Config Variables](/architecture/config-variables.md) - The ${name} expansion available in any config string, how the repository variables are resolved cheaply, and the shell-aware quoting used for hook commands.
* [Repo Identity and Registry](/architecture/repo-identity-and-registry.md) - How kunj names a repository (name, id, origin URL) for derived names, and the ~/.kunj/repos.json registry of repositories behind `kunj repos`.
* [Git Layer](/architecture/git-layer.md) - How kunj talks to git - the shared helpers in src/lib/git.ts, the worktree-specific helpers, status parsing (porcelain v1 and v2), bare-repository handling and GIT_OPTIONAL_LOCKS.
* [JSON Contract](/architecture/json-contract.md) - The published, type-only JSON contract of `kunj ... --json` in src/lib/json-types.ts, its consumers, the error shapes and the additive-only compatibility rule.

# Delivery

* [Release Process](/architecture/release-process.md) - How kunj is built, tested in CI, versioned at runtime and released by tag to npm and GitHub (with the VS Code extension and the two macOS apps as assets), plus the GitHub Pages deploy.
* [Testing](/architecture/testing.md) - The test layers of kunj - Jest unit tests with the FakeBackend, the opt-in Docker integration suite, the opt-in functional suite that drives the built CLI, and the Swift tests of the two macOS apps.
