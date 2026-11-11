import AppKit
import KunjWorkspaceCore

/// A document view laid out from the top.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// One entry of the Settings window's category list.
private final class CategoryItem: NSView {
    let id: String
    var onClick: () -> Void = {}
    var selected = false { didSet { needsDisplay = true; render() } }
    private let label: NSTextField

    init(id: String, title: String) {
        self.id = id
        label = makeLabel(title, font: Theme.sans(DesignTokens.TypeScale.body), color: .clear)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 26),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        render()
    }
    required init?(coder: NSCoder) { fatalError() }

    func render() {
        let t = ThemeManager.shared.current
        label.textColor = selected ? t.color(\.text) : t.color(\.text2)
        label.font = Theme.sans(DesignTokens.TypeScale.body, weight: selected ? .medium : .regular)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard selected else { return }
        ThemeManager.shared.current.color(\.raised2).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    }

    override func mouseDown(with event: NSEvent) { onClick() }
    override func accessibilityPerformPress() -> Bool { onClick(); return true }
}

/// Settings (⌘,): every kunj setting and the app's own (docs/specs/workspace-settings.md).
///
/// The left list is "App" (`AppSettingsPane`: UserDefaults, applied at once) and then the
/// categories of `kunj config --schema --json`, fetched once per CLI. The right pane shows the
/// chosen category's rows (`SettingsModel`, `SettingRowView`) for the scope in the popup: the
/// global config, or one repository's (`kunj config --list --json` run in the home directory or
/// the repository root). A change is written with `kunj config --set-json <key>=<json>` and Reset
/// with `--unset`, one at a time; a refused write puts the control back and shows kunj's message
/// under the row. Containers also shows the token block (`ContainerTokensView`). Search filters
/// the rows of every category. A kunj without `--schema` leaves only App.
@MainActor
final class SettingsWindow: NSWindowController, NSWindowDelegate, NSSearchFieldDelegate {
    static let kunjCommandKey = "kunjCommand"
    /// The category shown when the window was last used.
    static let categoryKey = "settingsCategory"
    static let appCategory = "app"

    /// The kunj command changed (after editing ends): rediscover kunj with it.
    var onKunjCommandChanged: () -> Void = {}
    /// A view toggle in the App pane: (UserDefaults key, on).
    var onViewPreference: (String, Bool) -> Void = { _, _ in }
    /// The CLI (nil until discovery: only App is usable).
    var cli: KunjCLI? {
        didSet {
            guard cli !== oldValue else { return }
            tokens.cli = cli
            schema = nil
            schemaError = nil
            model = nil
            if window?.isVisible == true { reload() }
        }
    }
    /// The main window's selected environment (where the token Set Up… opens its action tab).
    var selectedEnvironment: () -> Environment? = { nil }
    /// Opens an action tab running `spec` in `env`; `onFinish` gets the exit code.
    var openAction: (Environment, TerminalSpec, @escaping (Int32) -> Void) -> Void = { _, _, _ in }
    /// The repositories the scope popup offers.
    var repositories: () -> [(root: String, name: String)] = { [] }

