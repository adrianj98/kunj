// App state: the known repositories (`kunj repos`) and each one's worktrees
// (`kunj worktree list`), refreshed on a timer, when the panel opens, and
// when ~/.kunj/worktree-sessions.json or repos.json change.

import AppKit
import Observation

struct RepoState: Identifiable {
    let repo: KnownRepo
    var listing: WorktreeListResult?
    var error: String?

    var id: String { repo.root }
    var worktrees: [Worktree] { listing?.worktrees ?? [] }
}

enum CLIState: Equatable {
    case unknown
    case ok
    case missing(String)
}

@MainActor
@Observable
final class AppStore {
    private(set) var repos: [RepoState] = []
    private(set) var cliState: CLIState = .unknown
    private(set) var isRefreshing = false
    private(set) var lastRefresh: Date?
    private(set) var logLines: [String] = []
    // Transient message shown at the bottom of the panel
    var flash: String?
    // Worktree paths with an action in flight, so their row can show it
    private(set) var busyWorktrees: Set<String> = []

    @ObservationIgnored let cli: KunjCLI
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored private var watcher: KunjDirWatcher?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pendingFresh = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var defaultsObserver: NSObjectProtocol?

    init() {
        Pref.register()
        var appendLog: ((String) -> Void)?
        cli = KunjCLI(command: UserDefaults.standard.kunjCliPath) { line in appendLog?(line) }
        appendLog = { [weak self] line in
            let stamped = "[\(Date().formatted(date: .omitted, time: .standard))] \(line)"
            Task { @MainActor in self?.appendLog(stamped) }
        }
    }

