import Foundation

/// What the header's buttons, the overflow menu and the port links can do to an environment.
public enum EnvAction: Equatable, Sendable {
    case ctStart, ctStop, ctRemove(force: Bool), ctRebuild, ctOpen
    case worktreeOpen, worktreeOpenNewWindow, worktreeRemove(force: Bool)
    case createPR, prune, copyPath, copyBranch, revealInFinder, openPort(Int)
}

/// How `ActionRunner` carries out an action: `terminal` runs `kunj <args>` in an action tab (in
/// `cwd`, else the repository root), `run` runs `kunj <args> --json` and reads `RunResultJson`,
/// `external` opens a URL, `local` hands a path (or container name) to copy or reveal, and
/// `disabled` greys the control out with `reason` as its tooltip.
public enum ActionPlan: Equatable, Sendable {
    case terminal(args: [String], title: String, cwd: String?)
    case run(args: [String])
    case external(url: String)
    case local(String)
    case disabled(reason: String)
}

private func terminal(_ args: [String], cwd: String? = nil) -> ActionPlan {
    .terminal(args: args, title: args.prefix(2).joined(separator: " "), cwd: cwd)
}

/// The plan for `action` on `env`. `worktreeOfSameBranch` is the host worktree of a container's
/// branch, where `kunj pr` runs for a container environment.
public func actionPlan(_ action: EnvAction, env: Environment, worktreeOfSameBranch: Environment?) -> ActionPlan {
    let branch = env.branch
    let isContainer = env.kind == .container
    let containerOnly = ActionPlan.disabled(reason: "Only for a container")
    let worktreeOnly = ActionPlan.disabled(reason: "Only for a worktree")
    let missing = ActionPlan.disabled(reason: "The worktree directory is missing")

    switch action {
    case .ctStart:
        guard isContainer else { return containerOnly }
        if env.state == .running { return .disabled(reason: "The container is running") }
        return terminal(["ct", "start", branch])
    case .ctStop:
        guard isContainer else { return containerOnly }
        if env.state != .running { return .disabled(reason: "The container is stopped") }
        return .run(args: ["ct", "stop", branch])
    case .ctRemove(let force):
        guard isContainer else { return containerOnly }
        return terminal(["ct", "remove", branch] + (force ? ["--force"] : []))
    case .ctRebuild:
        guard isContainer else { return containerOnly }
        return terminal(["ct", "start", branch, "--rebuild"])
    case .ctOpen:
        // `ct open` resumes a stopped container itself.
        guard isContainer else { return containerOnly }
        return .run(args: ["ct", "open", branch])
    case .worktreeOpen:
        guard !isContainer, let path = env.path else { return worktreeOnly }
        guard env.exists else { return missing }
        return .run(args: ["worktree", "open", path])
    case .worktreeOpenNewWindow:
        guard !isContainer, let path = env.path else { return worktreeOnly }
        guard env.exists else { return missing }
        return .run(args: ["worktree", "open", path, "--new-window"])
    case .worktreeRemove(let force):
        guard !isContainer, let path = env.path else { return worktreeOnly }
        if env.isMain { return .disabled(reason: "The main worktree cannot be removed") }
        return terminal(["worktree", "remove", path] + (force ? ["--force"] : []))
    case .createPR:
        let host = isContainer ? worktreeOfSameBranch : env
        guard let host, let path = host.path else {
            return .disabled(reason: "Create PRs from a worktree of this branch")
        }
        guard host.exists else { return missing }
        return terminal(["pr"], cwd: path)
    case .prune:
        return terminal(["ct", "prune"])
    case .copyPath:
        if isContainer { return env.containerName.map(ActionPlan.local) ?? containerOnly }
        return env.path.map(ActionPlan.local) ?? worktreeOnly
    case .copyBranch:
        return .local(branch)
    case .revealInFinder:
        guard !isContainer, let path = env.path else {
            return .disabled(reason: "A container has no folder on this Mac")
        }
        guard env.exists else { return missing }
        return .local(path)
    case .openPort(let port):
        return .external(url: "http://localhost:\(port)")
    }
}

/// What the New session sheet asks for.
public struct NewSessionRequest: Equatable, Sendable {
    public var repo: RepoRef
    public var branch: String
    /// nil or blank: the repository default (`preferences.defaultBaseBranch`, else origin/HEAD)
    public var base: String?
    public var kind: EnvironmentKind
    public var startAgent: Bool

    public init(repo: RepoRef, branch: String, base: String?, kind: EnvironmentKind, startAgent: Bool) {
        self.repo = repo
        self.branch = branch
        self.base = base
        self.kind = kind
        self.startAgent = startAgent
    }
}

