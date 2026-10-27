import AppKit
import KunjWorkspaceCore

/// Runs a search: `kunj search --json` in the app, nothing in `--demo`.
protocol SearchSource: AnyObject {
    func search(_ query: SearchQuery, env: Environment) async throws -> SearchJson
}

final class KunjSearchSource: SearchSource {
    let cli: KunjCLI
    init(cli: KunjCLI) { self.cli = cli }
    func search(_ query: SearchQuery, env: Environment) async throws -> SearchJson {
        try await cli.run(searchArguments(query, env: env), cwd: env.repo.root)
    }
}

/// A node of the outline view; the same object for the same key across a reload keeps groups open.
private final class SearchItem: NSObject {
    let node: SearchNode
    let children: [SearchItem]
    init(_ node: SearchNode) {
        self.node = node
        children = node.children.map(SearchItem.init)
    }
}

/// The Files column's Search mode (⌘⇧F): a query field, the options (`Aa` match case, `W` whole
/// words, `.*` regex) and the scope (`This worktree`/`This container` by default, `All worktrees`,
/// `Worktrees & containers`, see `SearchScope`) over the summary and the results: files with their
/// matching lines (under one row per environment when several were searched), the match on each
/// line on a `raised2` fill. A click on a match (or Return) opens it in an editor tab at the line,
/// in its environment. It searches 400 ms after typing stops (at least 2 characters), at once on
/// Return, and again when the options, the scope or the environment change.
final class SearchPanel: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate {
    var theme: Theme { didSet { apply() } }
    var source: SearchSource?
    /// A match was chosen: open it.
    var onOpen: ((SearchTarget, Environment) -> Void)?
    /// Opens the first match of the next result as a click would (the `-searchOpen` launch argument)
    var openFirstMatch = false
    /// Esc on an empty field.
    var onEscape: (() -> Void)?
    private(set) var environment: Environment?
    /// Searches only while the column shows this panel.
    var isActive = false { didSet { if isActive && !oldValue && needsSearch { run() } } }

    static let debounce: TimeInterval = 0.4
    static let minimumLength = 2

    let field: SearchField
    private let caseButton = HeaderTextButton("Aa")
    private let wordButton = HeaderTextButton("W")
    private let regexButton = HeaderTextButton(".*")
    private let scopeButton = HeaderTextButton("This worktree ▾")
    private let summary = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let message = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let outline = NSOutlineView()
    private let scroll = NSScrollView()
    private var scopeWidth: NSLayoutConstraint!

    private var query = SearchQuery(text: "")
    private var items: [SearchItem] = []
    private var generation = 0
    private var pending: DispatchWorkItem?
    /// The query, options, scope or environment changed while the panel was hidden.
    private var needsSearch = false

