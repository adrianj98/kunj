import AppKit
import KunjWorkspaceCore

/// The window: sidebar (272) | header (52) over the TerminalColumn (11fr) and the ChangesColumn
/// (9fr), status bar (28) under both, 1 px `border` hairlines between them. Everything is driven by
/// `render(repos:selected:)`, which takes the store's `[RepoEnvironments]` as they are. The hairlines
/// beside the sidebar, between the columns, before the Files column and after the Changes file list
/// are dragged by `DividerHandle`s (`paneSizes`).
final class MainWindowController: NSWindowController, NSWindowDelegate {
    private(set) var theme = ThemeManager.shared.current
    private(set) var repos: [RepoEnvironments] = []
    /// The selected environment's id; kept while its row is briefly gone from a refresh (a worktree
    /// mid-rebase is detached), so it comes back selected.
    private(set) var selectedId: String?
    private(set) var selectedEnvironment: Environment?
    private var discoveryError: String?
    private var discoveryDetail: String?
    /// Finding kunj or the first listing still running (a spinner and the step in place of the columns)
    private var loading: LoadingStep?

    /// The user selected a row. `render` never calls it: a selection whose row is gone stays
    /// selected (and shows "Select an environment") until the row returns.
    var onSelect: (Environment?) -> Void = { _ in }
    var onHeaderAction: (HeaderAction, Environment) -> Void = { _, _ in }
    var onNewSession: () -> Void = {}
    var lastActivity: (String) -> Date? = { _ in nil } { didSet { sidebar.lastActivity = lastActivity } }
    /// The tab bar's Changes pill was pressed (the app toggles the column and saves it).
    var onToggleChanges: () -> Void = {}
    /// The tab bar's Files pill was pressed.
    var onToggleFiles: () -> Void = {}
    /// Whether the Files column (the right edge, `paneSizes.files` wide) is open; closed by default.
    private(set) var filesVisible = false
    private var filesWidth: NSLayoutConstraint!
    private var filesLineWidth: NSLayoutConstraint!
    private let filesLine = FillView(.clear)
    /// Whether the Changes column is open (`setChangesVisible`); closed, the terminal column takes
    /// the width and the column computes nothing.
    private(set) var changesVisible = true
    private var splitWidth: NSLayoutConstraint!
    private var fullWidth: NSLayoutConstraint!
    private var sidebarWidth: NSLayoutConstraint!
    /// The widths the dividers were dragged to (the standard ones until then); what is shown is
    /// these fitted to the window (`PaneSizes.fitted`).
    var paneSizes = PaneSizes.standard { didSet { applyPaneSizes() } }
    /// A divider was let go or reset: the app saves `paneSizes`.
    var onPaneSizesChanged: (PaneSizes) -> Void = { _ in }
    private var dragStart: PaneSizes?
    private let sidebarHandle = DividerHandle(label: "Sidebar width")
    private let splitHandle = DividerHandle(label: "Changes column width")
    private let filesHandle = DividerHandle(label: "Files column width")
    /// The hairline between the columns: 0 wide while the Changes column is closed.
    private var columnLineWidth: NSLayoutConstraint!