    private let content = FillView(.clear)
    private let sidebar = FillView(.clear)
    private let topLine = FillView(.clear)
    private let sideLine = FillView(.clear)
    private let searchField = NSSearchField()
    private let scopeLabel = makeLabel("Scope", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let scopePopup = NSPopUpButton()
    private let categoryStack = NSStackView()
    private let sidebarNote = NSTextField(wrappingLabelWithString: "")
    private let paneScroll = NSScrollView()
    private let paneDocument = FlippedView()
    private let paneStack = NSStackView()
    private let appPane = AppSettingsPane()
    private let tokens = ContainerTokensView()

    private var category = SettingsWindow.appCategory
    private var scope = SettingsScope.global
    private var scopes: [SettingsScope] = [.global]
    private var schema: ConfigSchemaJson?
    /// Why the schema could not be read; `unsupported` when kunj is older than `--schema`.
    private var schemaError: (message: String, unsupported: Bool)?
    private var model: SettingsModel?
    private var listError: String?
    private var loading = false
    /// Bumped by every load: a reply for an older one is dropped.
    private var generation = 0
    private var categoryItems: [CategoryItem] = []
    private var rowViews: [String: SettingRowView] = [:]
    private var headings: [NSTextField] = []
    private var messages: [NSTextField] = []
    /// Writes waiting their turn (`value` nil is an unset), with the scope they were made in.
    private var queue: [(key: String, value: JSONValue?, scope: SettingsScope)] = []
    private var draining = false

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 540),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: true)
        window.title = "Settings"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 420)
        super.init(window: window)
        window.delegate = self
        category = UserDefaults.standard.string(forKey: Self.categoryKey) ?? Self.appCategory
        build(window)
        window.center()
        window.setFrameAutosaveName("Settings")
        appPane.onKunjCommandChanged = { [weak self] in self?.onKunjCommandChanged() }
        appPane.onViewPreference = { [weak self] key, on in self?.onViewPreference(key, on) }
        tokens.selectedEnvironment = { [weak self] in self?.selectedEnvironment() }
        tokens.openAction = { [weak self] env, spec, done in self?.openAction(env, spec, done) }
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        let wasVisible = window?.isVisible == true
        super.showWindow(sender)
        guard !wasVisible else { return }
        // each opening starts on the global config: the safest place for a change to land
        scope = .global
        model = nil
        searchField.stringValue = ""
        rebuildScopes()
        appPane.refresh()
        tokens.reload()
        renderAll()
        reload()
    }

    /// Shows a category (`app`, or a schema category id); used by `--settings <category>`.
    func select(category id: String) {
        category = id
        UserDefaults.standard.set(id, forKey: Self.categoryKey)
        searchField.stringValue = ""
        renderAll()
    }

    /// The window's content as a PNG (`--settings <category> --screenshot`).
    func snapshotPNG() -> Data? {
        guard let root = window?.contentView else { return nil }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).representation(using: .png, properties: [:])
    }

    /// `-settingsSet "<key>=<json>"` / `-settingsReset <key>` / `-settingsScope <repository name>`:
    /// what clicking would do, through the row on screen, to check a write without a person at
    /// the keyboard (like `-openTabs`). False when the row or the scope is not there.
    @discardableResult
    func perform(set assignment: String? = nil, reset key: String? = nil, scope name: String? = nil) -> Bool {
        if let name {
            guard let found = scopes.first(where: { if case .repo(_, name) = $0 { return true } else { return false } }) else { return false }
            setScope(found)
            return true
        }
        if let key {
            guard let view = rowViews[key] else { return false }
            view.onReset()
            return true
        }
        guard let assignment, let at = assignment.firstIndex(of: "="),
              let value = JSONValue(json: String(assignment[assignment.index(after: at)...])),
              let view = rowViews[String(assignment[..<at])]
        else { return false }
        view.onChange(value)
        return true
    }

    /// Nothing is loading or waiting to be written (the screenshot waits for this).
    var isSettled: Bool { !loading && queue.isEmpty && !draining }

    // MARK: layout

    private func build(_ window: NSWindow) {
        window.contentView = content
        searchField.placeholderString = "Search settings"
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(searchChanged)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.setAccessibilityLabel("Search settings")
        scopePopup.target = self
        scopePopup.action = #selector(scopeChosen)
        scopePopup.translatesAutoresizingMaskIntoConstraints = false
        scopePopup.setAccessibilityLabel("Scope")
        scopePopup.toolTip = "Which config file is shown and changed: the global one, or one repository's (it overrides the global one there)"

        categoryStack.orientation = .vertical
        categoryStack.alignment = .leading
        categoryStack.spacing = 2
        categoryStack.translatesAutoresizingMaskIntoConstraints = false
        sidebarNote.font = Theme.sans(DesignTokens.TypeScale.caption)
        sidebarNote.isSelectable = false
        sidebarNote.translatesAutoresizingMaskIntoConstraints = false
        sidebarNote.isHidden = true

        paneStack.orientation = .vertical
        paneStack.alignment = .leading
        paneStack.spacing = 0
        paneStack.translatesAutoresizingMaskIntoConstraints = false
        paneDocument.translatesAutoresizingMaskIntoConstraints = false
        paneDocument.addSubview(paneStack)
        paneScroll.documentView = paneDocument
        paneScroll.hasVerticalScroller = true
        paneScroll.drawsBackground = false
        paneScroll.borderType = .noBorder
        paneScroll.translatesAutoresizingMaskIntoConstraints = false

        for v in [searchField, scopeLabel, scopePopup, topLine, sidebar, sideLine, paneScroll] as [NSView] { content.addSubview(v) }
        sidebar.addSubview(categoryStack)
        sidebar.addSubview(sidebarNote)
        let clip = paneScroll.contentView
        NSLayoutConstraint.activate([
            searchField.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            searchField.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            searchField.widthAnchor.constraint(equalToConstant: 240),
            scopePopup.centerYAnchor.constraint(equalTo: searchField.centerYAnchor),
            scopePopup.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            scopePopup.widthAnchor.constraint(lessThanOrEqualToConstant: 260),
            scopeLabel.centerYAnchor.constraint(equalTo: searchField.centerYAnchor),
            scopeLabel.trailingAnchor.constraint(equalTo: scopePopup.leadingAnchor, constant: -8),
            scopeLabel.leadingAnchor.constraint(greaterThanOrEqualTo: searchField.trailingAnchor, constant: 12),

            topLine.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 12),
            topLine.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            topLine.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            topLine.heightAnchor.constraint(equalToConstant: 1),

            sidebar.topAnchor.constraint(equalTo: topLine.bottomAnchor),
            sidebar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            sidebar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 170),
            sideLine.topAnchor.constraint(equalTo: sidebar.topAnchor),
            sideLine.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            sideLine.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            sideLine.widthAnchor.constraint(equalToConstant: 1),
            categoryStack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 10),
            categoryStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 8),
            categoryStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -8),
            sidebarNote.topAnchor.constraint(equalTo: categoryStack.bottomAnchor, constant: 12),
            sidebarNote.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 18),
            sidebarNote.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -10),

            paneScroll.topAnchor.constraint(equalTo: topLine.bottomAnchor),
            paneScroll.leadingAnchor.constraint(equalTo: sideLine.trailingAnchor),
            paneScroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            paneScroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            paneDocument.topAnchor.constraint(equalTo: clip.topAnchor),
            paneDocument.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            paneDocument.widthAnchor.constraint(equalTo: clip.widthAnchor),
            paneStack.topAnchor.constraint(equalTo: paneDocument.topAnchor, constant: 16),
            paneStack.leadingAnchor.constraint(equalTo: paneDocument.leadingAnchor, constant: 22),
            paneStack.trailingAnchor.constraint(equalTo: paneDocument.trailingAnchor, constant: -22),
            paneStack.bottomAnchor.constraint(equalTo: paneDocument.bottomAnchor, constant: -20),
        ])
    }

    private func apply(_ t: Theme) {
        window?.appearance = t.appearance
        content.color = t.color(\.bg)
        sidebar.color = t.color(\.side)
        topLine.color = t.color(\.border)
        sideLine.color = t.color(\.border)
        scopeLabel.textColor = t.color(\.text2)
        sidebarNote.textColor = t.color(\.muted)
        for item in categoryItems { item.render(); item.needsDisplay = true }
        for h in headings { h.textColor = t.color(\.text) }
        for m in messages { m.textColor = t.color(\.muted) }
        for row in rowViews.values { row.apply(t) }
        appPane.apply(t)
        tokens.apply(t)
    }

    // MARK: scope

    private func rebuildScopes() {
        scopes = [.global] + repositories().map { SettingsScope.repo(root: $0.root, name: $0.name) }
        if !scopes.contains(scope) { scope = .global }
        scopePopup.removeAllItems()
        scopePopup.addItem(withTitle: "Global")
        if scopes.count > 1 { scopePopup.menu?.addItem(.separator()) }
        for case .repo(_, let name) in scopes.dropFirst() {
            // a menu item, not addItem(withTitle:): that one merges equal titles
            scopePopup.menu?.addItem(NSMenuItem(title: name, action: nil, keyEquivalent: ""))
        }
        selectScopeItem()
    }

    private func selectScopeItem() {
        guard let index = scopes.firstIndex(of: scope) else { return }
        // item 1 is the separator
        scopePopup.selectItem(at: index == 0 ? 0 : index + 1)
    }

    @objc private func scopeChosen() {
        let item = scopePopup.indexOfSelectedItem
        let index = item <= 0 ? 0 : item - 1
        guard scopes.indices.contains(index), scopes[index] != scope else { return }
        setScope(scopes[index])
    }

    private func setScope(_ new: SettingsScope) {
        window?.makeFirstResponder(nil)
        scope = new
        selectScopeItem()
        model = nil
        listError = nil
        renderAll()
        reload()
    }

    @objc private func useGlobalScope() { setScope(.global) }

    // MARK: loading

    /// Reads the schema (once per CLI) and the config files of the scope shown.
    private func reload() {
        generation += 1
        let load = generation
        guard let cli else { loading = false; renderAll(); return }
        let scope = self.scope
        let home = NSHomeDirectory()
        loading = true
        if model == nil { renderAll() }
        Task { @MainActor in
            if self.schema == nil {
                do {
                    let schema: ConfigSchemaJson = try await cli.run(configSchemaArgs, cwd: home, timeout: 30)
                    guard load == self.generation else { return }
                    self.schema = schema
                    self.schemaError = nil
                } catch {
                    guard load == self.generation else { return }
                    self.schemaError = ((error as? KunjCLIError)?.message ?? "\(error)", isSchemaUnsupported(error))
                    self.loading = false
                    self.renderAll()
                    return
                }
            }
            guard let schema = self.schema else { return }
            do {
                let list: ConfigListJson = try await cli.run(configListArgs, cwd: settingsCwd(scope, home: home), timeout: 30)
                guard load == self.generation else { return }
                self.listError = nil
                self.model = SettingsModel(schema: schema, list: list, scope: scope)
            } catch {
                guard load == self.generation else { return }
                self.model = nil
                self.listError = (error as? KunjCLIError)?.message ?? "\(error)"
            }
            self.loading = false
            self.showModel()
        }
    }

    @objc private func retry() {
        schemaError = nil
        reload()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        // the CLI may have changed the files meanwhile; never under a field being typed in
        guard window?.isVisible == true, cli != nil, !loading, isSettled, !rowViews.values.contains(where: \.isEditing) else { return }
        reload()
    }

    /// After a load: updates the rows in place when the same ones are shown, else redraws.
    private func showModel() {
        if let model, !rowViews.isEmpty,
           rowViews.allSatisfy({ key, view in model.row(for: key)?.control == view.row.control }) {
            renderSidebar()
            refreshRows()
        } else if !rowViews.values.contains(where: \.isEditing) {
            renderAll()
        }
    }

    // MARK: rendering

    private var searchText: String { searchField.stringValue.trimmingCharacters(in: .whitespaces) }

    private func renderAll() {
        renderSidebar()
        renderPane()
    }

    private func renderSidebar() {
        var entries = [(Self.appCategory, "App")]
        let hits = Set((model?.search(searchText) ?? []).map(\.category))
        for c in schema?.categories ?? [] where searchText.isEmpty || hits.contains(c.id) {
            entries.append((c.id, c.title))
        }
        if !searchText.isEmpty, !appMatchesSearch { entries.removeFirst() }
        if categoryItems.map(\.id) != entries.map(\.0) {
            for item in categoryItems { item.removeFromSuperview() }
            categoryItems = entries.map { id, title in
                let item = CategoryItem(id: id, title: title)
                item.onClick = { [weak self] in self?.select(category: id) }
                categoryStack.addArrangedSubview(item)
                item.widthAnchor.constraint(equalTo: categoryStack.widthAnchor).isActive = true
                return item
            }
        }
        for item in categoryItems { item.selected = searchText.isEmpty && item.id == category }
        if cli == nil {
            sidebarNote.stringValue = "kunj was not found, so only the app's own settings are here."
        } else if let schemaError, schemaError.unsupported {
            sidebarNote.stringValue = "Update kunj to edit its settings here."
        } else {
            sidebarNote.stringValue = ""
        }
        sidebarNote.isHidden = sidebarNote.stringValue.isEmpty
        let scoped = searchText.isEmpty ? category != Self.appCategory : true
        scopePopup.isHidden = !scoped || schema == nil
        scopeLabel.isHidden = scopePopup.isHidden
    }

    private var appMatchesSearch: Bool {
        let needle = searchText.lowercased()
        return AppSettingsPane.searchTerms.contains { $0.contains(needle) }
    }

    private func renderPane() {
        for v in paneStack.arrangedSubviews { v.removeFromSuperview() }
        tokens.useGhRow = nil
        rowViews = [:]
        headings = []
        messages = []
        let knownCategory = category == Self.appCategory || schema?.categories.contains { $0.id == category } == true
        if !searchText.isEmpty {
            renderSearch()
        } else if category == Self.appCategory || (schema != nil && !knownCategory) || (schema == nil && schemaError?.unsupported == true) || cli == nil {
            addHeading("App")
            add(appPane)
        } else if let schemaError {
            addHeading("Settings")
            addMessage("Could not read kunj's settings: \(schemaError.message)", button: ("Retry", #selector(retry)))
        } else if let model {
            addHeading(model.categories.first { $0.id == category }?.title ?? category)
            if category == "container" { addTokens(model) }
            for row in model.rows(in: category) where !(category == "container" && row.key == "container.useGhToken") {
                add(makeRow(row))
            }
        } else if let listError {
            addHeading(schema?.categories.first { $0.id == category }?.title ?? "Settings")
            addMessage("Could not read this configuration: \(listError)",
                       button: scope == .global ? ("Retry", #selector(retry)) : ("Show Global", #selector(useGlobalScope)))
        } else {
            addHeading(schema?.categories.first { $0.id == category }?.title ?? "Settings")
            addSpinner()
        }
        apply(ThemeManager.shared.current)
        refreshRows()
        paneScroll.contentView.scroll(to: .zero)
        paneScroll.reflectScrolledClipView(paneScroll.contentView)
    }

    private func renderSearch() {
        var any = false
        if appMatchesSearch {
            addHeading("App")
            add(appPane)
            any = true
        }
        if let model {
            let hits = model.search(searchText)
            for c in model.categories {
                let rows = hits.filter { $0.category == c.id }
                guard !rows.isEmpty else { continue }
                addHeading(c.title, topSpace: any ? 22 : 0)
                for row in rows { add(makeRow(row)) }
                any = true
            }
        }
        if !any {
            addHeading("Search")
            addMessage(loading ? "Loading…" : "No setting matches “\(searchText)”.", button: nil)
        }
    }

    private func add(_ view: NSView) {
        paneStack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: paneStack.widthAnchor).isActive = true
    }

    private func addHeading(_ text: String, topSpace: CGFloat = 0) {
        let h = makeLabel(text, font: Theme.sans(DesignTokens.TypeScale.title, weight: .semibold), color: .clear)
        headings.append(h)
        if topSpace > 0, let last = paneStack.arrangedSubviews.last { paneStack.setCustomSpacing(topSpace, after: last) }
        paneStack.addArrangedSubview(h)
        paneStack.setCustomSpacing(10, after: h)
    }

    private func addMessage(_ text: String, button: (String, Selector)?) {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = Theme.sans(DesignTokens.TypeScale.small)
        l.isSelectable = true
        messages.append(l)
        add(l)
        if let (title, action) = button {
            paneStack.setCustomSpacing(10, after: l)
            let b = NSButton(title: title, target: self, action: action)
            b.bezelStyle = .rounded
            b.controlSize = .small
            paneStack.addArrangedSubview(b)
        }
    }

    private func addSpinner() {
        let s = NSProgressIndicator()
        s.style = .spinning
        s.controlSize = .small
        s.startAnimation(nil)
        paneStack.addArrangedSubview(s)
    }

    private func addTokens(_ model: SettingsModel) {
        add(tokens)
        if let last = paneStack.arrangedSubviews.last { paneStack.setCustomSpacing(18, after: last) }
        if let row = model.row(for: "container.useGhToken") { tokens.useGhRow = makeRow(row) }
    }

    private func makeRow(_ row: SettingRow) -> SettingRowView {
        let view = SettingRowView(row: row)
        let key = row.key
        view.onChange = { [weak self] value in self?.enqueue(key, value) }
        view.onReset = { [weak self] in self?.enqueue(key, nil) }
        rowViews[key] = view
        return view
    }

    /// Shows the model's values in the rows on screen.
    private func refreshRows() {
        guard let model else { return }
        let tmuxOff = model.row(for: "agent.tmux")?.value == .bool(false)
        for (key, view) in rowViews {
            guard let row = model.row(for: key) else { continue }
            view.update(row, sourceText: sourceCaption(row, scope: scope),
                        enabled: cli != nil && !(key == "agent.tmuxStatus" && tmuxOff),
                        note: key == "agent.tmux" && tmuxOff ? "Agents stop when their tab closes" : nil)
        }
    }

    @objc private func searchChanged() {
        renderAll()
    }

    // MARK: writing

    private func enqueue(_ key: String, _ value: JSONValue?) {
        queue.append((key, value, scope))
        drain()
    }

    /// Runs the waiting writes one at a time, in order, so two quick changes never interleave on one file.
    private func drain() {
        guard !draining, let cli else { return }
        draining = true
        let home = NSHomeDirectory()
        Task { @MainActor in
            while !self.queue.isEmpty {
                let op = self.queue.removeFirst()
                let cwd = settingsCwd(op.scope, home: home)
                do {
                    let stored: JSONValue?
                    if let value = op.value {
                        let reply: ConfigSetJson = try await cli.run(configSetJsonArgs(op.key, value, op.scope), cwd: cwd, timeout: 30)
                        stored = reply.value
                        log("kunj config: set \(op.key)")  // never the value: it may be a token
                    } else {
                        let _: ConfigUnsetJson = try await cli.run(configUnsetArgs(op.key, op.scope), cwd: cwd, timeout: 30)
                        stored = nil
                        log("kunj config: unset \(op.key)")
                    }
                    self.written(op.key, stored, in: op.scope)
                } catch {
                    // back to what the model holds, with kunj's reason under the row
                    self.refreshRows()
                    if op.scope == self.scope {
                        self.rowViews[op.key]?.show(error: settingWriteMessage(error, key: op.key))
                    }
                }
            }
            self.draining = false
        }
    }

    private func written(_ key: String, _ value: JSONValue?, in writtenScope: SettingsScope) {
        guard writtenScope == scope, let current = model else { return }
        let next = current.replacing(key, with: value)
        model = next
        // a reset can change the row's control (a hand-edited value back to its checkbox)
        if let view = rowViews[key], next.row(for: key)?.control != view.row.control,
           !rowViews.values.contains(where: \.isEditing) {
            renderPane()
        } else {
            refreshRows()
        }
        // whether gh is asked changes where the GitHub token comes from
        if key == "container.useGhToken" { tokens.reload() }
    }
}
