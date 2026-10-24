// App state: the known repositories (`kunj repos`) and each one's worktrees and
// branch containers (`kunj worktree list --containers`), refreshed on a timer, when
// the panel opens, and when ~/.kunj/worktree-sessions.json or repos.json change.

import AppKit
import KunjBarCore
import Observation

struct RepoState: Identifiable {
    let repo: KnownRepo
    var listing: WorktreeListResult?
    var error: String?

    var id: String { repo.root }
    var worktrees: [Worktree] { listing?.worktrees ?? [] }
    var containers: [BranchContainer] { listing?.containers?.items ?? [] }
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
    // Container names with an action in flight (open, stop, forward)
    private(set) var busyContainers: Set<String> = []
    private(set) var isOrganizing = false
    private(set) var removingWorktrees: Set<String> = []
    // Selection mode: rows show checkboxes and the footer offers removing the checked worktrees
    var isSelecting = false {
        didSet { if !isSelecting { selectedWorktrees = [] } }
    }
    private(set) var selectedWorktrees: Set<String> = []

    @ObservationIgnored let cli: KunjCLI
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored private var watcher: KunjDirWatcher?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pendingFresh = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var defaultsObserver: NSObjectProtocol?
    // Set when the CLI refuses --containers (older than the option): list without it from then on
    @ObservationIgnored private var containersUnsupported = false
    @ObservationIgnored private var credentialsWarned = false

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
    private var lastShowContainers = UserDefaults.standard.kunjShowContainers

