import AppKit
import KunjWorkspaceCore

/// `kunj ct open` / `worktree open --json`: `exec` is set when the configured editor cannot attach
/// to a container (the command to run instead).
private struct OpenResultJson: Decodable {
    var success: Bool
    var exec: String?
}

/// Carries out the header's buttons, the overflow menu, the port links and New session through
/// `actionPlan`/`newSessionPlan`: `.terminal` opens an action tab (`kunj <args>`), `.run` runs
/// `kunj <args> --json` and shows an alert when it fails, `.external` opens the URL, `.local` copies
/// or reveals. Removing a container or a worktree asks first, with a "Force" checkbox.
@MainActor
final class ActionRunner {
    /// The kunj CLI (nil before discovery: nothing runs).
    var cli: () -> KunjCLI? = { nil }
    /// The environments as the store has them.
    var repos: () -> [RepoEnvironments] = { [] }
    /// Opens an action tab running `spec` in `env`; returns false when it could not.
    var openAction: (Environment, TerminalSpec) -> Void = { _, _ in }
    /// Shows an inline message in the terminal column (a refused spec).
    var showMessage: (String) -> Void = { _ in }
    /// Selects an environment by id (a new session once it appears).
    var select: (String) -> Void = { _ in }
    /// Opens the agent in an environment (New session with "Start an agent").
    var openAgent: (Environment) -> Void = { _ in }
    /// The window alerts are attached to.
    var window: () -> NSWindow? = { nil }

    /// New sessions waiting for their environment to appear in a listing.
    private var pending: [(id: String, startAgent: Bool, until: Date)] = []
    /// How long a new session is waited for (a container's first start can build images).
    private static let pendingTimeout: TimeInterval = 30 * 60

    // MARK: plans

    /// The host worktree of a container's branch (`kunj pr` runs there).
    func worktreeOfSameBranch(_ env: Environment) -> Environment? {
        guard env.kind == .container else { return nil }
        return repos().first { $0.repo == env.repo }?.environments
            .first { $0.kind == .worktree && $0.branch == env.branch }
    }

    func plan(_ action: EnvAction, _ env: Environment) -> ActionPlan {
        actionPlan(action, env: env, worktreeOfSameBranch: worktreeOfSameBranch(env))
    }

    // MARK: running

    /// Runs `action` on `env`; removals confirm first.
    func perform(_ action: EnvAction, env: Environment) {
        switch action {
        case .ctRemove:
            confirmRemoval(title: "Remove the container for \(env.branch)?",
                           detail: "Its clone, volumes and services are deleted. Work not pushed to origin is lost; Force removes it even then.",
                           env: env) { force in self.execute(self.plan(.ctRemove(force: force), env), env: env, action: action) }
        case .worktreeRemove:
            confirmRemoval(title: "Remove the worktree \(env.branch)?",
                           detail: "\(env.path ?? "") is deleted; the branch stays. Force removes it even with uncommitted changes.",
                           env: env) { force in self.execute(self.plan(.worktreeRemove(force: force), env), env: env, action: action) }
        default:
            execute(plan(action, env), env: env, action: action)
        }
    }

