import AppKit
import KunjWorkspaceCore

/// The sidebar: 52 px for the traffic lights, the ⌘K search, the environments grouped by
/// repository, and at the foot `+ New session ⌘N` over `N agents running · kunj <version>`.
/// The rows are rebuilt on every `repos` change (a few dozen at most).
final class SidebarView: NSView {
    var repos: [RepoEnvironments] = [] { didSet { reload() } }
    var selectedId: String? { didSet { list.rows.forEach { $0.selected = $0.environment.id == selectedId } } }
    var onSelect: (String) -> Void = { _ in }
    var onNewSession: () -> Void = {}
    /// When the environment was last active (Task 8 persists it); nil shows no time.
    var lastActivity: (String) -> Date? = { _ in nil }
    /// `kunj 1.4.2`, `kunj 1.0.0 dev`, or empty before discovery.
    var versionLabel: String = "" { didSet { version.stringValue = versionLabel } }
    var theme: Theme { didSet { apply() } }

    let search: SearchField
    private let scroll = NSScrollView()
    private let list: SidebarListView
    private let footerLine = FillView(.clear)
    private let newSession: ActionButton
    private let agents = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let version = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private var query = ""

    init(theme: Theme) {
        self.theme = theme
        search = SearchField(placeholder: "Search sessions", theme: theme)
        list = SidebarListView(theme: theme)
        newSession = ActionButton("New session", hint: "⌘N", icon: .plus, style: .wide, theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.documentView = list
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.contentView.postsBoundsChangedNotifications = false
        version.alignment = .right
        search.onChange = { [weak self] q in self?.query = q; self?.reload() }
        newSession.onPress = { [weak self] in self?.onNewSession() }

        for v in [search, scroll, footerLine, newSession, agents, version] as [NSView] { addSubview(v) }
        let pad: CGFloat = 12
        NSLayoutConstraint.activate([
            search.topAnchor.constraint(equalTo: topAnchor, constant: DesignTokens.Layout.headerHeight),
            search.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            search.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),

            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footerLine.topAnchor),

            footerLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            footerLine.trailingAnchor.constraint(equalTo: trailingAnchor),
            footerLine.heightAnchor.constraint(equalToConstant: 1),
            footerLine.bottomAnchor.constraint(equalTo: newSession.topAnchor, constant: -10),

            newSession.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            newSession.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            newSession.heightAnchor.constraint(equalToConstant: 34),
            newSession.bottomAnchor.constraint(equalTo: agents.topAnchor, constant: -8),

            agents.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad + 4),
            agents.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),
            version.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -(pad + 4)),
            version.firstBaselineAnchor.constraint(equalTo: agents.firstBaselineAnchor),
            version.leadingAnchor.constraint(greaterThanOrEqualTo: agents.trailingAnchor, constant: 8),
        ])
        list.onSelect = { [weak self] id in self?.onSelect(id) }
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func apply() {
        search.theme = theme
        list.theme = theme
        newSession.theme = theme
        footerLine.color = theme.color(\.border)
        agents.textColor = theme.color(\.faint)
        version.textColor = theme.color(\.faint)
    }

    /// Refreshes the relative times (a timer calls it every 30 s).
    func refreshTimes() {
        for r in list.rows { r.time = timeText(r.environment.id) }
    }

    private func timeText(_ id: String) -> String { lastActivity(id).map { relativeTime($0) } ?? "" }

    private func reload() {
        let n = agentsRunning(repos)
        agents.stringValue = n == 1 ? "1 agent running" : "\(n) agents running"
        let shown = filterEnvironments(repos, query: query)
        list.set(groups: shown, selectedId: selectedId, time: timeText)
        list.frame.size.width = scroll.contentSize.width
        list.needsLayout = true
    }
}

/// The scrolling list: group headers (repo name sans 11/500 `muted`, count mono 11 `faint`) drawn
/// here, rows as subviews; 2 px between rows, 18 px between groups, 8 px side padding.
private final class SidebarListView: NSView {
    private struct Group { let name: String; let count: Int; let y: CGFloat }

    var theme: Theme { didSet { rows.forEach { $0.theme = theme }; needsDisplay = true } }
    var onSelect: (String) -> Void = { _ in }
    private(set) var rows: [SidebarRowView] = []
    private var groups: [Group] = []
    private var model: [RepoEnvironments] = []
    private static let headerHeight: CGFloat = 19, rowGap: CGFloat = 2, groupGap: CGFloat = 18, side: CGFloat = 8

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    func set(groups model: [RepoEnvironments], selectedId: String?, time: (String) -> String) {
        self.model = model
        rows.forEach { $0.removeFromSuperview() }
        rows = model.flatMap { g in
            g.environments.map { e in
                let r = SidebarRowView(environment: e, time: time(e.id), selected: e.id == selectedId, theme: theme)
                r.onSelect = { [weak self] id in self?.onSelect(id) }
                return r
            }
        }
        rows.forEach(addSubview)
        layoutRows()
    }

    override func layout() {
        super.layout()
        if let clip = superview as? NSClipView, frame.width != clip.bounds.width {
            frame.size.width = clip.bounds.width
        }
        layoutRows()
    }

    private func layoutRows() {
        var y: CGFloat = 0
        var i = 0
        groups = []
        let width = max(0, bounds.width - Self.side * 2)
        for (gi, g) in model.enumerated() {
            if gi > 0 { y += Self.groupGap }
            groups.append(Group(name: g.repo.name, count: g.environments.count, y: y))
            y += Self.headerHeight
            for _ in g.environments {
                y += Self.rowGap
                rows[i].frame = NSRect(x: Self.side, y: y, width: width, height: SidebarRowView.height)
                y += SidebarRowView.height
                i += 1
            }
        }
        let height = max(y + 8, superview?.bounds.height ?? 0)
        if frame.height != height { frame.size.height = height }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let caption = DesignTokens.TypeScale.caption
        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(caption, weight: .medium), .foregroundColor: theme.color(\.muted)]
        let countAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.mono(caption), .foregroundColor: theme.color(\.faint)]
        for g in groups {
            let mid = g.y + 6.5
            let nameSize = (g.name as NSString).size(withAttributes: nameAttrs)
            (g.name as NSString).draw(at: NSPoint(x: Self.side * 2, y: (mid - nameSize.height / 2).rounded()),
                                      withAttributes: nameAttrs)
            let count = "\(g.count)" as NSString
            let countSize = count.size(withAttributes: countAttrs)
            count.draw(at: NSPoint(x: bounds.width - Self.side * 2 - ceil(countSize.width),
                                   y: (mid - countSize.height / 2).rounded()), withAttributes: countAttrs)
        }
    }
}
