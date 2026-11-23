import AppKit
import KunjWorkspaceCore

/// The Overview (the sidebar's Overview item, Window ▸ Overview ⌘⇧O), shown in the main window's
/// middle panel: every running agent as a line of its plan's steps, with the current one marked,
/// subagents as loops, handed-off agents as branches and branch changes as markers
/// (`kunj agent overview --containers --json` per repository: kunj decides which agents, their
/// grouping, text and every position; the panel only draws that). The drop-down at the top picks the
/// repositories: those with an open session (the default), all of them, or one. Read once kunj is
/// connected and again whenever kunj reports a plan change or the listing changes, shown or not, so
/// opening the Overview draws the plans it already has at once; every 10 s as well while shown. A
/// click on a line opens that agent's tab. Spec: docs/specs/agent-overview.md.
@MainActor
final class OverviewPanel: NSView {
    var cli: KunjCLI?
    /// The listed repositories, in the sidebar's order.
    var repositories: () -> [RepoRef] = { [] }
    /// The roots of the repositories with an open session (the default scope).
    var openRepositories: () -> Set<String> = { [] }
    /// A click on an agent's line.
    var onOpen: ((OverviewLane, AgentOverviewJson.Repo) -> Void)?
    /// `--demo`: these instead of asking kunj.
    var demoRepos: [AgentOverviewJson]?
    /// True once plans have been shown (a screenshot waits for it).
    private(set) var isSettled = false
    /// Shown in the window (the main window's middle panel is selected, or the Overview window is open):
    /// drawing and the 10 s timer run only then; reads on kunj's changes run always.
    var isShown = false {
        didSet {
            guard isShown != oldValue else { return }
            if isShown { start() } else { stop() }
        }
    }

