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
    /// Whether an environment's session is suspended (its status reads "Suspended").
    var isSuspended: (Environment) -> Bool = { _ in false }
    /// Repository roots whose `N more…` row is expanded (for this run).
    private var expanded: Set<String> = []
    /// Repository roots collapsed to their header (a click on the header toggles); remembered.
    private var collapsed = Set(UserDefaults.standard.stringArray(forKey: SidebarView.collapsedKey) ?? []) {
        didSet { UserDefaults.standard.set(collapsed.sorted(), forKey: Self.collapsedKey) }
    }
    static let collapsedKey = "collapsedRepos"
    /// Leave out repositories with no open session (View > Show Repositories Without Sessions off,
    /// or "Active repositories" in the repositories menu).
    var hideEmptyRepos = false { didSet { reload() } }
    /// "All repositories" or "Active repositories" was picked in the repositories menu.
    var onShowAllRepos: (Bool) -> Void = { _ in }
    /// Repositories picked in the repositories menu: listed even with no open session; remembered.
    private var pinned = Set(UserDefaults.standard.stringArray(forKey: SidebarView.pinnedKey) ?? []) {
        didSet { UserDefaults.standard.set(pinned.sorted(), forKey: Self.pinnedKey) }
    }
    static let pinnedKey = "shownRepos"
    /// Beside the search: which repositories the list shows (active ones, all, or picked ones).
    private let reposButton = NSPopUpButton(frame: .zero, pullsDown: true)
    /// The summed CPU and memory of each worktree's kunj sessions, by standardized path.
    var usage: [String: SessionUsage] = [:] { didSet { list.rows.forEach { $0.usage = usageOf($0.environment) } } }
    /// Each worktree's language server memory in bytes (by standardized path), added to its sessions' memory.
    var lspMemory: [String: Double] = [:] { didSet { if lspMemory != oldValue { list.rows.forEach { $0.usage = usageOf($0.environment) } } } }
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
    /// The Overview item above the list: shows the agents' plans in the middle panel.
    private let overviewRow: OverviewNavRow
    /// The Overview item was pressed.
    var onOverview: () -> Void = {}
    /// The Overview is shown (its item is selected; no environment row is).
    var overviewSelected = false { didSet { overviewRow.selected = overviewSelected } }
    private let scroll = NSScrollView()
    private let list: SidebarListView
    /// The rows' column: the whole sidebar, or its usual width while the Overview spans the window.
    private let column = NSLayoutGuide()
    private var columnFull: NSLayoutConstraint!
    private var columnWidth: NSLayoutConstraint!
    /// The agents' plans right of the rows while the Overview is shown (`showPlans`).
    let plans = OverviewCanvas(frame: .zero)
    /// Holds `plans` beside the rows: scrolls them left and right; up and down is the list's own scroll.
    private lazy var plansScroll: SidewaysScrollView = {
        let s = SidewaysScrollView()
        s.drawsBackground = false
        s.hasHorizontalScroller = true
        s.hasVerticalScroller = false
        s.autohidesScrollers = true
        s.scrollerStyle = .overlay
        s.borderType = .noBorder
        s.documentView = plans
        return s
    }()
    private var planData: (repos: [AgentOverviewJson], filter: OverviewFilter)?
    /// Where the list starts: the Overview's bar sits above it, right of the search.
    var listTopAnchor: NSLayoutYAxisAnchor { scroll.topAnchor }

    /// The rows' width while the Overview spans the window (the sidebar's usual width); nil: the
    /// sidebar is the rows' column.
    var overviewColumn: CGFloat? {
        didSet {
            guard overviewColumn != oldValue else { return }
            if let w = overviewColumn {
                columnFull.isActive = false
                columnWidth.constant = w
                columnWidth.isActive = true
            } else {
                columnWidth.isActive = false
                columnFull.isActive = true
            }
            list.columnWidth = overviewColumn
            if overviewColumn == nil { showPlans(nil) } else { list.needsLayout = true }
        }
    }

    /// Draws the agents' plans beside their rows (nil removes them): a row grows to hold its agents.
    func showPlans(_ data: (repos: [AgentOverviewJson], filter: OverviewFilter)?) {
        // a read that comes back after the Overview closed draws nothing
        let data = overviewColumn == nil ? nil : data
        planData = data
        if data == nil {
            list.plans = nil
            list.onPlaced = nil
            list.rowHeights = [:]
            plans.show([], filter: .all)
            plans.setPulsing(false)
            // the rows go back to their own height
            list.layoutRows()
        } else {
            list.plans = plansScroll
        }
        placePlans()
    }

    /// Which row each lane is beside and how tall the rows get, then the lanes at the rows' tops.
    private func placePlans() {
        guard let data = planData else { return }
        let alignment = alignOverview(data.repos, filter: data.filter, environments: list.rows.map(\.environment),
                                      rowHeight: Double(SidebarRowView.height))
        list.rowHeights = alignment.rowHeights.mapValues { CGFloat($0) }
        list.onPlaced = { [weak self] tops in
            guard let self, let data = self.planData else { return }
            self.plans.showAligned(data.repos, filter: data.filter, lanes: alignment.lanes, rowTops: tops)
            // as wide as the widest lane (scrolled sideways) and as tall as the list it sits beside; the
            // lanes are placed again at that size (they take the canvas's width)
            let room = self.plansScroll.frame.size
            let size = NSSize(width: max(room.width, self.plans.alignedContentWidth), height: room.height)
            if self.plans.frame.size != size {
                self.plans.frame = NSRect(origin: .zero, size: size)
                self.plans.showAligned(data.repos, filter: data.filter, lanes: alignment.lanes, rowTops: tops)
            }
        }
        list.layoutRows()
    }
    private let footerLine = FillView(.clear)
    private let newSession: ActionButton
    private let agents = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let version = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private var query = ""

    init(theme: Theme) {
        self.theme = theme
        search = SearchField(placeholder: "Search sessions", theme: theme)
        overviewRow = OverviewNavRow(theme: theme)
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

        overviewRow.onPress = { [weak self] in self?.onOverview() }
        overviewRow.translatesAutoresizingMaskIntoConstraints = false
        reposButton.isBordered = false
        reposButton.controlSize = .small
        (reposButton.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
        reposButton.menu = NSMenu()
        reposButton.menu?.delegate = self
        reposButton.setAccessibilityLabel("Repositories shown")
        reposButton.toolTip = "Repositories shown"
        reposButton.translatesAutoresizingMaskIntoConstraints = false
        for v in [search, reposButton, overviewRow, scroll, footerLine, newSession, agents, version] as [NSView] { addSubview(v) }
        addLayoutGuide(column)
        columnFull = column.trailingAnchor.constraint(equalTo: trailingAnchor)
        columnWidth = column.widthAnchor.constraint(equalToConstant: 272)
        let pad: CGFloat = 12
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            columnFull,
            search.topAnchor.constraint(equalTo: topAnchor, constant: DesignTokens.Layout.headerHeight),
            search.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            search.trailingAnchor.constraint(equalTo: reposButton.leadingAnchor, constant: -6),
            reposButton.centerYAnchor.constraint(equalTo: search.centerYAnchor),
            reposButton.trailingAnchor.constraint(equalTo: column.trailingAnchor, constant: -pad + 2),
            reposButton.widthAnchor.constraint(equalToConstant: 24),

            overviewRow.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 10),
            overviewRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            overviewRow.trailingAnchor.constraint(equalTo: column.trailingAnchor, constant: -8),
            overviewRow.heightAnchor.constraint(equalToConstant: 30),

            scroll.topAnchor.constraint(equalTo: overviewRow.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footerLine.topAnchor),

            footerLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            footerLine.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            footerLine.heightAnchor.constraint(equalToConstant: 1),
            footerLine.bottomAnchor.constraint(equalTo: newSession.topAnchor, constant: -10),

            newSession.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            newSession.trailingAnchor.constraint(equalTo: column.trailingAnchor, constant: -pad),
            newSession.heightAnchor.constraint(equalToConstant: 34),
            newSession.bottomAnchor.constraint(equalTo: agents.topAnchor, constant: -8),

            agents.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad + 4),
            agents.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),
            version.trailingAnchor.constraint(equalTo: column.trailingAnchor, constant: -(pad + 4)),
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
        list.onToggleCollapsed = { [weak self] root in
            // a search shows every match and ignores collapsing: a click there would only change
            // what appears after the search is cleared
            guard let self, self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            if self.collapsed.contains(root) { self.collapsed.remove(root) } else { self.collapsed.insert(root) }
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
        overviewRow.theme = theme
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
        // a suspended session is not open: it waits under `N more…`, and a repository with nothing
        // else open is not active
        sidebarGroups(repos, query: query,
                      isOpen: { [selectedId, isOpen, isSuspended] in $0.id == selectedId || (isOpen($0) && !isSuspended($0)) },
                      expanded: expanded, hideEmpty: hideEmptyRepos, collapsed: collapsed, pinned: pinned)
    }

    /// Lists again (a tab opened or closed changes which sessions are open).
    func reloadRows() { reload() }

    private func timeText(_ id: String) -> String { lastActivity(id).map { relativeTime($0) } ?? "" }

    private func usageOf(_ e: Environment) -> SessionUsage? {
        guard let path = e.path.map({ ($0 as NSString).standardizingPath }) else { return nil }
        let sessions = usage[path]
        guard let lsp = lspMemory[path] else { return sessions }
        return SessionUsage(cpu: sessions?.cpu ?? 0, memoryBytes: (sessions?.memoryBytes ?? 0) + lsp)
    }

    private func reload() {
        let n = agentsRunning(repos)
        agents.stringValue = n == 1 ? "1 agent running" : "\(n) agents running"
        overviewRow.count = n
        list.set(groups: groups(), selectedId: selectedId, time: timeText)
        list.rows.forEach { $0.usage = usageOf($0.environment); $0.showUsage = hovering; $0.suspended = isSuspended($0.environment) }
        list.frame.size.width = scroll.contentSize.width
        list.needsLayout = true
        // other rows: the lanes go beside them again
        placePlans()
    }
}

