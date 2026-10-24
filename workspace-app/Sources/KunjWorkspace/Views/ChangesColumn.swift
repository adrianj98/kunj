import AppKit
import KunjWorkspaceCore

/// Where the column's files and contents come from: `DiffService` in the app, `DemoChanges` for
/// `--demo`.
protocol ChangesSource: AnyObject {
    func summary(env: Environment, scope: DiffScope) async throws -> (DiffSummary, baseLabel: String)
    func contents(env: Environment, scope: DiffScope, file: ChangedFile) async throws -> (original: String, modified: String)
}

extension DiffService: ChangesSource {}

/// The right column under the header (warm.html's Changes column): the Changes bar (40 px:
/// `Changes` in sans 12.5/500, `14 files · +199 −12` in mono 11, the scope button at the right; a
/// `border` hairline under it) over the file list (196 px, `ChangedFileRowView` rows of 28 px,
/// padding 8 × 6, a hairline at its right) and Monaco's diff editor filling the rest. The first
/// file is selected on load; a reload keeps the selected path while it is still listed. It reloads
/// when the environment or the scope changes, and 500 ms after `repoChanged(root:)` for its
/// repository (the store's `onRepoChanged`). No files: `No changes` in `muted`; a `DiffError` (or
/// any failure) shows its message there instead.
final class ChangesColumn: NSView, NSTableViewDataSource, NSTableViewDelegate {
    var theme: Theme { didSet { apply() } }
    private(set) var environment: Environment?
    /// Set once kunj is discovered (or by `--demo`); the column stays empty until then.
    var source: ChangesSource? { didSet { reload() } }

    private let bar = FillView(.clear)
    private let barLine = FillView(.clear)
    private let body = FillView(.clear)
    private let listLine = FillView(.clear)
    private let title = makeLabel("Changes", font: Theme.sans(12.5, weight: .medium), color: .clear)
    private let counts = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let scopeButton: ScopeButton
    private let emptyLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let table = NSTableView()
    private let listScroll = NSScrollView()
    let diffView = MonacoWebView(mode: "diff")

    private var summary = DiffSummary(files: [])
    private var names: [String] = []
    private var selectedPath: String?
    private var message: String?
    /// The last load failed: `message` is its error and the counts are hidden.
    private var failed = false
    /// A summary of this environment arrived (the counts show only then).
    private var loaded = false
    private var scopes: [String: DiffScope] = [:]
    private var baseTitles: [String: String] = [:]
    private var summaryGeneration = 0
    private var contentGeneration = 0
    private var selecting = false
    private var pendingReload: DispatchWorkItem?

    static let debounce: TimeInterval = 0.5

    var scope: DiffScope {
        guard let id = environment?.id else { return .base }
        return scopes[id] ?? .base
    }