    private let root = FillView(.clear)
    private let effect = NSVisualEffectView()
    private let sideTint = FillView(.clear)
    let sidebar: SidebarView
    let header: HeaderView
    let terminalColumn: TerminalColumn
    let changesColumn: ChangesColumn
    let filesColumn: FilesColumn
    let statusBar: StatusBarView
    private let lines = (0..<4).map { _ in FillView(.clear) }
    private let mainArea = FillView(.clear)
    private let emptyState = NSStackView()
    private let emptySpinner = NSProgressIndicator()
    private let emptyTitle = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium), color: .clear)
    private let emptyDetail = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private var timeTimer: Timer?

    init() {
        let t = ThemeManager.shared.current
        sidebar = SidebarView(theme: t)
        header = HeaderView(theme: t)
        terminalColumn = TerminalColumn(theme: t)
        changesColumn = ChangesColumn(theme: t)
        filesColumn = FilesColumn(theme: t)
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
        terminalColumn.onToggleChanges = { [weak self] in self?.onToggleChanges() }
        terminalColumn.onToggleFiles = { [weak self] in self?.onToggleFiles() }
        changesColumn.onClose = { [weak self] in self?.onToggleChanges() }
        filesColumn.onClose = { [weak self] in self?.onToggleFiles() }
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

    /// A worktree checked out another branch: the selection follows it (the next render shows it).
    /// True when it was selected.
    @discardableResult
    func environmentMoved(from oldId: String, to newId: String) -> Bool {
        guard selectedId == oldId else { return false }
        selectedId = newId
        sidebar.selectedId = newId
        return true
    }

    /// The environment's session was closed: it leaves the sidebar (deselected when selected).
    func sessionClosed(_ id: String) {
        if selectedId == id {
            selectedId = nil
            sidebar.selectedId = nil
            renderSelection()
            onSelect(nil)
        }
        sidebar.reloadRows()
    }

    func select(_ id: String) {
        guard id != selectedId else { return }
        selectedId = id
        sidebar.selectedId = id
        renderSelection()
        onSelect(selectedEnvironment)
    }

    /// Opens or closes the Files column at the right edge: closed, it is 0 wide and lists nothing.
    func setFilesVisible(_ visible: Bool, animated: Bool) {
        guard visible != filesVisible else { return }
        filesVisible = visible
        filesColumn.isActive = visible
        filesLineWidth.constant = visible ? 1 : 0
        applyPaneSizes()
        renderSelection()
        guard animated, let content = window?.contentView else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            ctx.allowsImplicitAnimation = true
            content.layoutSubtreeIfNeeded()
        }
    }

    /// Opens or closes the Changes column: closed, it collapses to zero width (the terminal column
    /// takes the window) and stops computing diffs; opened, it loads the selected environment.
    func setChangesVisible(_ visible: Bool, animated: Bool) {
        guard visible != changesVisible else { return }
        changesVisible = visible
        changesColumn.isActive = visible
        columnLineWidth.constant = visible ? 1 : 0
        if visible {
            fullWidth.isActive = false
            splitWidth.isActive = true
        } else {
            splitWidth.isActive = false
            fullWidth.isActive = true
        }
        applyPaneSizes()
        renderSelection()
        guard animated, let content = window?.contentView else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            ctx.allowsImplicitAnimation = true
            content.layoutSubtreeIfNeeded()
        }
    }

    /// The ids of the visible sidebar rows, in order (⌘1–9 select the nth).
    var visibleEnvironmentIds: [String] { sidebar.visibleIds }

    /// The kunj version (`kunj 1.4.2`, `kunj 1.0.0 dev`) at the sidebar's foot.
    func setKunjVersion(_ label: String) {
        sidebar.versionLabel = label
    }

    /// Discovery failed (kunj missing or too old): one message in place of the list and the
    /// columns (Review Focus 1). nil clears it.
    func showDiscoveryError(_ message: String?, detail: String? = nil) {
        discoveryError = message
        discoveryDetail = detail
        if message != nil { sidebar.versionLabel = "" }
        renderSelection()
    }

    /// The startup step in progress, nil once the first listing is in (or discovery failed).
    func showLoading(_ step: LoadingStep?) {
        loading = step
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
        filesColumn.show(env)
        statusBar.show(env, environmentCount: environmentCount)
        terminalColumn.setChanges(count: env?.changedFiles ?? 0, open: changesVisible)
        terminalColumn.setFiles(open: filesVisible)
        let showColumns = env != nil
        for v in [terminalColumn, lines[2]] as [NSView] { v.isHidden = !showColumns }
        for v in [changesColumn, lines[1], splitHandle] as [NSView] { v.isHidden = !showColumns || !changesVisible }
        for v in [filesColumn, filesLine, filesHandle] as [NSView] { v.isHidden = !showColumns || !filesVisible }
        emptyState.isHidden = showColumns
        let text = emptyStateText(discoveryError: discoveryError, discoveryDetail: discoveryDetail,
                                  loading: loading, hasRepos: !repos.isEmpty)
        emptyTitle.stringValue = text.title
        emptyTitle.textColor = theme.color(text.tone == .error ? \.red : \.muted)
        emptyDetail.stringValue = text.detail ?? ""
        emptyDetail.isHidden = text.detail == nil
        emptySpinner.isHidden = !text.spinner || showColumns
        if emptySpinner.isHidden { emptySpinner.stopAnimation(nil) } else { emptySpinner.startAnimation(nil) }
    }

    // MARK: pane sizes

    private var windowWidth: Double { Double(window?.contentView?.bounds.width ?? 1440) }

    /// `paneSizes` as they fit the window now.
    private var fittedSizes: PaneSizes {
        paneSizes.fitted(windowWidth: windowWidth, filesOpen: filesVisible, changesOpen: changesVisible)
    }

    private var mainWidth: Double {
        let f = fittedSizes
        return PaneSizes.mainWidth(windowWidth: windowWidth, sidebar: f.sidebar, files: filesVisible ? f.files : nil)
    }

    /// Sets the constraints from `paneSizes` fitted to the window (after a drag, a toggle or a resize).
    private func applyPaneSizes() {
        guard sidebarWidth != nil else { return }
        let f = fittedSizes
        sidebarWidth.constant = f.sidebar
        filesWidth.constant = filesVisible ? f.files : 0
        changesColumn.fileListWidth = f.fileList
        let share = f.changesShare
        let multiplier = (1 - share) / share
        if abs(splitWidth.multiplier - multiplier) > 0.0001 {
            // a multiplier is fixed once made: replace the constraint
            let active = splitWidth.isActive
            splitWidth.isActive = false
            splitWidth = terminalColumn.widthAnchor.constraint(equalTo: changesColumn.widthAnchor, multiplier: multiplier)
            splitWidth.isActive = active
        }
    }

    private func wireHandle(_ handle: DividerHandle, drag: @escaping (PaneSizes, Double) -> PaneSizes,
                            reset: @escaping (inout PaneSizes) -> Void) {
        handle.onBegin = { [weak self] in self?.dragStart = self?.fittedSizes }
        handle.onDrag = { [weak self] dx in
            guard let self, let start = self.dragStart else { return }
            self.paneSizes = drag(start, Double(dx)).fitted(windowWidth: self.windowWidth, filesOpen: self.filesVisible,
                                                             changesOpen: self.changesVisible)
        }
        handle.onEnd = { [weak self] in
            guard let self else { return }
            self.dragStart = nil
            self.onPaneSizesChanged(self.paneSizes)
        }
        handle.onReset = { [weak self] in
            guard let self else { return }
            reset(&self.paneSizes)
            self.onPaneSizesChanged(self.paneSizes)
        }
    }

    private func wireHandles() {
        wireHandle(sidebarHandle, drag: { s, dx in var s = s; s.sidebar += dx; return s },
                   reset: { $0.sidebar = PaneSizes.standard.sidebar })
        wireHandle(splitHandle, drag: { [weak self] s, dx in
            var s = s
            let main = self?.mainWidth ?? 1
            s.changesShare = (s.changesShare * main - dx) / main
            return s
        }, reset: { $0.changesShare = PaneSizes.standard.changesShare })
        wireHandle(filesHandle, drag: { s, dx in var s = s; s.files -= dx; return s },
                   reset: { $0.files = PaneSizes.standard.files })
        wireHandle(changesColumn.listHandle, drag: { s, dx in var s = s; s.fileList += dx; return s },
                   reset: { $0.fileList = PaneSizes.standard.fileList })
    }

    // MARK: theme

    private func apply(_ t: Theme) {
        theme = t
        window?.appearance = t.appearance
        window?.backgroundColor = t.color(\.bg)
        root.color = t.color(\.bg)
        mainArea.color = t.color(\.bg)
        sideTint.color = t.color(\.side, alpha: Self.sideTintAlpha)
        for l in lines + [filesLine] { l.color = t.color(\.border) }
        sidebar.theme = t
        header.theme = t
        terminalColumn.theme = t
        changesColumn.theme = t
        filesColumn.theme = t
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
        emptySpinner.style = .spinning
        emptySpinner.controlSize = .small
        emptySpinner.isDisplayedWhenStopped = false
        emptySpinner.isHidden = true
        emptyState.addArrangedSubview(emptySpinner)
        emptyState.setCustomSpacing(10, after: emptySpinner)
        emptyState.addArrangedSubview(emptyTitle)
        emptyState.addArrangedSubview(emptyDetail)
        emptyTitle.alignment = .center
        // the login-shell timeout hint carries a whole PATH
        emptyDetail.alignment = .center
        emptyDetail.maximumNumberOfLines = 0
        emptyDetail.lineBreakMode = .byCharWrapping
        emptyDetail.preferredMaxLayoutWidth = 520

        let sidebarLine = lines[0], columnLine = lines[1], headerLine = lines[2], statusLine = lines[3]
        // the handles last, so they are hit before the terminal and the web views they overlap
        for v in [effect, sidebarLine, mainArea, header, headerLine, terminalColumn, columnLine, changesColumn,
                  filesLine, filesColumn, statusLine, statusBar, emptyState,
                  sidebarHandle, splitHandle, filesHandle] as [NSView] {
            root.addSubview(v)
        }
        for (handle, line) in [(sidebarHandle, sidebarLine), (splitHandle, columnLine), (filesHandle, filesLine)] {
            NSLayoutConstraint.activate([
                handle.centerXAnchor.constraint(equalTo: line.centerXAnchor),
                handle.widthAnchor.constraint(equalToConstant: DividerHandle.width),
                handle.topAnchor.constraint(equalTo: line === sidebarLine ? root.topAnchor : terminalColumn.topAnchor),
                handle.bottomAnchor.constraint(equalTo: line === sidebarLine ? root.bottomAnchor : terminalColumn.bottomAnchor),
            ])
        }
        NSLayoutConstraint.activate([
            effect.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            effect.topAnchor.constraint(equalTo: root.topAnchor),
            effect.bottomAnchor.constraint(equalTo: root.bottomAnchor),

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

            columnLine.leadingAnchor.constraint(equalTo: terminalColumn.trailingAnchor),
            columnLine.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            columnLine.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),

            changesColumn.leadingAnchor.constraint(equalTo: columnLine.trailingAnchor),
            changesColumn.trailingAnchor.constraint(equalTo: filesLine.leadingAnchor),

            filesLine.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            filesLine.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),
            filesColumn.leadingAnchor.constraint(equalTo: filesLine.trailingAnchor),
            filesColumn.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            filesColumn.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            filesColumn.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),
            changesColumn.topAnchor.constraint(equalTo: terminalColumn.topAnchor),
            changesColumn.bottomAnchor.constraint(equalTo: terminalColumn.bottomAnchor),

            terminalColumn.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor),

            emptyState.centerXAnchor.constraint(equalTo: mainArea.centerXAnchor),
            emptyState.centerYAnchor.constraint(equalTo: mainArea.centerYAnchor),
            emptyState.leadingAnchor.constraint(greaterThanOrEqualTo: mainArea.leadingAnchor, constant: 40),
        ])
        sidebarWidth = effect.widthAnchor.constraint(equalToConstant: paneSizes.sidebar)
        sidebarWidth.isActive = true
        // 11:9 of the width left of the Files column by default (`paneSizes.changesShare`)
        let share = paneSizes.changesShare
        splitWidth = terminalColumn.widthAnchor.constraint(equalTo: changesColumn.widthAnchor, multiplier: (1 - share) / share)
        fullWidth = terminalColumn.trailingAnchor.constraint(equalTo: filesLine.leadingAnchor)
        filesWidth = filesColumn.widthAnchor.constraint(equalToConstant: 0)
        filesWidth.isActive = true
        filesLineWidth = filesLine.widthAnchor.constraint(equalToConstant: 0)
        filesLineWidth.isActive = true
        splitWidth.isActive = true
        columnLineWidth = columnLine.widthAnchor.constraint(equalToConstant: 1)
        columnLineWidth.isActive = true
        wireHandles()
        applyPaneSizes()
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

    func windowDidResize(_ notification: Notification) {
        placeTrafficLights()
        applyPaneSizes()
    }
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
        compositeTerminals(into: rep, root: root)
        // cacheDisplay renders in a calibrated (generic) RGB space; convert so the PNG's pixels
        // are the sRGB token values, comparable with the mockups
        let out = rep.converting(to: .sRGB, renderingIntent: .default) ?? rep
        // The diff's WKWebView is not drawn by cacheDisplay: draw its own snapshot on top
        changesColumn.snapshotOverlay(in: root) { overlay in
            if let (frame, image) = overlay {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
                // the bitmap is unflipped and, once converted, sized in pixels: convert the
                // (possibly flipped) content view's rect
                let scale = out.size.width / max(1, root.bounds.width)
                let y = root.isFlipped ? root.bounds.height - frame.maxY : frame.minY
                image.draw(in: NSRect(x: frame.minX * scale, y: y * scale,
                                      width: frame.width * scale, height: frame.height * scale))
                NSGraphicsContext.restoreGraphicsState()
            }
            completion(out.representation(using: .png, properties: [:]))
        }
    }

    /// SwiftTerm leaves default-background cells transparent and relies on its layer's background,
    /// which cacheDisplay does not draw, so each visible terminal is rendered on its own and
    /// composited over its background colour (the spike's snapshot code).
    private func compositeTerminals(into rep: NSBitmapImageRep, root: NSView) {
        let terms = terminalColumn.registry.allTerminals.filter { !$0.isHidden && $0.window != nil && !$0.isHiddenOrHasHiddenAncestor }
        guard !terms.isEmpty else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        for t in terms {
            guard let trep = t.bitmapImageRepForCachingDisplay(in: t.bounds) else { continue }
            // the overlay scroller is invisible on screen until scrolling, but cacheDisplay draws its track
            let scrollers = t.subviews.filter { $0 is NSScroller && !$0.isHidden }
            scrollers.forEach { $0.isHidden = true }
            t.cacheDisplay(in: t.bounds, to: trep)
            scrollers.forEach { $0.isHidden = false }
            var r = t.convert(t.bounds, to: root)
            if root.isFlipped { r.origin.y = root.bounds.height - r.maxY }
            t.nativeBackgroundColor.setFill()
            r.fill()
            trep.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
    }
}
