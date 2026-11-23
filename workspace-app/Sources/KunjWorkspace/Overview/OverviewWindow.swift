import AppKit
import KunjWorkspaceCore

/// Window ▸ Overview (⌘⇧O): every running agent as a line of its plan's steps, with the current one
/// marked, subagents as loops, handed-off agents as branches and branch changes as markers
/// (`kunj agent plan --all --json` per repository, `kunj ct agent <branch> --plan --json` per running
/// container with an agent). Read again when kunj reports a plan change, when the listing changes and
/// every 10 s while visible (a container's plan has no event yet). A click on a line opens that
/// agent's tab. Spec: docs/specs/agent-overview.md.
@MainActor
final class OverviewWindow: NSWindowController, NSWindowDelegate {
    var cli: KunjCLI?
    /// The listed repositories with their environments (for the roots and the running containers).
    var repositories: () -> [RepoEnvironments] = { [] }
    /// A click on an agent's line.
    var onOpen: ((AgentPlan, OverviewRepo) -> Void)?
    /// `--demo`: these instead of asking kunj.
    var demoRepos: [OverviewRepo]?
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

    private var repos: [OverviewRepo] = []
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
        canvas.onOpen = { [weak self] plan, repo in self?.onOpen?(plan, repo) }
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

    /// Every repository's plans, read at once: its host agents, and those of each running container
    /// that has an agent. A repository that fails keeps the others; the first message is shown.
    private nonisolated static func load(cli: KunjCLI, repos: [RepoEnvironments]) async -> ([OverviewRepo], String?) {
        await withTaskGroup(of: (Int, [AgentPlan], String?).self) { group in
            for (index, listed) in repos.enumerated() {
                let root = listed.repo.root
                let containers = listed.environments.filter { $0.kind == .container && $0.state == .running && $0.agent != .none }
                group.addTask {
                    var plans: [AgentPlan] = []
                    var problem: String?
                    do {
                        let json: AgentPlanJson = try await cli.run(agentPlanArguments(), cwd: root, timeout: 30)
                        plans += json.plans
                    } catch {
                        problem = "\(listed.repo.name): \((error as? KunjCLIError)?.message ?? "\(error)")"
                    }
                    for env in containers {
                        do {
                            let json: AgentPlanJson = try await cli.run(
                                containerAgentPlanArguments(branch: env.branch, remote: env.remoteArguments), cwd: root, timeout: 30)
                            plans += json.plans
                        } catch {
                            if problem == nil { problem = "\(listed.repo.name) \(env.branch): \((error as? KunjCLIError)?.message ?? "\(error)")" }
                        }
                    }
                    return (index, plans, problem)
                }
            }
            var byIndex: [Int: [AgentPlan]] = [:]
            var problems: [Int: String] = [:]
            for await (index, plans, problem) in group {
                byIndex[index] = plans
                if let problem { problems[index] = problem }
            }
            let out = repos.enumerated().map { index, listed in
                OverviewRepo(name: listed.repo.name, root: listed.repo.root, plans: activePlans(byIndex[index] ?? []))
            }
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