    init(theme: Theme) {
        self.theme = theme
        scopeButton = ScopeButton(theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        buildTable()
        for v in [bar, barLine, body] { addSubview(v) }
        for v in [title, counts, scopeButton] as [NSView] { bar.addSubview(v) }
        for v in [listScroll, listLine, diffView, emptyLabel] as [NSView] { body.addSubview(v) }
        title.setContentCompressionResistancePriority(.required, for: .horizontal)
        counts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        scopeButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        emptyLabel.alignment = .center
        emptyLabel.lineBreakMode = .byWordWrapping
        emptyLabel.maximumNumberOfLines = 4
        scopeButton.onChoose = { [weak self] s in self?.choose(s) }
        diffView.onMessage = { [weak self] m in
            // The page loaded, or reloaded after its process ended: give it the theme and the file again
            if m["type"] as? String == "ready" { self?.pageReady() }
        }
        let fileListWidth = DesignTokens.Layout.changesFileListWidth
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: topAnchor),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: DesignTokens.Layout.tabbarHeight),
            title.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            counts.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 10),
            counts.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
            counts.trailingAnchor.constraint(lessThanOrEqualTo: scopeButton.leadingAnchor, constant: -10),
            scopeButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
            scopeButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            barLine.topAnchor.constraint(equalTo: bar.bottomAnchor),
            barLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            barLine.trailingAnchor.constraint(equalTo: trailingAnchor),
            barLine.heightAnchor.constraint(equalToConstant: 1),
            body.topAnchor.constraint(equalTo: barLine.bottomAnchor),
            body.leadingAnchor.constraint(equalTo: leadingAnchor),
            body.trailingAnchor.constraint(equalTo: trailingAnchor),
            body.bottomAnchor.constraint(equalTo: bottomAnchor),

            listScroll.leadingAnchor.constraint(equalTo: body.leadingAnchor),
            listScroll.topAnchor.constraint(equalTo: body.topAnchor),
            listScroll.bottomAnchor.constraint(equalTo: body.bottomAnchor),
            listScroll.widthAnchor.constraint(equalToConstant: fileListWidth),
            listLine.leadingAnchor.constraint(equalTo: listScroll.trailingAnchor),
            listLine.topAnchor.constraint(equalTo: body.topAnchor),
            listLine.bottomAnchor.constraint(equalTo: body.bottomAnchor),
            listLine.widthAnchor.constraint(equalToConstant: 1),
            diffView.leadingAnchor.constraint(equalTo: listLine.trailingAnchor),
            diffView.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            diffView.topAnchor.constraint(equalTo: body.topAnchor),
            diffView.bottomAnchor.constraint(equalTo: body.bottomAnchor),

            emptyLabel.centerXAnchor.constraint(equalTo: body.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: body.centerYAnchor, constant: -20),
            emptyLabel.leadingAnchor.constraint(greaterThanOrEqualTo: body.leadingAnchor, constant: 24),
            emptyLabel.trailingAnchor.constraint(lessThanOrEqualTo: body.trailingAnchor, constant: -24),
        ])
        apply()
        render()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func buildTable() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.rowHeight = ChangedFileRowView.height
        table.intercellSpacing = NSSize(width: 0, height: 1)
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.focusRingType = .none
        table.allowsEmptySelection = true
        table.dataSource = self
        table.delegate = self
        table.setAccessibilityLabel("Changed files")
        listScroll.documentView = table
        listScroll.drawsBackground = false
        listScroll.hasVerticalScroller = true
        listScroll.autohidesScrollers = true
        listScroll.scrollerStyle = .overlay
        listScroll.automaticallyAdjustsContentInsets = false
        listScroll.contentInsets = NSEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        listScroll.translatesAutoresizingMaskIntoConstraints = false
    }

    // MARK: inputs

    /// The selected environment (nil: nothing selected). The same environment again reloads only
    /// when it became available or unavailable (a container started, a worktree came back).
    func show(_ env: Environment?) {
        let previous = environment
        environment = env
        guard let env else {
            summaryGeneration += 1
            pendingReload?.cancel()
            return
        }
        if previous?.id == env.id {
            if previous?.state != env.state || previous?.exists != env.exists || previous?.path != env.path {
                scheduleReload()
            }
            return
        }
        summary = DiffSummary(files: [])
        names = []
        selectedPath = nil
        message = nil
        failed = false
        loaded = false
        table.reloadData()
        render()
        Task { await self.diffView.call("clear") }
        reload()
    }

    /// A `git` event (or a container status change) in the repository at `root`: reload after 500 ms
    /// when it is this environment's repository.
    func repoChanged(root: String) {
        guard environment?.repo.root == root else { return }
        scheduleReload()
    }

    private func scheduleReload() {
        pendingReload?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.reload() }
        pendingReload = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.debounce, execute: work)
    }

    private func choose(_ s: DiffScope) {
        guard let env = environment, s != scope else { return }
        scopes[env.id] = s
        render()
        reload()
    }

    // MARK: loading

    private func reload() {
        pendingReload?.cancel()
        pendingReload = nil
        guard let env = environment, let source else { return }
        summaryGeneration += 1
        let generation = summaryGeneration
        let scope = self.scope
        Task { @MainActor in
            do {
                let (s, label) = try await source.summary(env: env, scope: scope)
                guard generation == self.summaryGeneration else { return }
                if scope == .base { self.baseTitles[env.id] = label }
                self.applySummary(s)
            } catch {
                guard generation == self.summaryGeneration else { return }
                self.showFailure(error)
            }
        }
    }

    private func applySummary(_ s: DiffSummary) {
        summary = s
        names = changedFileDisplayNames(s.files)
        message = s.files.isEmpty ? "No changes" : nil
        failed = false
        loaded = true
        selecting = true
        table.reloadData()
        if let i = selectedIndexAfterRefresh(previous: selectedPath, files: s.files) {
            table.selectRowIndexes(IndexSet(integer: i), byExtendingSelection: false)
            selectedPath = s.files[i].path
        } else {
            table.deselectAll(nil)
            selectedPath = nil
        }
        selecting = false
        render()
        loadSelected()
    }

    private func showFailure(_ error: Error) {
        let text: String
        switch error {
        case let e as DiffError: text = e.description
        case let e as KunjCLIError: text = e.message
        case let e as FileAccessError: text = e == .notFound ? "The file is gone" : "That path cannot be read"
        default: text = error.localizedDescription
        }
        summary = DiffSummary(files: [])
        names = []
        message = text
        failed = true
        table.reloadData()
        render()
        Task { await self.diffView.call("clear") }
    }

    /// Shows the selected file's two sides in the diff (refetched on every reload: the file may
    /// have changed under the same path).
    private func loadSelected() {
        contentGeneration += 1
        let generation = contentGeneration
        let row = table.selectedRow
        guard let env = environment, let source, row >= 0, row < summary.files.count else {
            Task { await self.diffView.call("clear") }
            return
        }
        let file = summary.files[row]
        let scope = self.scope
        Task { @MainActor in
            do {
                let (original, modified) = try await source.contents(env: env, scope: scope, file: file)
                guard generation == self.contentGeneration else { return }
                await self.diffView.call("showDiff", ["original": original, "modified": modified,
                                                      "language": "", "path": file.path])
            } catch {
                guard generation == self.contentGeneration else { return }
                log("diff contents of \(file.path) failed: \(error)")
                await self.diffView.call("clear")
            }
        }
    }

    private func pageReady() {
        Task {
            await diffView.call("setTheme", ["tokens": MonacoWebView.tokens(theme)])
        }
        if table.selectedRow >= 0 { loadSelected() }
    }

    // MARK: rendering

    private func render() {
        let hasFiles = !summary.files.isEmpty
        listScroll.isHidden = !hasFiles
        listLine.isHidden = !hasFiles
        diffView.isHidden = !hasFiles
        emptyLabel.isHidden = hasFiles || message == nil
        emptyLabel.stringValue = message ?? ""
        counts.isHidden = failed || !loaded
        counts.attributedStringValue = countsText()
        scopeButton.items = DiffScope.allCases.map { s in
            (s, s == .base ? (environment.flatMap { baseTitles[$0.id] } ?? s.label) : s.label)
        }
        scopeButton.selected = scope
    }

    private func countsText() -> NSAttributedString {
        let font = Theme.mono(DesignTokens.TypeScale.caption)
        let out = NSMutableAttributedString(
            string: changesCountLabel(summary.files.count),
            attributes: [.font: font, .foregroundColor: theme.color(\.muted)])
        guard !summary.files.isEmpty else { return out }
        out.append(NSAttributedString(string: " · ", attributes: [.font: font, .foregroundColor: theme.color(\.muted)]))
        out.append(NSAttributedString(string: "+\(summary.added)", attributes: [.font: font, .foregroundColor: theme.color(\.green)]))
        out.append(NSAttributedString(string: " ", attributes: [.font: font]))
        out.append(NSAttributedString(string: "−\(summary.deleted)", attributes: [.font: font, .foregroundColor: theme.color(\.red)]))
        return out
    }

    private func apply() {
        bar.color = theme.color(\.bg)
        barLine.color = theme.color(\.border)
        listLine.color = theme.color(\.border)
        body.color = theme.color(\.bg)
        title.textColor = theme.color(\.text)
        emptyLabel.textColor = theme.color(\.muted)
        scopeButton.theme = theme
        table.reloadData()
        restoreSelectionMarks()
        render()
        Task { await diffView.call("setTheme", ["tokens": MonacoWebView.tokens(theme)]) }
    }

    private func restoreSelectionMarks() {
        table.enumerateAvailableRowViews { _, row in
            (self.table.view(atColumn: 0, row: row, makeIfNecessary: false) as? ChangedFileRowView)?.selected =
                row == self.table.selectedRow
        }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { summary.files.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("ChangedFileRow")
        let view = (tableView.makeView(withIdentifier: id, owner: nil) as? ChangedFileRowView) ?? {
            let v = ChangedFileRowView(theme: theme)
            v.identifier = id
            return v
        }()
        view.theme = theme
        view.file = summary.files[row]
        view.displayName = names.indices.contains(row) ? names[row] : summary.files[row].path
        view.selected = row == tableView.selectedRow
        return view
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        restoreSelectionMarks()
        guard !selecting else { return }
        let row = table.selectedRow
        selectedPath = summary.files.indices.contains(row) ? summary.files[row].path : nil
        loadSelected()
    }

    // MARK: snapshots

    /// The diff page as an image and its frame in `view`'s coordinates (for --screenshot, which
    /// cannot draw a WKWebView through cacheDisplay); nil when it is hidden.
    func snapshotOverlay(in view: NSView, completion: @escaping ((NSRect, NSImage)?) -> Void) {
        guard !diffView.isHidden, !isHidden else { completion(nil); return }
        let frame = diffView.convert(diffView.bounds, to: view)
        diffView.snapshot { image in completion(image.map { (frame, $0) }) }
    }
}

