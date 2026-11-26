import AppKit
import KunjWorkspaceCore

/// Where the Files column's listing comes from: `FileLister` in the app, `DemoFiles` for `--demo`.
protocol FilesSource: AnyObject {
    func files(env: Environment) async throws -> FileLister.Listing
    /// The branch's changed files against its base (working tree included), for the tree's colours
    func changes(env: Environment) async throws -> [String: FileStatus]
    /// The ignored folders, for the worktree watcher's filter
    func ignoredDirectories(env: Environment) async -> [String]
}

final class FileListerSource: FilesSource {
    let lister: FileLister
    let diff: DiffService
    init(cli: KunjCLI) { lister = FileLister(cli: cli); diff = DiffService(cli: cli) }
    func files(env: Environment) async throws -> FileLister.Listing { try await lister.list(env: env) }
    func changes(env: Environment) async throws -> [String: FileStatus] { try await diff.changedPaths(env: env) }
    func ignoredDirectories(env: Environment) async -> [String] { (try? await lister.ignoredDirectories(env: env)) ?? [] }
}

/// A node of the outline view (it needs objects, and the same object for the same item across
/// `reloadData`, so folders keep their open state).
/// Items built off the main thread and handed over once, untouched until then.
private struct FileItemTree: @unchecked Sendable {
    let items: [FileItem]
    init(_ items: [FileItem]) { self.items = items }
}

private final class FileItem: NSObject {
    let node: FileNode
    let children: [FileItem]
    init(_ node: FileNode) {
        self.node = node
        children = node.children.map(FileItem.init)
    }
}

/// The file explorer at the window's right edge (opened with the tab bar's Files pill or View >
/// Show Files ⌘⇧E; closed by default): the Files bar (40 px like the Changes bar: the `Files` and
/// `Search` modes, the count in mono 11 `faint`, a `border` hairline under it) over the environment's
/// files as a tree (tracked, untracked and ignored, see `FileLister`; folders first; ignored ones in
/// `faint`, an ignored folder without its contents). A
/// double-click (or Return) on a file opens it in an editor tab; on a folder opens or closes it.
/// Open folders are kept per environment. A file the branch changed against its base (committed,
/// modified or untracked, as the Changes column's `vs base`) is drawn in `green` (added) or `amber`
/// (modified, renamed) with its status letter at the right, and a folder holding one in `amber`
/// with a dot. It reloads when the environment changes and 1 s after a `git` event of its
/// repository or a file event in the worktree (`WorktreeWatcher`); closed, it lists nothing. In Search mode (Find in Files ⌘⇧F) the
/// `SearchPanel` takes the place of the tree.
final class FilesColumn: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate {
    enum Mode { case files, search }

    var theme: Theme { didSet { apply() } }
    private(set) var mode = Mode.files
    private(set) var environment: Environment?
    /// Set once kunj is discovered (or by `--demo`).
    var source: FilesSource? { didSet { reload() } }
    var isActive = false {
        didSet {
            guard isActive != oldValue else { return }
            searchPanel.isActive = isActive && mode == .search
            if isActive {
                reload()
            } else {
                pendingReload?.cancel(); pendingReload = nil; generation += 1; reloader.cancelPending()
            }
        }
    }
    let searchPanel: SearchPanel
    /// A file was opened (double-click or Return): show it in an editor tab.
    var onOpen: ((Environment, String) -> Void)?
    /// The × at the bar's right: close the column.
    var onClose: () -> Void = {}
    private let closeButton = BarIconButton(.close, label: "Close Files")

    static let rowHeight: CGFloat = 24
    static let debounce: TimeInterval = 1

    private let bar = FillView(.clear)
    private let barLine = FillView(.clear)
    private let filesTab = HeaderTextButton("Files")
    private let searchTab = HeaderTextButton("Search")
    private let count = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let message = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let outline = NSOutlineView()
    private let scroll = NSScrollView()

    private var items: [FileItem] = []
    /// The branch's changes (path → status) and the folders that hold one, from the last listing
    private var changes: [String: FileStatus] = [:]
    private var changedFolders: Set<String> = []
    private var listedId: String?
    private var expanded: [String: Set<String>] = [:]
    private var restoring = false
    private var generation = 0
    private var pendingReload: DispatchWorkItem?
    /// Lists the files, one listing at a time; skipped while the window is hidden.
    private lazy var reloader = SerialReloader { [weak self] in await self?.loadFiles() }

