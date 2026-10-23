import AppKit
import WebKit

final class DiffPayload {
    let original: String, modified: String, language: String
    init(original: String, modified: String, language: String) {
        self.original = original; self.modified = modified; self.language = language
    }
}

final class Tab {
    enum Kind { case terminal(SpikeTerminal), diff(DiffPayload) }
    let title: String
    let kind: Kind
    init(title: String, kind: Kind) { self.title = title; self.kind = kind }
    var terminal: SpikeTerminal? { if case .terminal(let t) = kind { return t }; return nil }
}

final class Environment {
    let name: String
    var tabs: [Tab] = []
    var selected = 0
    init(name: String) { self.name = name }
}

/// One window: environment list on the left, tab strip + content on the right.
/// Terminal views of every environment stay in the view tree, hidden when not shown, so
/// switching never touches their processes. One WKWebView is shared by all diff tabs.
final class WorkspaceWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    var envs: [Environment] = []
    var currentEnv = 0
    let table = NSTableView()
    let tabBar = NSStackView()
    let content = NSView()
    private var _editor: EditorController?
    /// Created on first use, so its creation can be timed.
    var editor: EditorController {
        if let e = _editor { return e }
        let e = EditorController()
        _editor = e
        return e
    }
    private var shownDiff: DiffPayload?
    /// Grid mode shows these terminals at once (bench B).
    var gridTerminals: [SpikeTerminal]?

    init() {
        let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "kunj native IDE spike"
        super.init(window: window)
        window.delegate = self
        buildUI()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func buildUI() {
        guard let window else { return }
        let col = NSTableColumn(identifier: .init("env"))
        col.title = "Environments"
        table.addTableColumn(col)
        table.headerView = nil
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 24
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        // Fixed-width sidebar via Auto Layout (an NSSplitView set before first layout
        // gave the sidebar most of the window).
        let root = NSView()
        let right = NSView()
        right.translatesAutoresizingMaskIntoConstraints = false
        tabBar.orientation = .horizontal
        tabBar.spacing = 2
        tabBar.edgeInsets = NSEdgeInsets(top: 2, left: 4, bottom: 2, right: 4)
        tabBar.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        content.clipsToBounds = true
        right.addSubview(tabBar)
        right.addSubview(content)
        NSLayoutConstraint.activate([
            tabBar.topAnchor.constraint(equalTo: right.topAnchor),
            tabBar.leadingAnchor.constraint(equalTo: right.leadingAnchor),
            tabBar.trailingAnchor.constraint(lessThanOrEqualTo: right.trailingAnchor),
            tabBar.heightAnchor.constraint(equalToConstant: 28),
            content.topAnchor.constraint(equalTo: tabBar.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: right.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: right.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: right.bottomAnchor),
        ])
        root.addSubview(scroll)
        root.addSubview(right)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            scroll.widthAnchor.constraint(equalToConstant: 180),
            right.leadingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: 1),
            right.topAnchor.constraint(equalTo: root.topAnchor),
            right.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            right.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        window.contentView = root
        content.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: content, queue: .main) { [weak self] _ in
            self?.layoutContent()
        }
    }

    // MARK: model

    @discardableResult
    func addEnvironment(_ name: String) -> Environment {
        let e = Environment(name: name)
        envs.append(e)
        table.reloadData()
        return e
    }

    @discardableResult
    func addTerminal(to env: Environment, title: String, command: String?, cwd: String? = nil) -> SpikeTerminal {
        let t = SpikeTerminal(title: title)
        t.isHidden = true
        t.autoresizingMask = [.width, .height]
        content.addSubview(t)
        t.frame = content.bounds
        t.start(command: command, cwd: cwd)
        env.tabs.append(Tab(title: title, kind: .terminal(t)))
        return t
    }

    func addDiff(to env: Environment, title: String, payload: DiffPayload) {
        env.tabs.append(Tab(title: title, kind: .diff(payload)))
    }

    var currentTab: Tab? {
        guard envs.indices.contains(currentEnv) else { return nil }
        let e = envs[currentEnv]
        return e.tabs.indices.contains(e.selected) ? e.tabs[e.selected] : nil
    }

    func select(env: Int, tab: Int? = nil) {
        currentEnv = env
        if let tab { envs[env].selected = tab }
        if table.selectedRow != env { table.selectRowIndexes([env], byExtendingSelection: false) }
        refresh()
    }

    func refresh() {
        // tab strip
        tabBar.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if envs.indices.contains(currentEnv) {
            let e = envs[currentEnv]
            for (i, tab) in e.tabs.enumerated() {
                let b = NSButton(title: tab.title, target: self, action: #selector(tabClicked(_:)))
                b.tag = i
                b.bezelStyle = .recessed
                b.setButtonType(.pushOnPushOff)
                b.state = i == e.selected ? .on : .off
                b.refusesFirstResponder = true
                tabBar.addArrangedSubview(b)
            }
        }
        layoutContent()
    }

    func layoutContent() {
        let bounds = content.bounds
        let allTerminals = envs.flatMap { $0.tabs.compactMap(\.terminal) }
        if let grid = gridTerminals {
            for t in allTerminals where !grid.contains(where: { $0 === t }) { t.isHidden = true }
            _editor?.webView.isHidden = true
            // 2 rows x 3 columns
            let w = bounds.width / 3, h = bounds.height / 2
            for (i, t) in grid.enumerated() {
                let r = i / 3, c = i % 3
                t.frame = NSRect(x: CGFloat(c) * w, y: bounds.height - CGFloat(r + 1) * h, width: w - 1, height: h - 1)
                t.isHidden = false
            }
            return
        }
        let tab = currentTab
        for t in allTerminals {
            let show = tab?.terminal === t
            if show { t.frame = bounds }
            t.isHidden = !show
        }
        if case .diff(let payload)? = tab?.kind {
            let wv = editor.webView
            if wv.superview !== content { wv.autoresizingMask = [.width, .height]; content.addSubview(wv) }
            wv.frame = bounds
            wv.isHidden = false
            if shownDiff !== payload {
                shownDiff = payload
                editor.showDiff(original: payload.original, modified: payload.modified, language: payload.language)
            }
        } else {
            _editor?.webView.isHidden = true
        }
    }

    func focusCurrent() {
        guard let tab = currentTab else { return }
        switch tab.kind {
        case .terminal(let t): window?.makeFirstResponder(t)
        case .diff: window?.makeFirstResponder(editor.webView)
        }
    }

    @objc func tabClicked(_ sender: NSButton) {
        select(env: currentEnv, tab: sender.tag)
        focusCurrent()
    }

    // MARK: menu actions (Tabs menu)

    private(set) var nextTabCount = 0
    private(set) var closeTabCount = 0

    @objc func nextTab(_ sender: Any?) {
        nextTabCount += 1
        guard envs.indices.contains(currentEnv) else { return }
        let e = envs[currentEnv]
        guard !e.tabs.isEmpty else { return }
        select(env: currentEnv, tab: (e.selected + 1) % e.tabs.count)
        focusCurrent()
    }

    @objc func closeTab(_ sender: Any?) {
        closeTabCount += 1
        guard envs.indices.contains(currentEnv) else { return }
        let e = envs[currentEnv]
        guard e.tabs.indices.contains(e.selected) else { return }
        let tab = e.tabs.remove(at: e.selected)
        if let t = tab.terminal {
            t.terminate()
            t.removeFromSuperview()
        }
        e.selected = max(0, min(e.selected, e.tabs.count - 1))
        refresh()
        focusCurrent()
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { envs.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let f = NSTextField(labelWithString: envs[row].name)
        f.lineBreakMode = .byTruncatingTail
        return f
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let r = table.selectedRow
        if r >= 0 && r != currentEnv { currentEnv = r; refresh() }
    }

    func windowWillClose(_ notification: Notification) {
        for t in envs.flatMap({ $0.tabs.compactMap(\.terminal) }) { t.terminate() }
        NSApp.terminate(nil)
    }

    // MARK: snapshots

    /// Renders the window's content into a PNG without screen-recording permission:
    /// AppKit views through cacheDisplay, the WKWebView through takeSnapshot.
    func snapshotPNG(completion: @escaping (Data?) -> Void) {
        guard let root = window?.contentView else { completion(nil); return }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        // SwiftTerm leaves default-background cells transparent and relies on its layer's
        // backgroundColor, which cacheDisplay does not draw: its (light) text would land on
        // the window background. So each visible terminal is rendered on its own and
        // composited over its background colour.
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { completion(nil); return }
        root.cacheDisplay(in: root.bounds, to: rep)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let terms = envs.flatMap { $0.tabs.compactMap(\.terminal) }.filter { !$0.isHidden && $0.window != nil }
        for t in terms {
            guard let trep = t.bitmapImageRepForCachingDisplay(in: t.bounds) else { continue }
            t.cacheDisplay(in: t.bounds, to: trep)
            let r = t.convert(t.bounds, to: root)
            if ProcessInfo.processInfo.environment["SPIKE_DEBUG_SNAP"] != nil {
                log("snap root=\(root.bounds) flipped=\(root.isFlipped) term=\(r) rep=\(rep.size) px=\(rep.pixelsWide)x\(rep.pixelsHigh) trep=\(trep.size)")
            }
            t.nativeBackgroundColor.setFill()
            r.fill()
            trep.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
        let wv = _editor?.webView ?? WKWebView()
        let webVisible = wv.superview != nil && !wv.isHidden && wv.window != nil
        let finish: (NSImage?) -> Void = { webImage in
            let out = NSImage(size: root.bounds.size)
            out.lockFocus()
            rep.draw(in: root.bounds)
            if let webImage {
                var r = wv.convert(wv.bounds, to: root)
                if root.isFlipped { r.origin.y = root.bounds.height - r.maxY }
                webImage.draw(in: r)
            }
            out.unlockFocus()
            guard let tiff = out.tiffRepresentation, let b = NSBitmapImageRep(data: tiff) else { completion(nil); return }
            completion(b.representation(using: .png, properties: [:]))
        }
        if webVisible {
            wv.takeSnapshot(with: nil) { image, _ in finish(image) }
        } else {
            finish(nil)
        }
    }
}
