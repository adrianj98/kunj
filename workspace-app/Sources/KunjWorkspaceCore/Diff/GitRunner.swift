import Foundation

/// Runs a short-lived command and returns its stdout and exit status. The seam DiffService's
/// tests replace to see which commands run (one `wc` for all untracked files in a container).
public protocol CommandRunner: Sendable {
    func run(_ argv: [String], cwd: String, env: [String: String], stdin: Data?) async throws
        -> (stdout: Data, exit: Int32)
}

/// Runs `argv[0]` with the rest as arguments (the same runner as kunj calls: pipes drained on
/// background threads, killed at `timeout`).
public struct ProcessRunner: CommandRunner {
    public var timeout: TimeInterval

    public init(timeout: TimeInterval = 60) {
        self.timeout = timeout
    }

    public func run(_ argv: [String], cwd: String, env: [String: String], stdin: Data?) async throws
        -> (stdout: Data, exit: Int32)
    {
        guard let executable = argv.first else { throw DiffError.commandFailed("empty command") }
        let output = try await runProcess(executable: executable, arguments: Array(argv.dropFirst()), cwd: cwd,
                                          environment: env, stdin: stdin, timeout: timeout)
        if output.timedOut {
            throw DiffError.commandFailed("\(argv.joined(separator: " ")) timed out after \(Int(timeout))s")
        }
        return (output.stdout, output.exit)
    }
}

public struct GitContext {
    /// Where diff content comes from: the worktree on disk, or the branch container through `kunj ct exec`.
    public enum Target: Equatable, Sendable {
        case worktree(path: String)
        case container(branch: String, repoRoot: String)
    }
}

/// How to run `git <args>` for a target. A worktree runs `/usr/bin/git -C <path>` with
/// `GIT_OPTIONAL_LOCKS=0` (so a read never rewrites the index, which is a `git` event and another
/// refresh); a container runs `kunj ct exec <branch> -- git …` in the repository root (kunj
/// execs in /workspace as the sandbox user). The env is the terminal environment either way.
public func gitArgv(_ target: GitContext.Target, cli: KunjCLI, _ args: [String])
    -> (argv: [String], cwd: String, env: [String: String])
{
    switch target {
    case .worktree(let path):
        return execArgv(target, cli: cli, ["/usr/bin/git", "-C", path] + args)
    case .container:
        return execArgv(target, cli: cli, ["git"] + args)
    }
}

/// `argv` run in the target: as given in the worktree (cwd = the worktree), through
/// `kunj ct exec <branch> -- <argv…>` in a container.
public func execArgv(_ target: GitContext.Target, cli: KunjCLI, _ argv: [String])
    -> (argv: [String], cwd: String, env: [String: String])
{
    switch target {
    case .worktree(let path):
        var env = ShellEnvironment.terminalEnvironment(path: cli.path)
        env["GIT_OPTIONAL_LOCKS"] = "0"
        return (argv, path, env)
    case .container(let branch, let repoRoot):
        let spec = cli.spawnSpec(["ct", "exec", branch, "--"] + argv, cwd: repoRoot)
        var env = spec.environment
        env["GIT_OPTIONAL_LOCKS"] = "0"
        return ([spec.executable] + spec.arguments, spec.cwd, env)
    }
}