    /// Where the plans are drawn: the panel's own (the Overview window) or the sidebar's, beside its rows.
    let canvas: OverviewCanvas
    /// Set: the plans are drawn by the sidebar (the main window), and the panel is only the bar over them.
    private let beside: (((repos: [AgentOverviewJson], filter: OverviewFilter)?) -> Void)?
    let scroll = NSScrollView()
    private let summary = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let scopePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let filterControl = NSSegmentedControl(labels: OverviewFilter.allCases.map { $0.title }, trackingMode: .selectOne,
                                                   target: nil, action: nil)
    private let errorLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let emptyLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.body), color: .clear)
    private let legend = makeLabel(
        "● done   ◎ now (amber: waiting for you)   ○ to come   ◇ branch or worktree change   ╰╯ subagent   Click a line to open its agent",
        font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)

    private static let scopeKey = "overviewScope"
    /// Remembered: `open`, `all` or a repository root.
    private var scope: OverviewScope = {
        switch UserDefaults.standard.string(forKey: OverviewPanel.scopeKey) {
        case nil, "open"?: return .open
        case "all"?: return .all
        case let root?: return .repo(root)
        }
    }() {
        didSet {
            let raw: String
            switch scope { case .open: raw = "open"; case .all: raw = "all"; case .repo(let r): raw = r }
            UserDefaults.standard.set(raw, forKey: Self.scopeKey)
        }
    }

    private var repos: [AgentOverviewJson] = []
    /// Bumped on a scope change: a read started before it is dropped when it comes back.
    private var generation = 0
    /// What the drop-down lists now: it is rebuilt only when this changes (a tick must not swap the
    /// menu out while it is open).
    private var scopeMenuKey: [String] = []
    private var timer: Timer?
    private var loading = false
    private var again = false
    private var pending: DispatchWorkItem?
    /// `topInset`: room above the bar (the main window's header height, so it lines up with the sidebar's search).
    /// `canvas` and `beside`: the plans go to that canvas through `beside` (the sidebar places them by its
    /// rows); the panel is then only its bar and legend.
    init(topInset: CGFloat = 10, canvas: OverviewCanvas? = nil,
         beside: (((repos: [AgentOverviewJson], filter: OverviewFilter)?) -> Void)? = nil) {
        self.canvas = canvas ?? OverviewCanvas(frame: .zero)
        self.beside = beside
        super.init(frame: .zero)
        build(topInset: topInset)
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func start() {
        // the plans read while hidden, drawn at once; the read below brings them up to date
        if !repos.isEmpty { render() }
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        canvas.setPulsing(isVisibleNow)
    }

    private func stop() {
        beside?(nil)
        timer?.invalidate()
        timer = nil
        canvas.setPulsing(false)
    }

    /// The window was hidden, shown or covered: the pulse only runs while the panel can be seen.
    func visibilityChanged() { canvas.setPulsing(isVisibleNow) }

    override func layout() {
        super.layout()
        if beside == nil { canvas.rebuild() }
    }

    // MARK: layout

    private func build(topInset: CGFloat) {
        filterControl.selectedSegment = 0
        filterControl.target = self
        filterControl.action = #selector(filterChanged(_:))
        filterControl.setAccessibilityLabel("Show agents")
        scopePopup.target = self
        scopePopup.action = #selector(scopeChanged(_:))
        scopePopup.controlSize = .small
        scopePopup.font = Theme.sans(DesignTokens.TypeScale.caption)
        scopePopup.setAccessibilityLabel("Repositories")
        canvas.onOpen = { [weak self] lane, repo in self?.onOpen?(lane, repo) }
        canvas.setAccessibilityLabel("Agents and their plans")
        if beside != nil {
            buildBar(topInset: topInset)
            return
        }
        scroll.documentView = canvas
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        errorLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        legend.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        emptyLabel.alignment = .center
        emptyLabel.isHidden = true

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bar = NSStackView(views: [scopePopup, summary, spacer, errorLabel, filterControl])
        bar.orientation = .horizontal
        bar.spacing = 10

        for v in [bar, scroll, legend, emptyLabel] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            bar.centerYAnchor.constraint(equalTo: topAnchor, constant: topInset / 2 + 4),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: topAnchor, constant: topInset + 8),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            legend.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 7),
            legend.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            legend.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
            legend.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            emptyLabel.widthAnchor.constraint(lessThanOrEqualTo: scroll.widthAnchor, constant: -40),
        ])
    }

    /// Beside the sidebar: the bar on the search's line and the legend on the Overview item's, the
    /// empty message in the summary.
    private func buildBar(topInset: CGFloat) {
        errorLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        legend.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bar = NSStackView(views: [scopePopup, summary, spacer, errorLabel, filterControl])
        bar.orientation = .horizontal
        bar.spacing = 10
        for v in [bar, legend] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            bar.centerYAnchor.constraint(equalTo: topAnchor, constant: topInset + 15),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            legend.centerYAnchor.constraint(equalTo: topAnchor, constant: topInset + 55),
            legend.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            legend.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
        ])
    }

    private func apply(_ t: Theme) {
        appearance = t.appearance
        summary.textColor = t.color(\.muted)
        legend.textColor = t.color(\.muted)
        emptyLabel.textColor = t.color(\.muted)
        errorLabel.textColor = t.color(\.red)
        canvas.apply(t)
    }

    private var filter: OverviewFilter {
        let i = filterControl.selectedSegment
        return i >= 0 && i < OverviewFilter.allCases.count ? OverviewFilter.allCases[i] : .all
    }

    /// The drop-down: the scopes, then every repository (a dot before those with an open session).
    private func rebuildScopeMenu() {
        let listed = repositories()
        let open = openRepositories()
        // a repository no longer listed: back to the default
        if case .repo(let root) = scope, !listed.contains(where: { $0.root == root }) { scope = .open }
        let key = ["\(scope)", overviewScopeTitle(.open, repos: listed, open: open)]
            + listed.map { (open.contains($0.root) ? "●" : "") + $0.root + "\t" + $0.name }
        guard key != scopeMenuKey else { return }
        scopeMenuKey = key
        let menu = NSMenu()
        func add(_ title: String, _ value: OverviewScope) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.representedObject = OverviewScopeBox(value)
            menu.addItem(item)
        }
        add(overviewScopeTitle(.open, repos: listed, open: open), .open)
        add("All repositories", .all)
        if !listed.isEmpty { menu.addItem(.separator()) }
        for repo in listed { add((open.contains(repo.root) ? "● " : "    ") + repo.name, .repo(repo.root)) }
        scopePopup.menu = menu
        if let i = menu.items.firstIndex(where: { ($0.representedObject as? OverviewScopeBox)?.value == scope }) {
            scopePopup.selectItem(at: i)
        }
    }

    @objc private func scopeChanged(_ sender: Any?) {
        guard let box = scopePopup.selectedItem?.representedObject as? OverviewScopeBox else { return }
        scope = box.value
        generation += 1
        scopeMenuKey = []
        repos = []
        render()
        refresh()
    }

    private func render() {
        summary.stringValue = overviewSummary(repos)
        // closed meanwhile (a read was still out): the sidebar must not get its lanes back
        if let beside { if isShown { beside((repos, filter)) } } else { canvas.show(repos, filter: filter) }
        canvas.setPulsing(isVisibleNow)
        let asked = overviewRepos(repositories(), open: openRepositories(), scope: scope)
        emptyLabel.stringValue = asked.isEmpty && scope == .open
            ? "No repository has an open session. Pick one from the menu above, or All repositories."
            : (repos.allSatisfy { $0.agents == 0 } && !loading ? "No agents running" : "")
        emptyLabel.isHidden = emptyLabel.stringValue.isEmpty || demoRepos != nil
        // beside the sidebar there is no room in the middle: the summary says it
        if beside != nil, !emptyLabel.stringValue.isEmpty, demoRepos == nil { summary.stringValue = emptyLabel.stringValue }
        if isShown { isSettled = true }
    }

    private var isVisibleNow: Bool {
        guard isShown, !isHiddenOrHasHiddenAncestor, let window else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    @objc private func filterChanged(_ sender: Any?) {
        // closed meanwhile (a read was still out): the sidebar must not get its lanes back
        if let beside { if isShown { beside((repos, filter)) } } else { canvas.show(repos, filter: filter) }
        canvas.setPulsing(isVisibleNow)
    }

    // MARK: data

    /// kunj said a plan changed, or the listing did: read again shortly (several changes come together).
    /// Also while hidden, so the Overview has the plans before it is opened (the first listing after
    /// kunj connects is the first read).
    func planChanged() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.refresh() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    func refresh() {
        rebuildScopeMenu()
        if let demoRepos {
            repos = demoRepos
            render()
            return
        }
        guard let cli else {
            errorLabel.stringValue = "kunj is not connected"
            return
        }
        // one read at a time; a request that comes meanwhile runs one more when it is back
        if loading {
            again = true
            return
        }
        let asked = overviewRepos(repositories(), open: openRepositories(), scope: scope)
        guard !asked.isEmpty else {
            repos = []
            errorLabel.stringValue = ""
            render()
            return
        }
        loading = true
        let started = generation
        Task { [weak self] in
            await self?.load(asked, generation: started)
            guard let self else { return }
            self.loading = false
            // the scope changed meanwhile: these were another scope's agents; read again for this one
            guard started == self.generation else {
                self.again = false
                self.refresh()
                return
            }
            if self.again {
                self.again = false
                self.refresh()
            }
        }
    }

    /// Every repository asked at once, twice: the quick read (host agents only) and the full one
    /// (containers too, seconds). Each answer is drawn as it comes, so the Overview fills as it goes;
    /// a quick answer only where `overviewQuickReadShows` allows and its full one is not back yet. A
    /// repository that fails keeps the others; the first full read's message is shown.
    private func load(_ asked: [RepoRef], generation started: Int) async {
        let roots = asked.map(\.root)
        var byRoot: [String: AgentOverviewJson] = [:]
        for json in repos where roots.contains(json.repo.root) { byRoot[json.repo.root] = json }
        var fullBack = Set<Int>()
        var problems: [Int: String] = [:]
        let cli = self.cli
        await withTaskGroup(of: (Int, Bool, AgentOverviewJson?, String?).self) { group in
            for (index, repo) in asked.enumerated() {
                for full in [false, true] {
                    group.addTask { await OverviewPanel.read(cli: cli, repo: repo, index: index, full: full) }
                }
            }
            for await (index, full, json, problem) in group {
                guard started == generation else { continue }
                let root = asked[index].root
                if full {
                    fullBack.insert(index)
                    if let problem { problems[index] = problem }
                    if let json { byRoot[root] = json } else { byRoot[root] = nil }
                } else {
                    guard let json, !fullBack.contains(index), overviewQuickReadShows(over: byRoot[root]) else { continue }
                    byRoot[root] = json
                }
                repos = roots.compactMap { byRoot[$0] }
                // the message only once every full read is back, so a slow repository's is not lost
                errorLabel.stringValue = fullBack.count == asked.count
                    ? problems.keys.sorted().first.flatMap { problems[$0] } ?? "" : errorLabel.stringValue
                render()
            }
        }
    }

    private nonisolated static func read(cli: KunjCLI?, repo: RepoRef, index: Int, full: Bool)
        async -> (Int, Bool, AgentOverviewJson?, String?) {
        guard let cli else { return (index, full, nil, nil) }
        do {
            let json: AgentOverviewJson = try await cli.run(agentOverviewArguments(containers: full), cwd: repo.root, timeout: 30)
            let problem = json.containers.flatMap { c -> String? in
                if !c.available { return "\(repo.name) containers: \(c.message ?? "Docker could not be asked")" }
                guard let unreadable = c.unreadable, !unreadable.isEmpty else { return nil }
                return "\(repo.name): could not read the agents in \(unreadable.joined(separator: ", "))"
            }
            return (index, full, json, problem)
        } catch {
            return (index, full, nil, "\(repo.name): \((error as? KunjCLIError)?.message ?? "\(error)")")
        }
    }
}

/// A scope in a menu item's representedObject.
private final class OverviewScopeBox: NSObject {
    let value: OverviewScope
    init(_ value: OverviewScope) { self.value = value }
}