/// The scrolling list: group headers (repo name sans 11/500 `muted`, count mono 11 `faint`) drawn
/// here, rows as subviews; 2 px between rows, 18 px between groups, 8 px side padding.
private final class SidebarListView: NSView {
    private struct Group { let root: String; let name: String; let count: Int; let collapsed: Bool; let y: CGFloat }

    var theme: Theme {
        didSet { rows.forEach { $0.theme = theme }; moreRows.values.forEach { $0.theme = theme }; needsDisplay = true }
    }
    var onSelect: (String) -> Void = { _ in }
    var rowMenu: (Environment) -> NSMenu? = { _ in nil }
    var onToggleMore: (String) -> Void = { _ in }
    var onToggleCollapsed: (String) -> Void = { _ in }
    private(set) var rows: [SidebarRowView] = []
    private var moreRows: [String: MoreRowView] = [:]
    private var groups: [Group] = []
    private var model: [SidebarGroup] = []
    private static let headerHeight: CGFloat = 19, rowGap: CGFloat = 2, groupGap: CGFloat = 18, side: CGFloat = 8
    private static let moreHeight: CGFloat = 26
    /// The rows' column width while the Overview spans the window; nil: the whole width.
    var columnWidth: CGFloat? { didSet { needsLayout = true } }
    /// Rows taller than `SidebarRowView.height`, to hold their agents' lanes (by environment id).
    var rowHeights: [String: CGFloat] = [:]
    /// The plans' view, laid right of the rows (nil: none).
    var plans: NSView? {
        didSet {
            guard plans !== oldValue else { return }
            oldValue?.removeFromSuperview()
            if let plans { addSubview(plans) }
        }
    }
    /// After a layout: each row's top, by environment id, in the plans' view.
    var onPlaced: (([String: CGFloat]) -> Void)?

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

