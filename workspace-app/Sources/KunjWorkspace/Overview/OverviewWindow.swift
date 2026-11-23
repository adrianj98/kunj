import AppKit
import KunjWorkspaceCore

/// Window ▸ Overview (⌘⇧O): every running agent as a line of its plan's steps, with the current one
/// marked, subagents as loops, handed-off agents as branches and branch changes as markers
/// (`kunj agent overview --containers --json` per repository: kunj decides which agents, their
/// grouping, text and every position; the window only draws that). Read again when kunj reports a
/// plan change, when the listing changes and every 10 s while visible. A click on a line opens that
/// agent's tab. Spec: docs/specs/agent-overview.md.
@MainActor
final class OverviewWindow: NSWindowController, NSWindowDelegate {
    var cli: KunjCLI?
    /// The listed repositories: kunj is asked once in each.
    var repositories: () -> [RepoRef] = { [] }
    /// A click on an agent's line.
    var onOpen: ((OverviewLane, AgentOverviewJson.Repo) -> Void)?
    /// `--demo`: these instead of asking kunj.
    var demoRepos: [AgentOverviewJson]?
    /// True once plans have been shown (a screenshot waits for it).
    private(set) var isSettled = false

    private let content = FillView(.clear)
    private let canvas = OverviewCanvas(frame: .zero)
    private let scroll = NSScrollView()
    private let summary = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let filterControl = NSSegmentedControl(labels: OverviewFilter.allCases.map { $0.title }, trackingMode: .selectOne,
                                                   target: nil, action: nil)
    private let errorLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let legend = makeLabel(
        "● done    ◎ where the agent is: green working, amber waiting for you    ○ to come    ◇ branch or worktree change    ⌣ subagent    Click a line to open its agent",
        font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)

    private var repos: [AgentOverviewJson] = []
    private var timer: Timer?
    private var loading = false
    private var again = false
    private var pending: DispatchWorkItem?

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 640),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: true)
        window.title = "Overview"
        window.minSize = NSSize(width: 560, height: 280)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("KunjOverviewWindow")
        super.init(window: window)
        window.delegate = self
        build(window)
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
        pending?.cancel()
    }

    func windowDidResize(_ notification: Notification) {
        canvas.rebuild()
    }

    // MARK: layout

    private func build(_ window: NSWindow) {
        window.contentView = content
        filterControl.selectedSegment = 0
        filterControl.target = self
        filterControl.action = #selector(filterChanged(_:))
        filterControl.setAccessibilityLabel("Show agents")
        canvas.onOpen = { [weak self] lane, repo in self?.onOpen?(lane, repo) }
        canvas.setAccessibilityLabel("Agents and their plans")
        scroll.documentView = canvas
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        errorLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        legend.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bar = NSStackView(views: [summary, spacer, errorLabel, filterControl])
        bar.orientation = .horizontal
        bar.spacing = 10

        for v in [bar, scroll, legend] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: content.topAnchor, constant: 10),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            legend.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 7),
            legend.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            legend.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -16),
            legend.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
        ])
    }

    private func apply(_ t: Theme) {
        window?.appearance = t.appearance
        window?.backgroundColor = t.color(\.bg)
        content.color = t.color(\.bg)
        summary.textColor = t.color(\.muted)
        legend.textColor = t.color(\.muted)
        errorLabel.textColor = t.color(\.red)
        canvas.apply(t)
    }

    private var filter: OverviewFilter {
        let i = filterControl.selectedSegment
        return i >= 0 && i < OverviewFilter.allCases.count ? OverviewFilter.allCases[i] : .all
    }

    private func render() {
        summary.stringValue = overviewSummary(repos)
        canvas.show(repos, filter: filter)
        isSettled = true
    }

    @objc private func filterChanged(_ sender: Any?) {
        canvas.show(repos, filter: filter)
    }

    // MARK: data

    /// kunj said a plan changed, or the listing did: read again shortly (several changes come together).
    func planChanged() {
        guard window?.isVisible == true else { return }
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.refresh() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    func refresh() {
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
        loading = true
        let listed = repositories()
        Task { [weak self] in
            let (result, problem) = await OverviewWindow.load(cli: cli, repos: listed)
            guard let self else { return }
            self.loading = false
            self.repos = result
            self.errorLabel.stringValue = problem ?? ""
            self.render()
            if self.again {
                self.again = false
                self.refresh()
            }
        }
    }

    /// Every repository's overview, asked at once. A repository that fails keeps the others; the first
    /// message is shown (also when a repository's containers could not be asked).
    private nonisolated static func load(cli: KunjCLI, repos: [RepoRef]) async -> ([AgentOverviewJson], String?) {
        await withTaskGroup(of: (Int, AgentOverviewJson?, String?).self) { group in
            for (index, repo) in repos.enumerated() {
                group.addTask {
                    do {
                        let json: AgentOverviewJson = try await cli.run(agentOverviewArguments(), cwd: repo.root, timeout: 30)
                        let problem = json.containers.flatMap { c -> String? in
                            c.available ? nil : "\(repo.name) containers: \(c.message ?? "Docker could not be asked")"
                        }
                        return (index, json, problem)
                    } catch {
                        return (index, nil, "\(repo.name): \((error as? KunjCLIError)?.message ?? "\(error)")")
                    }
                }
            }
            var byIndex: [Int: AgentOverviewJson] = [:]
            var problems: [Int: String] = [:]
            for await (index, json, problem) in group {
                if let json { byIndex[index] = json }
                if let problem { problems[index] = problem }
            }
            let out = repos.indices.compactMap { byIndex[$0] }
            return (out, problems.keys.sorted().first.flatMap { problems[$0] })
        }
    }

    func snapshotPNG() -> Data? {
        guard let root = window?.contentView else { return nil }
        root.layoutSubtreeIfNeeded()
        canvas.rebuild()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).representation(using: .png, properties: [:])
    }
}