    private func execute(_ plan: ActionPlan, env: Environment, action: EnvAction?) {
        switch plan {
        case .disabled(let reason):
            NSSound.beep()
            log("action \(String(describing: action)) refused: \(reason)")
        case .terminal(let args, _, let cwd):
            openTerminal(args: args, cwd: cwd, in: env)
        case .run(let args):
            run(args, env: env)
        case .external(let url):
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        case .local(let value):
            if case .revealInFinder = action {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: value)])
            } else {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(value, forType: .string)
            }
        }
    }

    private func openTerminal(args: [String], cwd: String?, in env: Environment) {
        guard let cli = cli() else { return }
        do {
            let spec = try terminalSpec(cli: cli, env: env, kind: .action, action: args, shell: AppDelegate.loginShell,
                                        terminalEnv: ProcessInfo.processInfo.environment, cwd: cwd)
            openAction(env, spec)
            log("action tab in \(env.id): kunj \(args.joined(separator: " "))\(cwd.map { " (cwd \($0))" } ?? "")")
        } catch let error as TerminalSpecError {
            showMessage(error.message)
        } catch {
            showMessage("\(error)")
        }
    }

    /// `kunj <args> --json` in the repository root (`ct open` may resume the container first, so
    /// it gets ten minutes); a failure is an alert.
    private func run(_ args: [String], env: Environment) {
        guard let cli = cli() else { return }
        let root = env.repo.root
        log("running kunj \(args.joined(separator: " ")) in \(root)")
        Task { @MainActor in
            do {
                let result: OpenResultJson = try await cli.run(args, cwd: root, timeout: 600)
                if let exec = result.exec {
                    self.alert("The editor cannot attach to a container", detail: "Open a shell in it with:\n\(exec)",
                               style: .informational)
                }
            } catch {
                let message = (error as? KunjCLIError)?.message ?? "\(error)"
                self.alert("kunj \(args.prefix(2).joined(separator: " ")) failed", detail: message, style: .warning)
            }
        }
    }

    // MARK: new session

    /// Runs `worktree add -c` / `ct start -c` in an action tab of the repository's main worktree
    /// (else another environment of it, else the selected one), then selects the new environment
    /// when a listing shows it and, when asked, opens its agent.
    func newSession(_ request: NewSessionRequest, fallback: Environment?) {
        guard case .terminal(let args, _, let cwd) = newSessionPlan(request) else { return }
        let envs = repos().first { $0.repo == request.repo }?.environments ?? []
        let host = envs.first { $0.kind == .worktree && $0.isMain }
            ?? envs.first { $0.kind == .worktree }
            ?? envs.first
            ?? fallback
        guard var host else {
            alert("No environment to run it in", detail: "Open a worktree of \(request.repo.name) first.", style: .warning)
            return
        }
        // the tab runs in the requested repository's root whatever environment holds it
        if host.repo != request.repo { host.repo = request.repo }
        let id = environmentId(repo: request.repo.name, kind: request.kind, branch: request.branch)
        pending.removeAll { $0.id == id }
        pending.append((id, request.startAgent, Date() + Self.pendingTimeout))
        select(host.id)
        openTerminal(args: args, cwd: cwd, in: host)
        listed(repos())
    }

    /// A listing arrived: a new session that appeared is selected (and its agent opened once it
    /// can run: a worktree that exists, a running container).
    func listed(_ repos: [RepoEnvironments]) {
        let now = Date()
        pending.removeAll { $0.until < now }
        guard !pending.isEmpty else { return }
        let all = repos.flatMap(\.environments)
        for p in pending {
            guard let env = all.first(where: { $0.id == p.id }) else { continue }
            let usable = env.kind == .worktree ? env.exists : env.state == .running
            guard usable else { continue }
            pending.removeAll { $0.id == p.id }
            select(env.id)
            if p.startAgent { openAgent(env) }
        }
    }

    // MARK: alerts

    private func confirmRemoval(title: String, detail: String, env: Environment, then: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        a.alertStyle = .warning
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        a.buttons[0].hasDestructiveAction = true
        let force = NSButton(checkboxWithTitle: "Force", target: nil, action: nil)
        force.setAccessibilityLabel("Force removal")
        a.accessoryView = force
        let handle = { (response: NSApplication.ModalResponse) in
            if response == .alertFirstButtonReturn { then(force.state == .on) }
        }
        if let w = window() { a.beginSheetModal(for: w, completionHandler: handle) } else { handle(a.runModal()) }
    }

    func alert(_ title: String, detail: String, style: NSAlert.Style) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        a.alertStyle = style
        if let w = window() { a.beginSheetModal(for: w) } else { a.runModal() }
    }

    // MARK: overflow menu

    /// The header's `…` menu: container start/stop/rebuild/remove, worktree remove, copy path,
    /// reveal in Finder and `ct prune`. Items of the other kind are left out; the rest are greyed
    /// with their reason as the tooltip.
    func overflowMenu(env: Environment) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let container: [(String, EnvAction)] = [
            ("Start Container", .ctStart), ("Stop Container", .ctStop),
            ("Rebuild Container", .ctRebuild), ("Remove Container…", .ctRemove(force: false)),
        ]
        let worktree: [(String, EnvAction)] = [("Remove Worktree…", .worktreeRemove(force: false))]
        let common: [(String, EnvAction)] = [
            (env.kind == .container ? "Copy Container Name" : "Copy Path", .copyPath),
            ("Reveal in Finder", .revealInFinder),
        ]
        let groups = env.kind == .container ? [container, common, [("Prune Containers…", EnvAction.prune)]]
                                            : [worktree, common, [("Prune Containers…", EnvAction.prune)]]
        for (i, group) in groups.enumerated() {
            if i > 0 { menu.addItem(.separator()) }
            for (title, action) in group {
                let p = plan(action, env)
                if case .disabled(let reason) = p, reason == "Only for a container" || reason == "Only for a worktree" { continue }
                if case .disabled = p, case .revealInFinder = action, env.kind == .container { continue }
                let item = MenuAction(title: title) { [weak self] in self?.perform(action, env: env) }
                if case .disabled(let reason) = p {
                    item.isEnabled = false
                    item.toolTip = reason
                }
                menu.addItem(item)
            }
        }
        return menu
    }
}

/// A menu item that runs a closure.
final class MenuAction: NSMenuItem {
    private let run: () -> Void
    init(title: String, keyEquivalent: String = "", run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: keyEquivalent)
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { run() }
}