    func layoutRows() {
        var y: CGFloat = 0
        var i = 0
        groups = []
        let width = max(0, (columnWidth ?? bounds.width) - Self.side * 2)
        for (gi, g) in model.enumerated() {
            if gi > 0 { y += Self.groupGap }
            groups.append(Group(root: g.repo.root, name: g.repo.name,
                                count: g.collapsed ? g.openCount : g.environments.count, collapsed: g.collapsed, y: y))
            y += Self.headerHeight
            for _ in g.environments {
                y += Self.rowGap
                let height = rowHeights[rows[i].environment.id] ?? SidebarRowView.height
                rows[i].frame = NSRect(x: Self.side, y: y, width: width, height: height)
                y += height
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
        if let plans, let column = columnWidth {
            let frame = NSRect(x: column, y: 0, width: max(0, bounds.width - column), height: height)
            if plans.frame != frame { plans.frame = frame }
            var tops: [String: CGFloat] = [:]
            for row in rows { tops[row.environment.id] = row.frame.minY }
            onPlaced?(tops)
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let caption = DesignTokens.TypeScale.caption
        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(caption, weight: .medium), .foregroundColor: theme.color(\.muted)]
        let countAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.mono(caption), .foregroundColor: theme.color(\.faint)]
        let chevronAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(caption - 2), .foregroundColor: theme.color(\.faint)]
        for g in groups {
            let mid = g.y + 6.5
            // ▾ open, ▸ collapsed; the whole header toggles (mouseDown)
            let chevron = (g.collapsed ? "▸" : "▾") as NSString
            let chevronSize = chevron.size(withAttributes: chevronAttrs)
            chevron.draw(at: NSPoint(x: Self.side, y: (mid - chevronSize.height / 2).rounded()), withAttributes: chevronAttrs)
            let nameSize = (g.name as NSString).size(withAttributes: nameAttrs)
            (g.name as NSString).draw(at: NSPoint(x: Self.side * 2, y: (mid - nameSize.height / 2).rounded()),
                                      withAttributes: nameAttrs)
            let count = "\(g.count)" as NSString
            let countSize = count.size(withAttributes: countAttrs)
            count.draw(at: NSPoint(x: (columnWidth ?? bounds.width) - Self.side * 2 - ceil(countSize.width),
                                   y: (mid - countSize.height / 2).rounded()), withAttributes: countAttrs)
        }
    }
}