/// `kunj worktree add <branch> -c [--base <b>]` or `kunj ct start <branch> -c [--base <b>]` in an
/// action tab (run in the repository root). The agent, when asked for, is opened by the runner
/// once the new environment appears.
public func newSessionPlan(_ r: NewSessionRequest) -> ActionPlan {
    let base = r.base?.trimmingCharacters(in: .whitespaces) ?? ""
    let extra = base.isEmpty ? [] : ["--base", base]
    switch r.kind {
    case .worktree: return terminal(["worktree", "add", r.branch, "-c"] + extra)
    case .container: return terminal(["ct", "start", r.branch, "-c"] + extra)
    }
}

/// `git check-ref-format --branch` rules, as the sheet checks them before running kunj: not empty,
/// no space or control character, none of `~ ^ : ? * [ \`, no `..`, `@{` or `//`, not `@`, not
/// starting with `-` or `/`, not ending with `/` or `.`, and no component starting with `.` or
/// ending with `.lock`.
public func isValidBranchName(_ name: String) -> Bool {
    if name.isEmpty || name == "@" || name.hasPrefix("-") || name.hasPrefix("/") { return false }
    if name.hasSuffix("/") || name.hasSuffix(".") { return false }
    if name.contains("..") || name.contains("@{") || name.contains("//") { return false }
    for scalar in name.unicodeScalars {
        if scalar.value < 0x20 || scalar.value == 0x7F || scalar == " " { return false }
        if "~^:?*[\\".unicodeScalars.contains(scalar) { return false }
    }
    for component in name.split(separator: "/") {
        if component.hasPrefix(".") || component.hasSuffix(".lock") { return false }
    }
    return true
}

/// kunj settings the app shows in Settings. They are kunj's (global config), not the app's, so the
/// CLI and the app share them.
public enum KunjSetting: String, CaseIterable, Sendable {
    case agentTmux = "agent.tmux"
    case agentTmuxStatus = "agent.tmuxStatus"
    case containerUseGhToken = "container.useGhToken"

    /// kunj's default when the setting is not in any config file.
    public var defaultValue: Bool {
        switch self {
        case .agentTmux: return true
        case .agentTmuxStatus: return false
        case .containerUseGhToken: return true
        }
    }
}

/// `kunj config --get <key> --global` (run with `--json`, in the home directory).
public func configGetArgs(_ setting: KunjSetting) -> [String] {
    ["config", "--get", setting.rawValue, "--global"]
}

/// `kunj config --set <key>=<bool> --global`.
public func configSetArgs(_ setting: KunjSetting, _ value: Bool) -> [String] {
    ["config", "--set", "\(setting.rawValue)=\(value)", "--global"]
}

/// `kunj config --get <key> --json`: `{ key, value }`, `value` absent when the key is not set
/// anywhere. `bool` is the value as a boolean (also from `"true"`/`"false"`), nil otherwise.
public struct ConfigValueJson: Decodable, Equatable, Sendable {
    public var key: String
    public var bool: Bool?

    private enum CodingKeys: String, CodingKey { case key, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        if let b = try? c.decode(Bool.self, forKey: .value) {
            bool = b
        } else if let s = try? c.decode(String.self, forKey: .value) {
            bool = s == "true" ? true : (s == "false" ? false : nil)
        } else {
            bool = nil
        }
    }
}

/// What a `.run` action answers: `{ success }`, plus `exec` from `ct open` when the editor cannot
/// attach to a container and `editorCommand` from `worktree open`.
public struct RunResultJson: Decodable, Equatable, Sendable {
    public var success: Bool
    public var exec: String?
    public var editorCommand: String?
}

/// How `ActionRunner` reports a `.run` action's answer.
public enum RunOutcome: Equatable, Sendable {
    case done
    case info(title: String, detail: String)
    case failed(title: String, detail: String)
}

/// `worktree open` exits 0 with `success: false` when the editor did not start (not on the PATH,
/// or `worktree.editorCommand` empty), which would otherwise do nothing visible.
public func runOutcome(_ args: [String], _ result: RunResultJson) -> RunOutcome {
    if !result.success {
        if args.first == "worktree", args.dropFirst().first == "open" {
            let command = result.editorCommand ?? ""
            return .failed(title: "The editor did not open", detail: command.isEmpty
                ? "worktree.editorCommand is empty, so kunj opens no editor."
                : "kunj could not start \(command) (worktree.editorCommand). Is it on your login PATH?")
        }
        return .failed(title: "kunj \(args.prefix(2).joined(separator: " ")) failed", detail: "kunj reported no success")
    }
    if let exec = result.exec {
        return .info(title: "The editor cannot attach to a container", detail: "Open a shell in it with:\n\(exec)")
    }
    return .done
}
