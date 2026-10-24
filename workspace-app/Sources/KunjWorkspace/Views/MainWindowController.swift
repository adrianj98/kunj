import AppKit
import KunjWorkspaceCore

/// The window: sidebar (272) | header (52) over the TerminalColumn (11fr) and the ChangesColumn
/// (9fr), status bar (28) under both, 1 px `border` hairlines between them. Everything is driven by
/// `render(repos:selected:)`, which takes the store's `[RepoEnvironments]` as they are.
final class MainWindowController: NSWindowController, NSWindowDelegate {
    private(set) var theme = ThemeManager.shared.current
    private(set) var repos: [RepoEnvironments] = []
    /// The selected environment's id; kept while its row is briefly gone from a refresh (a worktree
    /// mid-rebase is detached), so it comes back selected.
    private(set) var selectedId: String?
    private(set) var selectedEnvironment: Environment?
    private var discoveryError: String?

    /// The user selected a row. `render` never calls it: a selection whose row is gone stays
    /// selected (and shows "Select an environment") until the row returns.
    var onSelect: (Environment?) -> Void = { _ in }
    var onHeaderAction: (HeaderAction, Environment) -> Void = { _, _ in }
    var onNewSession: () -> Void = {}
    var lastActivity: (String) -> Date? = { _ in nil } { didSet { sidebar.lastActivity = lastActivity } }