extension SidebarListView {
    /// A click on a repository's header collapses it to the header, or opens it again.
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let g = groups.first(where: { p.y >= $0.y && p.y < $0.y + Self.headerHeight }) else {
            super.mouseDown(with: event)
            return
        }
        onToggleCollapsed(g.root)
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

/// The sidebar's Overview item: a small line of stops, "Overview" and the number of agents running.
/// Styled like an environment row (radius 6; `raised` and `borderStrong` when selected, `raised` at 50 %
/// on hover).
private final class OverviewNavRow: NSView {
    var theme: Theme { didSet { needsDisplay = true } }
    var selected = false { didSet { needsDisplay = true; setAccessibilitySelected(selected) } }
    var count = 0 { didSet { if count != oldValue { needsDisplay = true } } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Overview of the agents' plans")
        toolTip = "Every running agent's plan (⌘⇧O)"
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { onPress?() }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }

    override func draw(_ dirtyRect: NSRect) {
        let radius = DesignTokens.Radius.card
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        if selected {
            theme.color(\.raised).setFill(); box.fill()
            theme.color(\.borderStrong).setStroke(); box.lineWidth = 1; box.stroke()
        } else if hovering {
            theme.color(\.raised, alpha: 0.5).setFill(); box.fill()
        }
        // the glyph: three stops on a line, the last one open
        let midY = bounds.midY, x0: CGFloat = 12
        let line = NSBezierPath()
        line.move(to: NSPoint(x: x0, y: midY)); line.line(to: NSPoint(x: x0 + 16, y: midY))
        line.lineWidth = 1.5
        theme.color(\.muted).setStroke(); line.stroke()
        for (i, filled) in [true, true, false].enumerated() {
            let c = NSPoint(x: x0 + CGFloat(i) * 8, y: midY)
            let dot = NSBezierPath(ovalIn: NSRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5))
            if filled { theme.color(\.text2).setFill(); dot.fill() } else {
                theme.color(\.bg).setFill(); dot.fill(); theme.color(\.text2).setStroke(); dot.lineWidth = 1.2; dot.stroke()
            }
        }
        let title: [NSAttributedString.Key: Any] = [.font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium),
                                                    .foregroundColor: theme.color(\.text)]
        let size = ("Overview" as NSString).size(withAttributes: title)
        ("Overview" as NSString).draw(at: NSPoint(x: x0 + 28, y: (midY - size.height / 2).rounded()), withAttributes: title)
        guard count > 0 else { return }
        let badge: [NSAttributedString.Key: Any] = [.font: Theme.mono(DesignTokens.TypeScale.caption),
                                                    .foregroundColor: theme.color(\.muted)]
        let text = "\(count)" as NSString
        let w = text.size(withAttributes: badge)
        text.draw(at: NSPoint(x: bounds.maxX - 12 - w.width, y: (midY - w.height / 2).rounded()), withAttributes: badge)
    }
}

