import AppKit
import KunjWorkspaceCore

/// Where the Files column's listing comes from: `FileLister` in the app, `DemoFiles` for `--demo`.
protocol FilesSource: AnyObject {
    func files(env: Environment) async throws -> FileLister.Listing
}

final class FileListerSource: FilesSource {
    let lister: FileLister
    init(cli: KunjCLI) { lister = FileLister(cli: cli) }
    func files(env: Environment) async throws -> FileLister.Listing { try await lister.list(env: env) }
}

/// A node of the outline view (it needs objects, and the same object for the same item across
/// `reloadData`, so folders keep their open state).
private final class FileItem: NSObject {
    let node: FileNode
    let children: [FileItem]
    init(_ node: FileNode) {
        self.node = node
        children = node.children.map(FileItem.init)
    }
}

/// The file explorer at the window's right edge (opened with the tab bar's Files pill or View >
/// Show Files ⌘⇧E; closed by default): the Files bar (40 px like the Changes bar: `Files` in sans
/// 12.5/500, the count in mono 11 `faint`, a `border` hairline under it) over the environment's
/// files as a tree (tracked, untracked and ignored, see `FileLister`; folders first; ignored ones in
/// `faint`, an ignored folder without its contents). A
/// double-click (or Return) on a file opens it in an editor tab; on a folder opens or closes it.
/// Open folders are kept per environment. It reloads when the environment changes and 1 s after a
/// `git` event of its repository; closed, it lists nothing.
final class FilesColumn: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate {
    var theme: Theme { didSet { apply() } }
    private(set) var environment: Environment?
    /// Set once kunj is discovered (or by `--demo`).
    var source: FilesSource? { didSet { reload() } }
    var isActive = false {
        didSet {
            guard isActive != oldValue else { return }
            if isActive { reload() } else { pendingReload?.cancel(); pendingReload = nil; generation += 1 }
        }
    }
    /// A file was opened (double-click or Return): show it in an editor tab.
    var onOpen: ((Environment, String) -> Void)?
    /// The × at the bar's right: close the column.
    var onClose: () -> Void = {}
    private let closeButton = BarIconButton(.close, label: "Close Files")

    static let width: CGFloat = 260
    static let rowHeight: CGFloat = 24
    static let debounce: TimeInterval = 1

    private let bar = FillView(.clear)
    private let barLine = FillView(.clear)
    private let title = makeLabel("Files", font: Theme.sans(12.5, weight: .medium), color: .clear)
    private let count = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let message = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let outline = NSOutlineView()
    private let scroll = NSScrollView()

    private var items: [FileItem] = []
    private var listedId: String?
    private var expanded: [String: Set<String>] = [:]
    private var restoring = false
    private var generation = 0
    private var pendingReload: DispatchWorkItem?

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        buildOutline()
        for v in [bar, barLine, scroll, message] as [NSView] { addSubview(v) }
        for v in [title, count, closeButton] as [NSView] { bar.addSubview(v) }
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
            title.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            count.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 10),
            count.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
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
        ])
        apply()
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

    /// A `git` event (or a container status change) in the repository at `root`.
    func repoChanged(root: String) {
        guard environment?.repo.root == root else { return }
        scheduleReload()
    }

    private func scheduleReload() {
        guard isActive else { return }
        pendingReload?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.reload() }
        pendingReload = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.debounce, execute: work)
    }

    private func reload() {
        pendingReload?.cancel()
        pendingReload = nil
        guard isActive, let env = environment, let source else { return }
        generation += 1
        let gen = generation
        if items.isEmpty { message.stringValue = "Loading files…" }
        Task { @MainActor in
            do {
                let listing = try await source.files(env: env)
                guard gen == self.generation else { return }
                self.message.stringValue = listing.paths.isEmpty ? "No files" : ""
                self.setItems(buildFileTree(listing.paths, directories: listing.ignoredDirectories,
                                            ignored: listing.ignored).map(FileItem.init), listed: env.id)
                self.count.stringValue = listing.truncated
                    ? "first \(listing.paths.count.formatted())" : listing.paths.count.formatted()
            } catch {
                guard gen == self.generation else { return }
                self.setItems([], listed: nil)
                switch error {
                case let e as DiffError: self.message.stringValue = e.description
                case let e as KunjCLIError: self.message.stringValue = e.message
                default: self.message.stringValue = error.localizedDescription
                }
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
        title.textColor = theme.color(\.text)
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
/// folders in `muted`, ignored entries in `faint`), truncated with an ellipsis; the selected row is filled with `raised`, radius
/// 5, inset 6 px. Drawn in draw(_:) so cacheDisplay renders it.
private final class FileRowView: NSTableCellView {
    var node: FileNode? { didSet { needsDisplay = true; toolTip = node.map { $0.ignored ? "\($0.path) (ignored by git)" : $0.path }; setAccessibilityLabel(node?.name) } }
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
        let color = selected ? theme.color(\.text)
            : theme.color(node.ignored ? \.faint : node.isDirectory ? \.muted : \.text2)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Theme.sans(DesignTokens.TypeScale.small), .foregroundColor: color, .paragraphStyle: style,
        ]
        let h = ceil((node.name as NSString).size(withAttributes: attrs).height)
        (node.name as NSString).draw(
            with: NSRect(x: 6, y: (bounds.midY - h / 2).rounded(), width: max(0, bounds.width - 12), height: h),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
    }
}