    init(theme: Theme) {
        self.theme = theme
        searchPanel = SearchPanel(theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        buildOutline()
        for v in [bar, barLine, scroll, message, searchPanel] as [NSView] { addSubview(v) }
        for v in [filesTab, searchTab, count, closeButton] as [NSView] { bar.addSubview(v) }
        filesTab.toolTip = "Files (⌘⇧E)"
        searchTab.toolTip = "Search in files (⌘⇧F)"
        filesTab.onPress = { [weak self] in self?.setMode(.files) }
        searchTab.onPress = { [weak self] in self?.setMode(.search) }
        searchPanel.isHidden = true
        closeButton.toolTip = "Close the Files column (⌘⇧E)"
        closeButton.onPress = { [weak self] in self?.onClose() }
        count.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        count.lineBreakMode = .byTruncatingTail
        message.alignment = .center
        message.lineBreakMode = .byWordWrapping
        message.maximumNumberOfLines = 4
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: topAnchor),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: DesignTokens.Layout.tabbarHeight),
            filesTab.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 8),
            filesTab.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            searchTab.leadingAnchor.constraint(equalTo: filesTab.trailingAnchor, constant: 2),
            searchTab.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            count.leadingAnchor.constraint(equalTo: searchTab.trailingAnchor, constant: 8),
            count.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            count.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -8),
            closeButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -10),
            closeButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            barLine.topAnchor.constraint(equalTo: bar.bottomAnchor),
            barLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            barLine.trailingAnchor.constraint(equalTo: trailingAnchor),
            barLine.heightAnchor.constraint(equalToConstant: 1),
            scroll.topAnchor.constraint(equalTo: barLine.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            message.centerXAnchor.constraint(equalTo: centerXAnchor),
            message.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -20),
            message.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
            searchPanel.topAnchor.constraint(equalTo: barLine.bottomAnchor),
            searchPanel.leadingAnchor.constraint(equalTo: leadingAnchor),
            searchPanel.trailingAnchor.constraint(equalTo: trailingAnchor),
            searchPanel.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        updateTabs()
        apply()
    }

    /// Files (the tree) or Search; the hidden one stops loading.
    func setMode(_ mode: Mode) {
        guard mode != self.mode else { return }
        self.mode = mode
        updateTabs()
        searchPanel.isActive = isActive && mode == .search
        if mode == .search { searchPanel.focus() } else { reload() }
    }

    private func updateTabs() {
        filesTab.isOn = mode == .files
        searchTab.isOn = mode == .search
        searchPanel.isHidden = mode != .search
        for v in [scroll, message, count] as [NSView] { v.isHidden = mode != .files }
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func buildOutline() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .plain
        outline.rowHeight = Self.rowHeight
        outline.intercellSpacing = NSSize(width: 0, height: 0)
        outline.indentationPerLevel = 12
        outline.selectionHighlightStyle = .none
        outline.backgroundColor = .clear
        outline.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        outline.focusRingType = .none
        outline.dataSource = self
        outline.delegate = self
        outline.setAccessibilityLabel("Files")
        outline.target = self
        outline.doubleAction = #selector(activate)
        scroll.documentView = outline
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        scroll.translatesAutoresizingMaskIntoConstraints = false
    }

    // MARK: inputs

    /// The selected environment. The same one again reloads only when it became available or not.
    func show(_ env: Environment?) {
        let previous = environment
        environment = env
        searchPanel.show(env)
        guard let env else {
            generation += 1
            pendingReload?.cancel()
            setItems([], listed: nil)
            return
        }
        if previous?.id == env.id {
            if previous?.state != env.state || previous?.exists != env.exists || previous?.path != env.path {
                scheduleReload()
            }
            return
        }
        setItems([], listed: nil)
        message.stringValue = ""
        reload()
    }

    /// A `git` event, a container status change or a save: reload when it concerns this environment.
    func repoChanged(_ change: RepoChange) {
        guard let env = environment, change.concerns(env) else { return }
        scheduleReload()
    }

    /// The window went off screen or came back: no listings while it is hidden, and one when it is
    /// shown again if anything asked for one meanwhile.
    func windowVisibilityChanged(_ visible: Bool) {
        reloader.isVisible = visible
    }

    private func scheduleReload() {
        guard isActive, mode == .files else { return }
        pendingReload?.cancel()
        // the same environment: a listing already running may finish and apply
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isActive, self.mode == .files else { return }
            self.pendingReload = nil
            self.reloader.request()
        }
        pendingReload = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.debounce, execute: work)
    }

    /// The environment changed (or the column opened): a listing still running for the earlier one is
    /// not applied.
    private func reload() {
        pendingReload?.cancel()
        pendingReload = nil
        guard isActive, mode == .files, environment != nil, source != nil else { return }
        generation += 1
        if items.isEmpty { message.stringValue = "Loading files…" }
        reloader.request()
    }

    private func loadFiles() async {
        guard isActive, mode == .files, let env = environment, let source else { return }
        let gen = generation
        do {
            // the colours are extra: without a base or on a failure the tree is still listed
            async let changed: [String: FileStatus]? = try? await source.changes(env: env)
            let listing = try await source.files(env: env)
            let changes = await changed ?? [:]
            guard gen == generation else { return }
            self.changes = changes
            changedFolders = foldersWithChanges(changes)
            // the tree of a large worktree takes tens of milliseconds: built off the main thread
            let tree = await Task.detached(priority: .userInitiated) {
                FileItemTree(buildFileTree(listing.paths, directories: listing.ignoredDirectories,
                                       ignored: listing.ignored).map(FileItem.init))
            }.value
            guard gen == generation else { return }
            message.stringValue = listing.paths.isEmpty ? "No files" : ""
            setItems(tree.items, listed: env.id)
            count.stringValue = listing.truncated
                ? "first \(listing.paths.count.formatted())" : listing.paths.count.formatted()
        } catch {
            guard gen == generation else { return }
            setItems([], listed: nil)
            switch error {
            case let e as DiffError: message.stringValue = e.description
            case let e as KunjCLIError: message.stringValue = e.message
            default: message.stringValue = error.localizedDescription
            }
        }
    }

    private func setItems(_ items: [FileItem], listed id: String?) {
        self.items = items
        listedId = id
        if id == nil { count.stringValue = "" }
        restoring = true
        outline.reloadData()
        if let id, let open = expanded[id] { expandSaved(items, open) }
        restoring = false
    }

    private func expandSaved(_ items: [FileItem], _ open: Set<String>) {
        for item in items where item.node.isDirectory && open.contains(item.node.path) {
            outline.expandItem(item)
            expandSaved(item.children, open)
        }
    }

    @objc private func activate() {
        let row = outline.clickedRow >= 0 ? outline.clickedRow : outline.selectedRow
        guard row >= 0, let item = outline.item(atRow: row) as? FileItem, let env = environment else { return }
        if item.node.isDirectory {
            if outline.isItemExpanded(item) { outline.collapseItem(item) } else { outline.expandItem(item) }
        } else {
            onOpen?(env, item.node.path)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { activate() } else { super.keyDown(with: event) }
    }

    // MARK: outline

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        (item as? FileItem)?.children.count ?? items.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        (item as? FileItem)?.children[index] ?? items[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        guard let node = (item as? FileItem)?.node else { return false }
        return node.isDirectory && !node.children.isEmpty
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let item = item as? FileItem else { return nil }
        let id = NSUserInterfaceItemIdentifier("FileRow")
        let view = (outlineView.makeView(withIdentifier: id, owner: nil) as? FileRowView) ?? {
            let v = FileRowView(theme: theme)
            v.identifier = id
            return v
        }()
        view.theme = theme
        view.status = item.node.isDirectory || item.node.ignored ? nil : changes[item.node.path]
        view.holdsChanges = item.node.isDirectory && changedFolders.contains(item.node.path)
        view.node = item.node
        view.selected = outlineView.row(forItem: item) == outlineView.selectedRow
        return view
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        markSelection()
    }

    func outlineViewItemDidExpand(_ notification: Notification) { remember(notification, open: true) }
    func outlineViewItemDidCollapse(_ notification: Notification) { remember(notification, open: false) }

    private func remember(_ notification: Notification, open: Bool) {
        guard !restoring, let id = listedId,
              let item = notification.userInfo?["NSObject"] as? FileItem else { return }
        if open { expanded[id, default: []].insert(item.node.path) } else { expanded[id]?.remove(item.node.path) }
    }

    private func markSelection() {
        outline.enumerateAvailableRowViews { _, row in
            (self.outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? FileRowView)?.selected =
                row == self.outline.selectedRow
        }
    }

    private func apply() {
        bar.color = theme.color(\.bg)
        barLine.color = theme.color(\.border)
        filesTab.theme = theme
        searchTab.theme = theme
        searchPanel.theme = theme
        count.textColor = theme.color(\.faint)
        closeButton.color = theme.color(\.muted)
        closeButton.hoverFill = theme.color(\.raised)
        message.textColor = theme.color(\.muted)
        outline.reloadData()
        if let id = listedId, let open = expanded[id] {
            restoring = true
            expandSaved(items, open)
            restoring = false
        }
    }
}