    init(theme: Theme) {
        self.theme = theme
        field = SearchField(placeholder: "Search", badge: "⌘⇧F", theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        buildOutline()
        field.translatesAutoresizingMaskIntoConstraints = false
        field.onChange = { [weak self] text in self?.textChanged(text) }
        field.onEscape = { [weak self] in self?.onEscape?() }
        field.onSubmit = { [weak self] in self?.run() }
        caseButton.toolTip = "Match case"
        wordButton.toolTip = "Whole words"
        regexButton.toolTip = "Regular expression"
        scopeButton.toolTip = "Where to search"
        caseButton.onPress = { [weak self] in self?.toggle(\.ignoreCase) }
        wordButton.onPress = { [weak self] in self?.toggle(\.word) }
        regexButton.onPress = { [weak self] in self?.toggle(\.regex) }
        scopeButton.onPress = { [weak self] in self?.showScopeMenu() }
        summary.lineBreakMode = .byTruncatingTail
        summary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        message.alignment = .center
        message.lineBreakMode = .byWordWrapping
        message.maximumNumberOfLines = 4
        for v in [field, caseButton, wordButton, regexButton, scopeButton, summary, scroll, message] as [NSView] {
            addSubview(v)
        }
        scopeWidth = scopeButton.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            caseButton.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 6),
            caseButton.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            wordButton.centerYAnchor.constraint(equalTo: caseButton.centerYAnchor),
            wordButton.leadingAnchor.constraint(equalTo: caseButton.trailingAnchor, constant: 2),
            regexButton.centerYAnchor.constraint(equalTo: caseButton.centerYAnchor),
            regexButton.leadingAnchor.constraint(equalTo: wordButton.trailingAnchor, constant: 2),
            scopeButton.centerYAnchor.constraint(equalTo: caseButton.centerYAnchor),
            scopeButton.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            scopeButton.leadingAnchor.constraint(greaterThanOrEqualTo: regexButton.trailingAnchor, constant: 6),
            scopeWidth,
            summary.topAnchor.constraint(equalTo: caseButton.bottomAnchor, constant: 8),
            summary.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            summary.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: summary.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            message.centerXAnchor.constraint(equalTo: centerXAnchor),
            message.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -20),
            message.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        updateControls()
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func buildOutline() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("match"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .plain
        outline.rowHeight = 22
        outline.intercellSpacing = NSSize(width: 0, height: 0)
        outline.indentationPerLevel = 12
        outline.selectionHighlightStyle = .none
        outline.backgroundColor = .clear
        outline.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        outline.focusRingType = .none
        outline.dataSource = self
        outline.delegate = self
        outline.setAccessibilityLabel("Search results")
        outline.target = self
        outline.action = #selector(clicked)
        scroll.documentView = outline
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 2, left: 0, bottom: 6, right: 0)
        scroll.translatesAutoresizingMaskIntoConstraints = false
    }

    // MARK: inputs

    func focus() {
        field.focus()
        field.field.currentEditor()?.selectAll(nil)
    }

    /// Puts `text` in the field and searches it now (in `scope`).
    func search(_ text: String, scope: SearchScope = .environment) {
        field.field.stringValue = text
        query.text = text
        query.scope = scope
        updateControls()
        run()
    }

    /// The selected environment. With the default scope a new one is searched again; the wider
    /// scopes cover the repository, so only a change of repository does.
    func show(_ env: Environment?) {
        let previous = environment
        environment = env
        updateControls()
        guard let env else { clear(""); return }
        if previous?.id == env.id { return }
        if query.scope == .environment || previous?.repo.root != env.repo.root { searchSoon(delay: 0) }
    }

    private func textChanged(_ text: String) {
        query.text = text
        if text.trimmingCharacters(in: .whitespaces).count < Self.minimumLength {
            clear("")
            return
        }
        searchSoon(delay: Self.debounce)
    }

    private func toggle(_ option: WritableKeyPath<SearchQuery, Bool>) {
        query[keyPath: option].toggle()
        updateControls()
        searchSoon(delay: 0)
    }

    private func showScopeMenu() {
        let menu = NSMenu()
        for scope in SearchScope.allCases {
            let item = NSMenuItem(title: scope.title(for: environment?.kind), action: #selector(chooseScope(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = scope.rawValue
            item.state = scope == query.scope ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: scopeButton.bounds.maxY + 4), in: scopeButton)
    }

    @objc private func chooseScope(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let scope = SearchScope(rawValue: raw),
              scope != query.scope else { return }
        query.scope = scope
        updateControls()
        searchSoon(delay: 0)
    }

    private func updateControls() {
        caseButton.isOn = !query.ignoreCase
        wordButton.isOn = query.word
        regexButton.isOn = query.regex
        let title = query.scope.title(for: environment?.kind) + " ▾"
        scopeButton.setAccessibilityLabel(title)
        scopeButton.label = title
        scopeWidth.constant = scopeButton.intrinsicContentSize.width
    }

    // MARK: searching

    private func searchSoon(delay: TimeInterval) {
        pending?.cancel()
        pending = nil
        guard query.text.trimmingCharacters(in: .whitespaces).count >= Self.minimumLength else { return }
        guard isActive else { needsSearch = true; return }
        let work = DispatchWorkItem { [weak self] in self?.run() }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func run() {
        pending?.cancel()
        pending = nil
        needsSearch = false
        guard let env = environment, !query.text.isEmpty else { return }
        guard let source else {
            clear("Search runs kunj search, which is not available here")
            return
        }
        generation += 1
        let gen = generation
        let q = query
        summary.stringValue = "Searching…"
        Task { @MainActor in
            do {
                let result = try await source.search(q, env: env)
                guard gen == self.generation else { return }
                self.show(result, grouped: q.scope != .environment)
            } catch {
                guard gen == self.generation else { return }
                log("search: \(error)")
                self.clear(searchFailureMessage(error))
            }
        }
    }

    private func clear(_ text: String) {
        generation += 1
        pending?.cancel()
        pending = nil
        summary.stringValue = ""
        message.stringValue = text
        setItems([])
    }

    private func show(_ result: SearchJson, grouped: Bool) {
        let tree = searchTree(result, grouped: grouped)
        summary.stringValue = searchSummary(result)
        message.stringValue = tree.isEmpty ? "No matches" : ""
        setItems(tree.map(SearchItem.init))
        // everything open: a result is read, not browsed
        for item in items { outline.expandItem(item, expandChildren: true) }
        // only this result: one without matches must not open a later search's
        let open = openFirstMatch
        openFirstMatch = false
        if open, let row = (0..<outline.numberOfRows).first(where: {
            if case .match = (outline.item(atRow: $0) as? SearchItem)?.node.kind { return true } else { return false }
        }) {
            outline.selectRowIndexes([row], byExtendingSelection: false)
            clicked()
        }
    }

    private func setItems(_ items: [SearchItem]) {
        self.items = items
        outline.reloadData()
    }

    @objc private func clicked() {
        let row = outline.clickedRow >= 0 ? outline.clickedRow : outline.selectedRow
        guard row >= 0, let item = outline.item(atRow: row) as? SearchItem else { return }
        switch item.node.kind {
        case .match:
            if let target = item.node.target, let env = environment { onOpen?(target, env) }
        case .file, .source:
            if outline.isItemExpanded(item) { outline.collapseItem(item) } else { outline.expandItem(item) }
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { clicked() } else { super.keyDown(with: event) }
    }

    // MARK: outline

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        (item as? SearchItem)?.children.count ?? items.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        (item as? SearchItem)?.children[index] ?? items[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        !((item as? SearchItem)?.children.isEmpty ?? true)
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let item = item as? SearchItem else { return nil }
        let id = NSUserInterfaceItemIdentifier("SearchRow")
        let view = (outlineView.makeView(withIdentifier: id, owner: nil) as? SearchRowView) ?? {
            let v = SearchRowView(theme: theme)
            v.identifier = id
            return v
        }()
        view.theme = theme
        view.node = item.node
        view.selected = outlineView.row(forItem: item) == outlineView.selectedRow
        return view
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        outline.enumerateAvailableRowViews { _, row in
            (self.outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? SearchRowView)?.selected =
                row == self.outline.selectedRow
        }
    }

    private func apply() {
        field.theme = theme
        for b in [caseButton, wordButton, regexButton, scopeButton] { b.theme = theme }
        summary.textColor = theme.color(\.faint)
        message.textColor = theme.color(\.muted)
        outline.reloadData()
        for item in items { outline.expandItem(item, expandChildren: true) }
    }
}

/// One row of the results (22 px), drawn in draw(_:) so cacheDisplay renders it. A source: the
/// branch in sans 12/500 `text` and its kind (or error, in `red`) in `faint`. A file: its name in
/// `text2`, its folder and match count in `faint`. A match: the line number in mono 11 `faint`, then
/// the line in mono 11.5 `text2` (leading spaces dropped), the match on a `raised2` fill in `text`.
/// The selected row is filled with `raised`, radius 5.
private final class SearchRowView: NSTableCellView {
    var node: SearchNode? { didSet { needsDisplay = true; describe() } }
    var selected = false { didSet { needsDisplay = true } }
    var theme: Theme { didSet { needsDisplay = true } }

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .row }

    private func describe() {
        guard let node else { return }
        switch node.kind {
        case let .source(branch, _, detail, _):
            setAccessibilityLabel("\(branch), \(detail)")
            toolTip = detail
        case let .file(path, count, _):
            setAccessibilityLabel("\(path), \(count) \(count == 1 ? "match" : "matches")")
            toolTip = path
        case let .match(m):
            setAccessibilityLabel("Line \(m.line): \(m.text)")
            toolTip = m.text
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let node else { return }
        if selected {
            theme.color(\.raised).setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 1), xRadius: r, yRadius: r).fill()
        }
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let text = NSMutableAttributedString()
        func add(_ s: String, _ font: NSFont, _ color: KeyPath<ThemeTokens, String>, background: NSColor? = nil) {
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: theme.color(color)]
            if let background { attrs[.backgroundColor] = background }
            text.append(NSAttributedString(string: s, attributes: attrs))
        }
        switch node.kind {
        case let .source(branch, _, detail, failed):
            add(branch, Theme.sans(DesignTokens.TypeScale.small, weight: .medium), \.text)
            add("  " + detail, Theme.sans(DesignTokens.TypeScale.caption), failed ? \.red : \.faint)
        case let .file(path, count, truncated):
            let name = (path as NSString).lastPathComponent
            let dir = (path as NSString).deletingLastPathComponent
            add(name, Theme.sans(DesignTokens.TypeScale.small), \.text2)
            if !dir.isEmpty { add("  " + dir, Theme.sans(DesignTokens.TypeScale.caption), \.faint) }
            add("  \(count)\(truncated ? "+" : "")", Theme.mono(DesignTokens.TypeScale.caption), \.faint)
        case let .match(m):
            add("\(m.line)  ", Theme.mono(DesignTokens.TypeScale.caption), \.faint)
            appendLine(m, to: text)
        }
        text.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: text.length))
        let h = ceil(text.size().height)
        text.draw(with: NSRect(x: 4, y: (bounds.midY - h / 2).rounded(), width: max(0, bounds.width - 10), height: h),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    /// The line without its indentation, the match highlighted (columns are characters, 1-based).
    private func appendLine(_ m: SearchMatch, to text: NSMutableAttributedString) {
        let chars = Array(m.text)
        let indent = chars.prefix { $0 == " " || $0 == "\t" }.count
        let start = max(0, m.column - 1 - indent)
        let body = Array(chars.dropFirst(indent))
        let font = Theme.mono(DesignTokens.TypeScale.monoDiff)
        let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: theme.color(\.text2)]
        let hit: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: theme.color(\.text),
                                                  .backgroundColor: theme.color(\.raised2)]
        guard m.length > 0, start < body.count else {
            text.append(NSAttributedString(string: String(body), attributes: plain))
            return
        }
        let end = min(body.count, start + m.length)
        // keep the match in view: drop the start of a long line
        let from = start > 24 ? start - 12 : 0
        if from > 0 { text.append(NSAttributedString(string: "…", attributes: plain)) }
        text.append(NSAttributedString(string: String(body[from..<start]), attributes: plain))
        text.append(NSAttributedString(string: String(body[start..<end]), attributes: hit))
        text.append(NSAttributedString(string: String(body[end...]), attributes: plain))
    }
}