    private let root = FillView(.clear)
    private let effect = NSVisualEffectView()
    private let sideTint = FillView(.clear)
    let sidebar: SidebarView
    let header: HeaderView
    let terminalColumn: TerminalColumn
    let changesColumn: ChangesColumn
    let statusBar: StatusBarView
    private let lines = (0..<4).map { _ in FillView(.clear) }
    private let mainArea = FillView(.clear)
    private let emptyState = NSStackView()
    private let emptyTitle = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium), color: .clear)
    private let emptyDetail = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private var timeTimer: Timer?

    init() {
        let t = ThemeManager.shared.current
        sidebar = SidebarView(theme: t)
        header = HeaderView(theme: t)
        terminalColumn = TerminalColumn(theme: t)
        changesColumn = ChangesColumn(theme: t)
        statusBar = StatusBarView(theme: t)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Kunj Workspace"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 1000, height: 560)
        window.center()
        super.init(window: window)
        window.delegate = self
        buildLayout()
        sidebar.onSelect = { [weak self] id in self?.select(id) }
        sidebar.onNewSession = { [weak self] in self?.onNewSession() }
        header.onAction = { [weak self] action in
            guard let self, let env = self.selectedEnvironment else { return }
            self.onHeaderAction(action, env)
        }
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(t)
        renderSelection()
        timeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.sidebar.refreshTimes()
            self?.statusBar.show(self?.selectedEnvironment, environmentCount: self?.environmentCount ?? 0)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: state

    /// Shows the environments; `selected` replaces the selection, nil keeps it.
    func render(repos: [RepoEnvironments], selected: String? = nil) {
        self.repos = repos
        if let selected { selectedId = selected }
        sidebar.repos = repos
        sidebar.selectedId = selectedId
        renderSelection()
    }

    func select(_ id: String) {
        guard id != selectedId else { return }
        selectedId = id
        sidebar.selectedId = id
        renderSelection()
        onSelect(selectedEnvironment)
    }

    /// The kunj version (`kunj 1.4.2`, `kunj 1.0.0 dev`) at the sidebar's foot.
    func setKunjVersion(_ label: String) {
        sidebar.versionLabel = label
    }

    /// Discovery failed (kunj missing or too old): one message in place of the list and the
    /// columns (Review Focus 1). nil clears it.
    func showDiscoveryError(_ message: String?) {
        discoveryError = message
        if message != nil { sidebar.versionLabel = "" }
        renderSelection()
    }

    /// A failed listing while kunj works (shown in red on the status bar).
    func showListingError(_ message: String?) {
        statusBar.showError(message)
    }

    private var environmentCount: Int { repos.reduce(0) { $0 + $1.environments.count } }

    private func environment(id: String?) -> Environment? {
        guard let id else { return nil }
        for g in repos { if let e = g.environments.first(where: { $0.id == id }) { return e } }
        return nil
    }

    private func renderSelection() {
        let env = discoveryError == nil ? environment(id: selectedId) : nil
        selectedEnvironment = env
        header.show(env)
        terminalColumn.show(env)
        changesColumn.show(env)
        statusBar.show(env, environmentCount: environmentCount)
        let showColumns = env != nil
        for v in [terminalColumn, changesColumn, lines[1], lines[2]] as [NSView] { v.isHidden = !showColumns }
        emptyState.isHidden = showColumns
        if let discoveryError {
            emptyTitle.stringValue = discoveryError
            emptyTitle.textColor = theme.color(\.red)
            emptyDetail.stringValue = "Install or update it with npm install -g kunj"
            emptyDetail.isHidden = discoveryError.contains("npm install")
        } else {
            emptyTitle.stringValue = repos.isEmpty ? "No repositories yet" : "Select an environment"
            emptyTitle.textColor = theme.color(\.muted)
            emptyDetail.stringValue = "Run kunj in a repository to add it"
            emptyDetail.isHidden = !repos.isEmpty
        }
    }

    // MARK: theme

    private func apply(_ t: Theme) {
        theme = t
        window?.appearance = t.appearance
        window?.backgroundColor = t.color(\.bg)
        root.color = t.color(\.bg)
        mainArea.color = t.color(\.bg)
        sideTint.color = t.color(\.side, alpha: Self.sideTintAlpha)
        for l in lines { l.color = t.color(\.border) }
        sidebar.theme = t
        header.theme = t
        terminalColumn.theme = t
        changesColumn.theme = t
        statusBar.theme = t
        emptyDetail.textColor = t.color(\.faint)
        renderSelection()
    }

    /// The sidebar is the navigation layer (DESIGN.md principle 7): vibrancy under a `side` tint.
    /// 0.94 keeps it within a shade of `side` over any desktop (0.85 sampled #242220 against the
    /// mockup's #201d1b) while a bright wallpaper still shows through faintly.
    static let sideTintAlpha: CGFloat = 0.94

    // MARK: layout

    private func buildLayout() {
        guard let content = window?.contentView else { return }
        let L = DesignTokens.Layout.self
        content.addSubview(root)
        pin(root, to: content)

        effect.material = .sidebar
        effect.blendingMode = .behindWindow
        effect.state = .followsWindowActiveState
        effect.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(sideTint)
        pin(sideTint, to: effect)
        effect.addSubview(sidebar)
        pin(sidebar, to: effect)

        emptyState.orientation = .vertical
        emptyState.alignment = .centerX
        emptyState.spacing = 6
        emptyState.translatesAutoresizingMaskIntoConstraints = false
        emptyState.addArrangedSubview(emptyTitle)
        emptyState.addArrangedSubview(emptyDetail)
        emptyTitle.alignment = .center

        let sidebarLine = lines[0], columnLine = lines[1], headerLine = lines[2], statusLine = lines[3]
        for v in [effect, sidebarLine, mainArea, header, headerLine, terminalColumn, columnLine, changesColumn,
                  statusLine, statusBar, emptyState] as [NSView] {
            root.addSubview(v)
        }
        let leftShare = L.paneSplit.0 / (L.paneSplit.0 + L.paneSplit.1)
        NSLayoutConstraint.activate([
            effect.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            effect.topAnchor.constraint(equalTo: root.topAnchor),
            effect.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            effect.widthAnchor.constraint(equalToConstant: L.sidebarWidth),

            sidebarLine.leadingAnchor.constraint(equalTo: effect.trailingAnchor),
            sidebarLine.topAnchor.constraint(equalTo: root.topAnchor),
            sidebarLine.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebarLine.widthAnchor.constraint(equalToConstant: 1),

            mainArea.leadingAnchor.constraint(equalTo: sidebarLine.trailingAnchor),
            mainArea.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            mainArea.topAnchor.constraint(equalTo: root.topAnchor),
            mainArea.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            header.leadingAnchor.constraint(equalTo: sidebarLine.trailingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.heightAnchor.constraint(equalToConstant: L.headerHeight),

            headerLine.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            headerLine.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            headerLine.topAnchor.constraint(equalTo: header.bottomAnchor),
            headerLine.heightAnchor.constraint(equalToConstant: 1),

            statusBar.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            statusBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            statusBar.heightAnchor.constraint(equalToConstant: L.statusbarHeight),

            statusLine.leadingAnchor.constraint(equalTo: statusBar.leadingAnchor),
            statusLine.trailingAnchor.constraint(equalTo: statusBar.trailingAnchor),
            statusLine.bottomAnchor.constraint(equalTo: statusBar.topAnchor),
            statusLine.heightAnchor.constraint(equalToConstant: 1),

            terminalColumn.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            terminalColumn.topAnchor.constraint(equalTo: headerLine.bottomAnchor),
            terminalColumn.bottomAnchor.constraint(equalTo: statusLine.topAnchor),
            terminalColumn.widthAnchor.constraint(equalTo: header.widthAnchor, multiplier: leftShare, constant: -1),

            columnLine.leadingAnchor.constraint(equalTo: terminalColumn.trailingAnchor),
            columnLine.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            columnLine.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),
            columnLine.widthAnchor.constraint(equalToConstant: 1),

            changesColumn.leadingAnchor.constraint(equalTo: columnLine.trailingAnchor),
            changesColumn.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            changesColumn.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            changesColumn.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),

            emptyState.centerXAnchor.constraint(equalTo: mainArea.centerXAnchor),
            emptyState.centerYAnchor.constraint(equalTo: mainArea.centerYAnchor),
            emptyState.leadingAnchor.constraint(greaterThanOrEqualTo: mainArea.leadingAnchor, constant: 40),
        ])
    }

    private func pin(_ v: NSView, to parent: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            v.topAnchor.constraint(equalTo: parent.topAnchor),
            v.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
        ])
    }

    // MARK: traffic lights

    /// The traffic lights sit in the sidebar's 52 px top, 16 px in and centred (as in the mockup):
    /// the titlebar container is made 52 px tall and the buttons moved inside it. AppKit puts them
    /// back on resize and full screen, so this runs after each.
    func placeTrafficLights() {
        guard let window, !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let container = close.superview?.superview else { return }
        let height = DesignTokens.Layout.headerHeight
        container.frame = NSRect(x: 0, y: window.frame.height - height, width: window.frame.width, height: height)
        for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let b = window.standardWindowButton(kind) else { continue }
            var f = b.frame
            f.origin.x = 15 + CGFloat(i) * 20
            f.origin.y = ((b.superview?.frame.height ?? CGFloat(height)) - f.height) / 2
            b.setFrameOrigin(f.origin)
        }
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        placeTrafficLights()
    }

    func windowDidResize(_ notification: Notification) { placeTrafficLights() }
    func windowDidExitFullScreen(_ notification: Notification) { placeTrafficLights() }

    // MARK: snapshots

    /// Renders the window's content into a PNG without screen-recording permission, through
    /// cacheDisplay (from spikes/native-ide Workspace.swift). The traffic lights are in the
    /// titlebar, not the content, so they are not in it. Terminals and the WKWebView are
    /// composited separately once they exist (Tasks 7 and 9).
    func snapshotPNG(completion: @escaping (Data?) -> Void) {
        guard let root = window?.contentView else { completion(nil); return }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { completion(nil); return }
        root.cacheDisplay(in: root.bounds, to: rep)
        // cacheDisplay renders in a calibrated (generic) RGB space; convert so the PNG's pixels
        // are the sRGB token values, comparable with the mockups
        let out = rep.converting(to: .sRGB, renderingIntent: .default) ?? rep
        completion(out.representation(using: .png, properties: [:]))
    }
}
