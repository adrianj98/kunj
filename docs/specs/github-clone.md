# Clone from GitHub

`kunj repos github` lists the GitHub repositories you can clone, `kunj repos clone` clones one and
adds it to `kunj repos`, and the workspace app's **Clone from GitHub…** sheet (⌥⌘N) does both.

## Status

| Part | State |
| --- | --- |
| `kunj repos github [--owner <login>] [--all] [--json]` (`GitHubReposJson`) | Shipped |
| `kunj repos clone <owner/name \| url> [--dir <path>] [--bare \| --no-bare] [--json]` (`RepoCloneJson`) | Shipped |
| Settings `repos.cloneDir` (default `~/projects`), `repos.cloneBare` (default false) | Shipped |
| Workspace app: Session > Clone from GitHub… (⌥⌘N) | Shipped |
| macOS menu bar app, VS Code extension | Not done |
| GitHub Enterprise hosts other than gh's default | Not done |

## Why

New work often starts in a repository that is not on the Mac yet. Finding its name on github.com,
cloning it by hand and then running kunj there to register it is three steps the app can do in one.

## Listing

One gh call: `gh api --paginate 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'`
with a `--jq` filter printing one object per line (src/lib/github-repos.ts, `listGitHubRepos()`). gh's
login, host and token apply; kunj stores nothing. Archived repositories are left out unless `--all`;
`--owner` keeps one user or organisation (any case). Newest push first.

Each repository's `local` is the root of a known repository (`repos.json`, hidden ones included) whose
origin points at it: `remoteKey()` turns https (userinfo stripped), `ssh://` and scp-like URLs into
`host/owner/name` (lower case, `.git` dropped), read from each repository's `config` file with
`readOriginUrl()`, so the listing costs no git call per repository.

Errors carry a code (`GitHubError`, printed as `{ error: { code, message } }` with `--json`):
`gh-missing` (gh not installed), `gh-auth` (not logged in), `gh-failed` (anything else, gh's last stderr
line).

## Cloning

`parseRepoArg()` accepts `owner/name` or a GitHub URL (https, ssh://, `git@host:owner/name`); a name
that starts with `-`, is `.`/`..` or has more segments is `bad-repo`, so the argument can never become a
gh or git option or leave the clone directory. The target is `<cloneDir>/<name>` (`--dir`, else
`repos.cloneDir` with `~` and `${home}` expanded); an existing target is `clone-exists`, refused before gh
runs. `gh repo clone <spec> <target>` clones, so gh's protocol preference (https or ssh) applies.

Bare (`--bare`, or `repos.cloneBare` unless `--no-bare`): `gh repo clone … -- --bare` into
`<cloneDir>/<name>.git`, then the clone is made to track origin like a normal one
(`remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`, `git fetch`), every local branch but
the default one is deleted (a bare clone copies all of origin's branches to local ones), and a
worktree for the default branch is added where `worktree.baseDir` puts it (by default
`<name>.git/kunj/worktrees/<branch>`) with its upstream set to `origin/<branch>`. A failure after the
clone is `clone-failed`, and the half-made `<name>.git` is removed so a retry is not `clone-exists`.

The new repository is added with `addRepo()` (un-hidden if it was hidden), so `kunj repos` and the
apps list it at once.

## Workspace app

`CloneRepoSheet` (workspace-app/Sources/KunjWorkspace/Sheets/), model and arguments in
`KunjWorkspaceCore/Model/GitHubRepos.swift`. Opening it runs `kunj repos github --json` (cwd home,
60 s); a search field filters by every word in the full name or description; repositories already here
are listed last, greyed, with their path, and cannot be cloned. Clone (or a double-click) runs
`kunj repos clone <owner/name> --json` (15 min) with a spinner, then closes the sheet and reloads the
environments. A kunj without `repos github` shows "This kunj is too old"; `gh-missing` and `gh-auth`
say what to do.

## Code map

| File | What |
| --- | --- |
| src/lib/github-repos.ts | `listGitHubRepos`, `remoteKey`, `localReposByRemote`, `parseRepoArg`, `cloneRepo`, `GitHubError` |
| src/lib/clone-defaults.ts | `DEFAULT_CLONE_DIR` (kept apart so the settings registry does not import config.ts through it) |
| src/settings/repos.ts | `repos.cloneDir`, `repos.cloneBare` |
| src/commands/repos.ts | the `github` and `clone` actions |
| src/lib/json-types.ts | `GitHubRepoJson`, `GitHubReposJson`, `RepoCloneJson` |
| workspace-app/…/Sheets/CloneRepoSheet.swift | the sheet |
| workspace-app/…/KunjWorkspaceCore/Model/GitHubRepos.swift | decoding, filter, arguments |
