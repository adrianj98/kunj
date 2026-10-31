import AppKit
import KunjWorkspaceCore

/// The sidebar: 52 px for the traffic lights, the ⌘K search, the open sessions grouped by
/// repository (`sidebarGroups`: tabs in the app or saved, a running agent, the selection), each
/// group ending in `N more…` (11 px `faint`, as the design's more row) that lists the others too
/// (`Show fewer` closes it); a search lists every match. At the foot `+ New session ⌘N` over
/// `N agents running · kunj <version>`. A row's right-click menu is `ActionRunner.rowMenu`. The rows are rebuilt on
/// every change (a few dozen at most).
final class SidebarView: NSView {
    var repos: [RepoEnvironments] = [] { didSet { reload() } }
    var selectedId: String? { didSet { list.rows.forEach { $0.selected = $0.environment.id == selectedId } } }
    var onSelect: (String) -> Void = { _ in }
    var onNewSession: () -> Void = {}
    /// Whether an environment is an open session (the window adds the selection).
    var isOpen: (Environment) -> Bool = { _ in true } { didSet { reload() } }
    /// A row's right-click menu.
    var rowMenu: (Environment) -> NSMenu? = { _ in nil }
    /// Repository roots whose `N more…` row is expanded (for this run).
    private var expanded: Set<String> = []
    /// Leave out repositories with no open session (View > Show Repositories Without Sessions off).
    var hideEmptyRepos = false { didSet { reload() } }
    /// The summed CPU and memory of each worktree's kunj sessions, by standardized path.
    var usage: [String: SessionUsage] = [:] { didSet { list.rows.forEach { $0.usage = usageOf($0.environment) } } }
    /// The rows show the usage only while the mouse is over the sidebar.
    private(set) var hovering = false {
        didSet {
            list.rows.forEach { $0.showUsage = hovering }
            if hovering != oldValue { onHover(hovering) }
        }
    }
    /// The mouse entered (true) or left the sidebar.
    var onHover: (Bool) -> Void = { _ in }
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
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        list.onSelect = { [weak self] id in self?.onSelect(id) }
        list.rowMenu = { [weak self] env in self?.rowMenu(env) }
        list.onToggleMore = { [weak self] root in
            guard let self else { return }
            if self.expanded.contains(root) { self.expanded.remove(root) } else { self.expanded.insert(root) }
            self.reload()
        }
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

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

    /// The ids of the rows the search leaves, in order (⌘1–9).
    var visibleIds: [String] { groups().flatMap { $0.environments.map(\.id) } }

    private func groups() -> [SidebarGroup] {
        sidebarGroups(repos, query: query, isOpen: { [selectedId, isOpen] in $0.id == selectedId || isOpen($0) },
                      expanded: expanded, hideEmpty: hideEmptyRepos)
    }

    /// Lists again (a tab opened or closed changes which sessions are open).
    func reloadRows() { reload() }

    private func timeText(_ id: String) -> String { lastActivity(id).map { relativeTime($0) } ?? "" }

    private func usageOf(_ e: Environment) -> SessionUsage? {
        e.path.flatMap { usage[($0 as NSString).standardizingPath] }
    }

    private func reload() {
        let n = agentsRunning(repos)
        agents.stringValue = n == 1 ? "1 agent running" : "\(n) agents running"
        list.set(groups: groups(), selectedId: selectedId, time: timeText)
        list.rows.forEach { $0.usage = usageOf($0.environment); $0.showUsage = hovering }
        list.frame.size.width = scroll.contentSize.width
        list.needsLayout = true
    }
}

/// The scrolling list: group headers (repo name sans 11/500 `muted`, count mono 11 `faint`) drawn
/// here, rows as subviews; 2 px between rows, 18 px between groups, 8 px side padding.
private final class SidebarListView: NSView {
    private struct Group { let name: String; let count: Int; let y: CGFloat }

    var theme: Theme {
        didSet { rows.forEach { $0.theme = theme }; moreRows.values.forEach { $0.theme = theme }; needsDisplay = true }
    }
    var onSelect: (String) -> Void = { _ in }
    var rowMenu: (Environment) -> NSMenu? = { _ in nil }
    var onToggleMore: (String) -> Void = { _ in }
    private(set) var rows: [SidebarRowView] = []
    private var moreRows: [String: MoreRowView] = [:]
    private var groups: [Group] = []
    private var model: [SidebarGroup] = []
    private static let headerHeight: CGFloat = 19, rowGap: CGFloat = 2, groupGap: CGFloat = 18, side: CGFloat = 8
    private static let moreHeight: CGFloat = 26

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    func set(groups model: [SidebarGroup], selectedId: String?, time: (String) -> String) {
        self.model = model
        rows.forEach { $0.removeFromSuperview() }
        moreRows.values.forEach { $0.removeFromSuperview() }
        moreRows = [:]
        rows = model.flatMap { g in
            g.environments.map { e in
                let r = SidebarRowView(environment: e, time: time(e.id), selected: e.id == selectedId, theme: theme)
                r.onSelect = { [weak self] id in self?.onSelect(id) }
                r.rowMenu = { [weak self] env in self?.rowMenu(env) }
                return r
            }
        }
        rows.forEach(addSubview)
        for g in model where g.more > 0 {
            let row = MoreRowView(text: g.expanded ? "Show fewer" : "\(g.more) more…", theme: theme)
            row.onPress = { [weak self] in self?.onToggleMore(g.repo.root) }
            moreRows[g.repo.root] = row
            addSubview(row)
        }
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
            if let more = moreRows[g.repo.root] {
                y += Self.rowGap
                more.frame = NSRect(x: Self.side, y: y, width: width, height: Self.moreHeight)
                y += Self.moreHeight
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

/// A repository's `N more…` / `Show fewer` row: 11 px in `faint` (`text2` on hover), padded 8 px
/// like the design's more row.
private final class MoreRowView: NSView {
    let text: String
    var theme: Theme { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }

    init(text: String, theme: Theme) {
        self.text = text
        self.theme = theme
        super.init(frame: .zero)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(text)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { onPress?() }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }

    override func draw(_ dirtyRect: NSRect) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(DesignTokens.TypeScale.caption),
            .foregroundColor: theme.color(hovering ? \.text2 : \.faint)]
        let size = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: 8, y: (bounds.midY - size.height / 2).rounded()), withAttributes: attrs)
    }
}