    func start() {
        notifier.requestAuthorization()
        watcher = KunjDirWatcher { [weak self] in self?.refresh() }
        watcher?.start()
        armTimer()
        // Settings changes: CLI path and refresh interval apply right away
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.defaultsChanged() }
        }
        refresh()
    }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 500 { logLines.removeFirst(logLines.count - 500) }
    }

    private var lastCliPath = UserDefaults.standard.kunjCliPath
    private var lastInterval = UserDefaults.standard.kunjRefreshInterval

    private func defaultsChanged() {
        let defaults = UserDefaults.standard
        if defaults.kunjCliPath != lastCliPath {
            lastCliPath = defaults.kunjCliPath
            cli.command = lastCliPath
            refresh()
        }
        if defaults.kunjRefreshInterval != lastInterval {
            lastInterval = defaults.kunjRefreshInterval
            armTimer()
        }
    }

    private func armTimer() {
        timer?.invalidate()
        let seconds = UserDefaults.standard.kunjRefreshInterval
        guard seconds > 0 else { timer = nil; return }
        timer = Timer.scheduledTimer(withTimeInterval: max(seconds, 10), repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // MARK: - Derived

    var allWorktrees: [(repo: String, worktree: Worktree)] {
        repos.flatMap { state in state.worktrees.map { (repo: state.repo.name, worktree: $0) } }
    }

    var failingChecksCount: Int {
        allWorktrees.filter { $0.worktree.pullRequest?.state == "open" && $0.worktree.pullRequest?.checks == "failure" }.count
    }

    // MARK: - Refresh

    // `fresh` bypasses the CLI's 60s pull request cache (manual refresh)
    func refresh(fresh: Bool = false) {
        pendingFresh = pendingFresh || fresh
        if isRefreshing {
            refreshAgain = true
            return
        }
        isRefreshing = true
        let useFresh = pendingFresh
        pendingFresh = false
        Task {
            await load(fresh: useFresh)
            isRefreshing = false
            lastRefresh = Date()
            watcher?.markSeen()
            if refreshAgain {
                refreshAgain = false
                refresh()
            }
        }
    }

    private func load(fresh: Bool) async {
        let known: [KnownRepo]
        do {
            known = try await cli.listRepos()
            cliState = .ok
        } catch let error as KunjCLIError {
            cliState = error.code == .notFound ? .missing(error.message) : .ok
            if error.code != .notFound { flash = error.message }
            return
        } catch {
            flash = error.localizedDescription
            return
        }

        let defaults = UserDefaults.standard
        let includeStatus = defaults.kunjShowStatus
        let includePRs = defaults.kunjShowPullRequests
        let cli = self.cli
        let previous = Dictionary(uniqueKeysWithValues: repos.map { ($0.id, $0) })

        // One CLI call per repository, all at once
        let results = await withTaskGroup(of: (Int, RepoState).self) { group in
            for (index, repo) in known.enumerated() {
                group.addTask {
                    guard repo.exists else {
                        return (index, RepoState(repo: repo, listing: nil, error: "Repository is missing"))
                    }
                    do {
                        let listing = try await cli.listWorktrees(repo: repo.root, includeStatus: includeStatus, includePullRequests: includePRs, fresh: fresh)
                        return (index, RepoState(repo: repo, listing: listing, error: nil))
                    } catch {
                        return (index, RepoState(repo: repo, listing: nil, error: error.localizedDescription))
                    }
                }
            }
            var collected: [(Int, RepoState)] = []
            for await result in group { collected.append(result) }
            return collected.sorted { $0.0 < $1.0 }.map { $0.1 }
        }

        // Keep the last good listing when a refresh fails transiently
        repos = results.map { state in
            if state.listing == nil, state.repo.exists, let old = previous[state.id], old.listing != nil {
                var kept = old
                kept.error = state.error
                return kept
            }
            return state
        }
        notifier.update(with: allWorktrees)
    }

    // MARK: - Actions

    private func perform(_ description: String, refreshAfter: Bool = true, _ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
            } catch {
                flash = "\(description) failed: \(error.localizedDescription)"
            }
            if refreshAfter { refresh() }
        }
    }

    func open(_ worktree: Worktree, in repo: KnownRepo, newWindow: Bool = false) {
        guard worktree.exists else {
            flash = "Worktree directory is missing: \(worktree.path)"
            return
        }
        guard !busyWorktrees.contains(worktree.path) else { return }
        busyWorktrees.insert(worktree.path)
        let started = Date()
        Task {
            do {
                try await cli.openWorktree(repo: repo.root, worktreePath: worktree.path, newWindow: newWindow)
                // The CLI returns as soon as the editor is launched. When the worktree was not open
                // yet, keep the spinner until the editor registers its session (the watcher refreshes
                // the listing when it does), or give up after a while.
                if !worktree.isActive {
                    while !isActive(worktree.path), Date().timeIntervalSince(started) < 15 {
                        try? await Task.sleep(for: .milliseconds(250))
                    }
                }
            } catch {
                flash = "Opening \(worktree.name) failed: \(error.localizedDescription)"
            }
            // Keep the spinner up long enough to be seen
            let remaining = 0.6 - Date().timeIntervalSince(started)
            if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
            busyWorktrees.remove(worktree.path)
        }
    }

    private func isActive(_ path: String) -> Bool {
        repos.contains { $0.worktrees.contains { $0.path == path && $0.isActive } }
    }

    func openPullRequest(_ worktree: Worktree, in repo: KnownRepo) {
        if let pr = worktree.pullRequest {
            Launcher.openURL(pr.url)
            return
        }
        guard worktree.branch != nil else { return }
        // Not in the cached listing (lookup disabled or PR just created): ask the CLI directly
        Task {
            do {
                if let pr = try await cli.getPullRequest(repo: repo.root, worktreePath: worktree.path) {
                    Launcher.openURL(pr.url)
                } else {
                    flash = "No pull request for \(worktree.name)"
                }
            } catch {
                flash = error.localizedDescription
            }
        }
    }

    func createPullRequest(_ worktree: Worktree) {
        Launcher.runInTerminal("\(cli.shellCommand) pr", cwd: worktree.path, title: "kunj-pr-\(worktree.name)")
    }

    func prune(_ repo: KnownRepo) {
        perform("Pruning \(repo.name)") { [weak self, cli] in
            let output = try await cli.pruneWorktrees(repo: repo.root)
            await MainActor.run { self?.flash = output.isEmpty ? "Nothing to prune in \(repo.name)" : output }
        }
    }

    func addRepository(path: String) {
        perform("Adding repository") { [cli] in try await cli.addRepo(path: path) }
    }

    func hideRepository(_ repo: KnownRepo) {
        perform("Removing \(repo.name)") { [cli] in try await cli.removeRepo(path: repo.root) }
    }

    // Mirrors the extension: confirm, force when the worktree is open or
    // dirty, and offer force when the CLI refuses
    func remove(_ worktree: Worktree, in repo: KnownRepo) {
        guard !worktree.isMain else {
            flash = "The main worktree cannot be removed"
            return
        }
        var warnings: [String] = []
        if !worktree.sessions.isEmpty {
            warnings.append("It is open in \(worktree.sessions.map(\.displayName).joined(separator: ", ")).")
        }
        if let status = worktree.status, status.dirty {
            warnings.append("It has \(status.changedFiles) uncommitted change(s).")
        }
        let needsForce = !warnings.isEmpty
        let message = ([worktree.path] + warnings).joined(separator: "\n\n")
        guard confirm("Remove worktree “\(worktree.name)”?", message, button: needsForce ? "Force Remove" : "Remove") else { return }

        Task {
            do {
                try await cli.removeWorktree(repo: repo.root, worktreePath: worktree.path, force: needsForce)
                flash = "Removed \(worktree.name)"
            } catch {
                let text = error.localizedDescription
                if !needsForce, text.range(of: "uncommitted|--force", options: [.regularExpression, .caseInsensitive]) != nil,
                   confirm("Remove “\(worktree.name)” anyway?", "\(text)\n\nForce removal discards uncommitted changes in the worktree.", button: "Force Remove") {
                    do {
                        try await cli.removeWorktree(repo: repo.root, worktreePath: worktree.path, force: true)
                        flash = "Removed \(worktree.name)"
                    } catch {
                        flash = "Remove failed: \(error.localizedDescription)"
                    }
                } else {
                    flash = "Remove failed: \(text)"
                }
            }
            refresh()
        }
    }

    private func confirm(_ title: String, _ message: String, button: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Cancel")
        if button.hasPrefix("Force") { alert.buttons.first?.hasDestructiveAction = true }
        return alert.runModal() == .alertFirstButtonReturn
    }
}
