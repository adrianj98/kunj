import AppKit
import KunjWorkspaceCore

/// Window ▸ Resources: everything kunj manages (cloud machines, containers, volumes, networks,
/// images), on this Mac, on every remote and in the cloud, from `kunj resources --json`. Read-only.
final class ResourcesWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    var cli: KunjCLI?
    private let table = NSTableView()
    private let summary = NSTextField(labelWithString: "")
    private let footer = NSTextField(wrappingLabelWithString: "")
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private var rows: [ResourceRow] = []
    private var loading = false
    /// True once a listing has come back (a screenshot waits for it)
    private(set) var isSettled = false
    private let theme = ThemeManager.shared.current

    private static let columns: [(id: String, title: String, width: CGFloat)] = [
        ("name", "Name", 330), ("owner", "Repository / branch", 210), ("state", "State", 90),
        ("detail", "What", 250), ("size", "Size", 70), ("location", "Where", 240),
    ]

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 620),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Resources"
        window.isReleasedWhenClosed = false
        window.appearance = ThemeManager.shared.current.appearance
        window.backgroundColor = ThemeManager.shared.current.color(\.bg)
        window.center()
        window.setFrameAutosaveName("KunjResourcesWindow")
        super.init(window: window)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func build() {
        guard let content = window?.contentView else { return }
        content.wantsLayer = true
        content.layer?.backgroundColor = theme.color(\.bg).cgColor
        summary.font = Theme.sans(13, weight: .medium)
        summary.textColor = theme.color(\.text)
        summary.lineBreakMode = .byTruncatingTail
        footer.font = Theme.sans(11)
        footer.textColor = theme.color(\.muted)
        refreshButton.target = self
        refreshButton.action = #selector(refresh(_:))
        refreshButton.bezelStyle = .rounded
        refreshButton.appearance = theme.appearance
        refreshButton.keyEquivalent = "r"
        refreshButton.keyEquivalentModifierMask = .command
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        for c in Self.columns {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
            column.title = c.title
            column.width = c.width
            column.minWidth = 50
            table.addTableColumn(column)
        }
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 22
        table.usesAlternatingRowBackgroundColors = false
        table.backgroundColor = theme.color(\.bg)
        table.gridStyleMask = []
        table.allowsMultipleSelection = false
        table.floatsGroupRows = false
        table.setAccessibilityLabel("Resources kunj manages")
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.drawsBackground = false

        let top = NSStackView(views: [summary, NSView(), spinner, refreshButton])
        top.orientation = .horizontal
        top.spacing = 8
        let stack = NSStackView(views: [top, scroll, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 12, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            top.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32),
        ])
        summary.stringValue = "Looking…"
    }

    @objc func refresh(_ sender: Any?) {
        guard !loading, let cli else { return }
        loading = true
        spinner.startAnimation(nil)
        refreshButton.isEnabled = false
        Task { @MainActor [weak self] in
            let result: Result<ResourcesJson, Error>
            do {
                result = .success(try await cli.run(["resources"], cwd: NSHomeDirectory(), timeout: 60))
            } catch {
                result = .failure(error)
            }
            guard let self else { return }
            self.loading = false
            self.spinner.stopAnimation(nil)
            self.refreshButton.isEnabled = true
            switch result {
            case .success(let json):
                self.rows = resourceRows(json)
                self.summary.stringValue = resourceSummary(json)
                self.footer.stringValue = silentPlaces(json).joined(separator: "\n")
            case .failure(let error):
                self.summary.stringValue = "kunj resources failed"
                self.footer.stringValue = "\(error)"
            }
            self.footer.isHidden = self.footer.stringValue.isEmpty
            self.table.reloadData()
            self.isSettled = true
        }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .section = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .section = rows[row] { return false }
        return true
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let label = NSTextField(labelWithString: "")
        label.lineBreakMode = .byTruncatingMiddle
        label.translatesAutoresizingMaskIntoConstraints = false
        switch rows[row] {
        case .section(let title, let count):
            label.stringValue = "\(title)  \(count)"
            label.font = Theme.sans(12, weight: .semibold)
            label.textColor = theme.color(\.text)
        case .item(let item):
            let id = tableColumn?.identifier.rawValue ?? "name"
            let text: String
            switch id {
            case "owner": text = item.owner
            case "state": text = item.state
            case "detail": text = item.detail
            case "size": text = item.size
            case "location": text = item.location
            default: text = item.name
            }
            label.stringValue = text
            label.toolTip = text
            label.font = id == "name" ? Theme.mono(12) : Theme.sans(12)
            label.textColor = id == "state" && item.active ? theme.color(\.green) : (id == "name" ? theme.color(\.text) : theme.color(\.muted))
        }
        let cell = NSTableCellView()
        cell.addSubview(label)
        cell.textField = label
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
            label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    func snapshotPNG() -> Data? {
        guard let root = window?.contentView else { return nil }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).representation(using: .png, properties: [:])
    }
}