/// One row of the Files column (24 px): the name in sans 12 (`text` when selected, else `text2`;
/// folders in `muted`, ignored entries in `faint`; a changed file in `green` (added) or `amber`
/// with its letter in mono 10 at the right, a folder holding changes in `amber` with a 5 px dot),
/// truncated with an ellipsis; the selected row is filled with `raised`, radius
/// 5, inset 6 px. Drawn in draw(_:) so cacheDisplay renders it.
private final class FileRowView: NSTableCellView {
    var node: FileNode? {
        didSet {
            needsDisplay = true
            toolTip = node.map { n in
                n.ignored ? "\(n.path) (ignored by git)"
                    : status.map { s in "\(n.path) (\(Self.word(s)) on this branch)" }
                    ?? (holdsChanges ? "\(n.path) (holds changes)" : n.path)
            }
            setAccessibilityLabel(node.map { n in status.map { "\(n.name), \(Self.word($0))" } ?? n.name })
        }
    }
    /// Set before `node`: the file's change on the branch
    var status: FileStatus?
    /// Set before `node`: a folder with a changed file inside
    var holdsChanges = false
    var selected = false { didSet { needsDisplay = true } }
    var theme: Theme { didSet { needsDisplay = true } }

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .row }

    override func draw(_ dirtyRect: NSRect) {
        guard let node else { return }
        if selected {
            theme.color(\.raised).setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 1), xRadius: r, yRadius: r).fill()
        }
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let changeColor: NSColor? = status.map {
            $0 == .added ? theme.color(\.green) : $0 == .deleted ? theme.color(\.red) : theme.color(\.amber)
        } ?? (holdsChanges ? theme.color(\.amber) : nil)
        let color = changeColor ?? (selected ? theme.color(\.text)
            : theme.color(node.ignored ? \.faint : node.isDirectory ? \.muted : \.text2))
        // the status letter (or a folder's dot) at the right
        var right = bounds.width - 10
        if let status, let changeColor {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: Theme.mono(10), .foregroundColor: changeColor,
            ]
            let size = (status.rawValue as NSString).size(withAttributes: attrs)
            right -= ceil(size.width)
            (status.rawValue as NSString).draw(at: NSPoint(x: right, y: (bounds.midY - size.height / 2).rounded()),
                                               withAttributes: attrs)
            right -= 6
        } else if holdsChanges, let changeColor {
            changeColor.withAlphaComponent(0.8).setFill()
            right -= 5
            NSBezierPath(ovalIn: NSRect(x: right, y: (bounds.midY - 2.5).rounded(), width: 5, height: 5)).fill()
            right -= 6
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(DesignTokens.TypeScale.small), .foregroundColor: color, .paragraphStyle: style,
        ]
        let h = ceil((node.name as NSString).size(withAttributes: attrs).height)
        (node.name as NSString).draw(
            with: NSRect(x: 6, y: (bounds.midY - h / 2).rounded(), width: max(0, right - 6), height: h),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
    }

    private static func word(_ s: FileStatus) -> String {
        switch s {
        case .added: return "added"
        case .modified: return "modified"
        case .deleted: return "deleted"
        case .renamed: return "renamed"
        }
    }
}