/// The diff scope select (warm.html's `<select>`): 24 px, `raised2` fill, `borderStrong` 1 px,
/// radius 5, the title in sans 11.5 `text2` and a chevron; a click opens a menu of the scopes.
final class ScopeButton: NSButton {
    var theme: Theme { didSet { needsDisplay = true } }
    var items: [(DiffScope, String)] = [] { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var selected: DiffScope = .base { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var onChoose: ((DiffScope) -> Void)?
    private let titleFont = Theme.sans(11.5)

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        title = ""
        isBordered = false
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(pressed)
        setAccessibilityLabel("Diff scope")
        setAccessibilityRole(.popUpButton)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private var currentTitle: String { items.first { $0.0 == selected }?.1 ?? selected.label }
    override func accessibilityValue() -> Any? { currentTitle }

    override var intrinsicContentSize: NSSize {
        let w = ceil((currentTitle as NSString).size(withAttributes: [.font: titleFont]).width)
        return NSSize(width: 8 + w + 8 + 8 + 7, height: 24)
    }

    @objc private func pressed() {
        let menu = NSMenu()
        for (scope, label) in items {
            let item = NSMenuItem(title: label, action: #selector(chose(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = scope.rawValue
            item.state = scope == selected ? .on : .off
            menu.addItem(item)
        }
        let selectedItem = menu.items.first { $0.state == .on }
        menu.popUp(positioning: selectedItem, at: NSPoint(x: 0, y: bounds.height - 2), in: self)
    }

    @objc private func chose(_ item: NSMenuItem) {
        guard let raw = item.representedObject as? String, let scope = DiffScope(rawValue: raw) else { return }
        onChoose?(scope)
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = DesignTokens.Radius.control
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: r, yRadius: r)
        theme.color(isHighlighted ? \.raised : \.raised2).setFill()
        path.fill()
        theme.color(\.borderStrong).setStroke()
        path.lineWidth = 1
        path.stroke()
        let attrs: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: theme.color(\.text2)]
        let size = (currentTitle as NSString).size(withAttributes: attrs)
        (currentTitle as NSString).draw(at: NSPoint(x: 8, y: (bounds.midY - size.height / 2).rounded()), withAttributes: attrs)
        // Chevron, 7 × 4, 8 px from the right edge
        let cx = bounds.maxX - 8 - 3.5, cy = bounds.midY
        let chevron = NSBezierPath()
        chevron.move(to: NSPoint(x: cx - 3.5, y: cy - 1.5))
        chevron.line(to: NSPoint(x: cx, y: cy + 2))
        chevron.line(to: NSPoint(x: cx + 3.5, y: cy - 1.5))
        chevron.lineWidth = 1.4
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        theme.color(\.text2).setStroke()
        chevron.stroke()
    }
}