    private func defaultsChanged() {
        let defaults = UserDefaults.standard
        if defaults.kunjCliPath != lastCliPath {
            lastCliPath = defaults.kunjCliPath
            cli.command = lastCliPath
            refresh()
        }
        if defaults.kunjShowContainers != lastShowContainers {
            lastShowContainers = defaults.kunjShowContainers
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
        let includeContainers = defaults.kunjShowContainers && !containersUnsupported
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
                        let listing: WorktreeListResult
                        do {
                            listing = try await cli.listWorktrees(repo: repo.root, includeStatus: includeStatus, includePullRequests: includePRs, fresh: fresh, includeContainers: includeContainers)
                        } catch let error as KunjCLIError where includeContainers && error.message.range(of: "unknown option.*--containers", options: [.regularExpression, .caseInsensitive]) != nil {
                            await MainActor.run { self.containersUnsupported = true }
                            listing = try await cli.listWorktrees(repo: repo.root, includeStatus: includeStatus, includePullRequests: includePRs, fresh: fresh)
                        }
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

    // Organize Windows: one desktop per worktree on the chosen screen, windows tiled
    func organizeWindows() {
        guard !isOrganizing else { return }
        guard AXWindows.isTrusted(prompt: true) else {
            flash = "Grant Kunj Accessibility access in System Settings, then run Organize again"
            return
        }
        let defaults = UserDefaults.standard
        let kinds = defaults.kunjOrganizeKinds
        guard !kinds.isEmpty else { return }
        let worktrees = repos.flatMap { state in
            state.worktrees.filter(\.exists).map { WorktreeRef(path: $0.path, name: $0.name) }
        }
        let screen = defaults.kunjOrganizeScreen
        let layout = defaults.kunjOrganizeLayout
        let remembered = defaults.kunjOrganizeDesktops
        let terminalApps = Launcher.terminalApps
        let removeEmpty = defaults.kunjOrganizeRemoveEmptyDesktops
        let log = cli.log
        isOrganizing = true
        Task.detached {
            let result = Result { try Organizer(log: log).run(worktrees: worktrees, screenName: screen, layout: layout, kinds: kinds,
                                                             remembered: remembered, terminalApps: terminalApps, removeEmptyDesktops: removeEmpty) }
            await MainActor.run { self.finishOrganizing(result) }
        }
    }

    private func finishOrganizing(_ result: Result<Organizer.Outcome, Error>) {
        isOrganizing = false
        switch result {
        case .success(let outcome):
            UserDefaults.standard.kunjOrganizeDesktops = outcome.remembered
            guard outcome.desktops > 0 || outcome.groupsFailed > 0 else {
                flash = "Nothing to organize"
                return
            }
            var text = "Organized \(outcome.windows) window\(outcome.windows == 1 ? "" : "s") on \(outcome.desktops) desktop\(outcome.desktops == 1 ? "" : "s")"
            if outcome.windowsFailed > 0 { text += ", \(outcome.windowsFailed) window\(outcome.windowsFailed == 1 ? "" : "s") could not be moved" }
            if outcome.desktopsRemoved > 0 { text += ", removed \(outcome.desktopsRemoved) empty desktop\(outcome.desktopsRemoved == 1 ? "" : "s")" }
            if outcome.groupsFailed > 0 { text += ", \(outcome.groupsFailed) desktop\(outcome.groupsFailed == 1 ? "" : "s") skipped (see the log)" }
            if outcome.screenFellBack { text += " on \(outcome.screenName) (\(outcome.wantedScreen) is not attached)" }
            flash = text
        case .failure(let error as Spaces.MissingSymbol):
            flash = error.description
        case .failure(let error as MissionControl.Failure):
            let v = ProcessInfo.processInfo.operatingSystemVersion
            flash = "Could not drive Mission Control (macOS \(v.majorVersion).\(v.minorVersion)): \(error.step)"
        case .failure(let error):
            flash = "Organize failed: \(error.localizedDescription)"
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

    // MARK: - Containers

    // Long or interactive `kunj ct` commands (start, remove, prune, a foreground forward) run in a
    // terminal, like `kunj pr`; the listing picks the result up on the next refresh
    func runContainerCommand(_ args: [String], in repo: KnownRepo, title: String) {
        let line = ([cli.shellCommand] + args.map(shellQuote)).joined(separator: " ")
        Launcher.runInTerminal(line, cwd: repo.root, title: title)
    }

    func openContainer(_ container: BranchContainer, in repo: KnownRepo, newWindow: Bool = false) {
        guard !busyContainers.contains(container.name) else { return }
        busyContainers.insert(container.name)
        let started = Date()
        Task {
            do {
                let result = try await cli.openContainer(repo: repo.root, branch: container.branch, newWindow: newWindow)
                if result.exec != nil {
                    // worktree.editorCommand cannot attach to a container: a shell in it instead
                    runContainerCommand(["ct", "shell", container.branch], in: repo, title: "kunj-ct-\(container.branch)")
                } else if let warning = result.warning, !credentialsWarned {
                    credentialsWarned = true
                    flash = warning
                }
            } catch {
                flash = "Opening the container of \(container.branch) failed: \(error.localizedDescription)"
            }
            let remaining = 0.6 - Date().timeIntervalSince(started)
            if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
            busyContainers.remove(container.name)
            refresh()
        }
    }

    func stopContainer(_ container: BranchContainer, in repo: KnownRepo) {
        guard !busyContainers.contains(container.name) else { return }
        busyContainers.insert(container.name)
        Task {
            do {
                try await cli.stopContainer(repo: repo.root, branch: container.branch)
            } catch {
                flash = "Stopping \(container.branch) failed: \(error.localizedDescription)"
            }
            busyContainers.remove(container.name)
            refresh()
        }
    }

    func autoForward(_ container: BranchContainer, in repo: KnownRepo) {
        perform("Forwarding the ports of \(container.branch)") { [weak self, cli] in
            try await cli.autoForward(repo: repo.root, branch: container.branch)
            await MainActor.run { self?.flash = "Forwarding the ports of \(container.branch) as they appear" }
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

    // MARK: - Removing

    func toggleSelected(_ worktree: Worktree) {
        guard !worktree.isMain else { return }
        isSelecting = true
        if selectedWorktrees.contains(worktree.path) { selectedWorktrees.remove(worktree.path) } else { selectedWorktrees.insert(worktree.path) }
    }

    func removeSelected() {
        let items = repos.flatMap { state in
            state.worktrees.filter { selectedWorktrees.contains($0.path) }.map { ($0, state.repo) }
        }
        remove(items) { [weak self] in self?.isSelecting = false }
    }

    func remove(_ worktree: Worktree, in repo: KnownRepo) {
        remove([(worktree, repo)])
    }

    // Mirrors the extension: one confirmation for all of them, force the ones
    // that are open or dirty, and offer force for those the CLI still refuses
    private func remove(_ items: [(Worktree, KnownRepo)], onConfirm: (() -> Void)? = nil) {
        let items = items.filter { !$0.0.isMain }
        guard !items.isEmpty else {
            flash = "The main worktree cannot be removed"
            return
        }
        func warnings(_ worktree: Worktree) -> [String] {
            var warnings: [String] = []
            if !worktree.sessions.isEmpty {
                warnings.append("open in \(worktree.sessions.map(\.displayName).joined(separator: ", "))")
            }
            if let status = worktree.status, status.dirty {
                warnings.append("dirty with \(status.changedFiles) uncommitted change(s)")
            }
            return warnings
        }
        let needsForce = Set(items.filter { !warnings($0.0).isEmpty }.map(\.0.path))

        let title: String
        let message: String
        if items.count == 1, let worktree = items.first?.0 {
            title = "Remove worktree “\(worktree.name)”?"
            let w = warnings(worktree)
            message = worktree.path + (w.isEmpty ? "" : "\n\nIt is \(w.joined(separator: ", ")).")
        } else {
            title = "Remove \(items.count) worktrees?"
            message = items.map { worktree, _ in
                let w = warnings(worktree)
                return "• \(worktree.name)\(w.isEmpty ? "" : " (\(w.joined(separator: ", ")))")"
            }.joined(separator: "\n")
        }
        guard confirm(title, message, button: needsForce.isEmpty ? "Remove" : "Force Remove") else { return }
        onConfirm?()

        removingWorktrees.formUnion(items.map(\.0.path))
        Task {
            var removed: [String] = []
            var refused: [(Worktree, KnownRepo)] = []
            var failures: [String] = []
            for (worktree, repo) in items {
                let force = needsForce.contains(worktree.path)
                do {
                    try await cli.removeWorktree(repo: repo.root, worktreePath: worktree.path, force: force)
                    removed.append(worktree.name)
                } catch {
                    let text = error.localizedDescription
                    if !force, text.range(of: "uncommitted|--force", options: [.regularExpression, .caseInsensitive]) != nil {
                        refused.append((worktree, repo))
                    } else {
                        failures.append(items.count == 1 ? text : "\(worktree.name): \(text)")
                    }
                }
            }
            if !refused.isEmpty {
                let names = refused.map { "“\($0.0.name)”" }.joined(separator: ", ")
                if confirm("Remove \(names) anyway?", "git refused because of uncommitted changes.\n\nForce removal discards uncommitted changes in the worktree.", button: "Force Remove") {
                    for (worktree, repo) in refused {
                        do {
                            try await cli.removeWorktree(repo: repo.root, worktreePath: worktree.path, force: true)
                            removed.append(worktree.name)
                        } catch {
                            failures.append(items.count == 1 ? error.localizedDescription : "\(worktree.name): \(error.localizedDescription)")
                        }
                    }
                }
            }
            removingWorktrees.subtract(items.map(\.0.path))
            var parts: [String] = []
            if !removed.isEmpty { parts.append(removed.count == 1 ? "Removed \(removed[0])" : "Removed \(removed.count) worktrees") }
            if !failures.isEmpty { parts.append("Remove failed: \(failures.joined(separator: "; "))") }
            if !parts.isEmpty { flash = parts.joined(separator: ". ") }
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