// MARK: the repositories menu

extension SidebarView: NSMenuDelegate {
    /// Built each time it opens: Active / All repositories, then every repository, ticked when it is
    /// listed. An active one (an open session or a running agent) is always listed; picking another
    /// pins it to the list, picking it again unpins it.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        // a pull-down shows its first item as the button's face
        let face = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        face.image = NSImage(systemSymbolName: "line.3.horizontal.decrease.circle", accessibilityDescription: "Repositories shown")
        menu.addItem(face)
        let active = NSMenuItem(title: "Active repositories", action: #selector(showActive(_:)), keyEquivalent: "")
        active.state = hideEmptyRepos ? .on : .off
        let all = NSMenuItem(title: "All repositories", action: #selector(showAll(_:)), keyEquivalent: "")
        all.state = hideEmptyRepos ? .off : .on
        for item in [active, all] { item.target = self; menu.addItem(item) }
        guard !repos.isEmpty else { return }
        menu.addItem(.separator())
        let listed = Set(sidebarGroups(repos, query: "", isOpen: { [selectedId, isOpen, isSuspended] in
            $0.id == selectedId || (isOpen($0) && !isSuspended($0))
        }, expanded: [], hideEmpty: true).map(\.repo.root))
        for g in repos {
            let item = NSMenuItem(title: g.repo.name, action: #selector(togglePinned(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = g.repo.root
            let isActive = listed.contains(g.repo.root)
            item.state = isActive || pinned.contains(g.repo.root) || !hideEmptyRepos ? .on : .off
            // an active repository is listed whatever is picked
            if isActive { item.action = nil; item.toolTip = "Has an open session" }
            menu.addItem(item)
        }
    }

    @objc private func showActive(_ sender: Any?) { onShowAllRepos(false) }
    @objc private func showAll(_ sender: Any?) { onShowAllRepos(true) }

    @objc private func togglePinned(_ sender: NSMenuItem) {
        guard let root = sender.representedObject as? String else { return }
        if pinned.contains(root) { pinned.remove(root) } else { pinned.insert(root) }
        // picking a repository while all are listed means: list the active ones and this one
        if !hideEmptyRepos && pinned.contains(root) { onShowAllRepos(false) }
        reload()
    }
}

/// Scrolls only sideways: a mostly vertical wheel or trackpad move goes to the enclosing list, so the
/// plans beside the sidebar's rows scroll up and down with them.
final class SidewaysScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) {
            nextResponder?.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}
