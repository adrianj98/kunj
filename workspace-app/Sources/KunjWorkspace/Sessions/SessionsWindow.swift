import AppKit
import KunjWorkspaceCore

/// Window > Sessions (⌘⇧S): every kunj tmux session (`kunj sessions list --json`, with
/// `--containers` when the box is on), what is attached to it, its CPU and memory and whether it is
/// orphaned; refreshed every 5 s while the window is visible. End Selected and End Orphans run
/// `kunj sessions kill` after a confirmation. A session whose id is one of the open tabs' session
/// ids shows "Tab open" and is never counted as an orphan to end.
@MainActor
final class SessionsWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    var cli: KunjCLI?
    /// Where kunj runs (any repository root: the listing covers every repository).
    var cwd: () -> String? = { nil }
    /// The session ids of the open shell and agent tabs.
    var tabSessionIds: () -> Set<String> = { [] }

    private let content = FillView(.clear)
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let filterPopup = NSPopUpButton()
    private let containersBox = NSButton(checkboxWithTitle: "Containers", target: nil, action: nil)
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: nil)
    private let endSelectedButton = NSButton(title: "End Selected", target: nil, action: nil)
    private let endOrphansButton = NSButton(title: "End Orphans", target: nil, action: nil)
    private let footer = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let errorLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)

    private var all: [TmuxSession] = []
    private var rows: [TmuxSession] = []
    private var tabbed: Set<String> = []
    private var timer: Timer?
    private var loading = false
    private var busy = false

    private static let containersKey = "sessionsContainers"

    private enum Col: String, CaseIterable {
        case kind, place, command, attached, cpu, memory, active, status, name

        var title: String {
            switch self {
            case .kind: return ""
            case .place: return "Worktree / container"
            case .command: return "Running"
            case .attached: return "Attached"
            case .cpu: return "CPU"
            case .memory: return "Memory"
            case .active: return "Active"
            case .status: return "Status"
            case .name: return "tmux session"
            }
        }

        var width: CGFloat {
            switch self {
            case .kind: return 44
            case .place: return 230
            case .command: return 80
            case .attached: return 120
            case .cpu: return 54
            case .memory: return 64
            case .active: return 50
            case .status: return 150
            case .name: return 260
            }
        }
    }

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 460),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: true)
        window.title = "Sessions"
        window.minSize = NSSize(width: 640, height: 260)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        build(window)
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        if window?.isVisible != true { window?.center() }
        super.showWindow(sender)
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
    }

    // MARK: layout

    private func build(_ window: NSWindow) {
        window.contentView = content

        for f in SessionsFilter.allCases { filterPopup.addItem(withTitle: f.title) }
        filterPopup.target = self
        filterPopup.action = #selector(filterChanged(_:))
        containersBox.state = UserDefaults.standard.bool(forKey: Self.containersKey) ? .on : .off
        containersBox.target = self
        containersBox.action = #selector(containersChanged(_:))
        containersBox.toolTip = "Also list the sessions inside running branch containers (one exec per container)"
        refreshButton.target = self
        refreshButton.action = #selector(refreshClicked(_:))
        endSelectedButton.target = self
        endSelectedButton.action = #selector(endSelected(_:))
        endOrphansButton.target = self
        endOrphansButton.action = #selector(endOrphans(_:))
        endOrphansButton.toolTip = "End every orphaned session without an open tab (worktree removed, or idle)"

        for col in Col.allCases {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(col.rawValue))
            c.title = col.title
            c.width = col.width
            c.minWidth = col == .kind ? 36 : 40
            if col == .cpu || col == .memory || col == .active || col == .place || col == .status {
                c.sortDescriptorPrototype = NSSortDescriptor(key: col.rawValue, ascending: col == .place || col == .status)
            }
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.allowsMultipleSelection = true
        table.usesAlternatingRowBackgroundColors = false
        table.rowHeight = 22
        table.style = .fullWidth
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.sortDescriptors = [NSSortDescriptor(key: Col.cpu.rawValue, ascending: false)]
        let menu = NSMenu()
        menu.addItem(withTitle: "End Session", action: #selector(endClicked(_:)), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Copy Session Name", action: #selector(copyName(_:)), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Copy Attach Command", action: #selector(copyAttach(_:)), keyEquivalent: "").target = self
        table.menu = menu
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false

        let bar = NSStackView(views: [filterPopup, containersBox, NSView(), errorLabel, refreshButton, endSelectedButton, endOrphansButton])
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.setHuggingPriority(.defaultLow, for: .horizontal)
        errorLabel.lineBreakMode = .byTruncatingTail
        errorLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for v in [bar, scroll, footer] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: content.topAnchor, constant: 10),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            footer.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 6),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            footer.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -12),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
        ])
        updateButtons()
    }

    private func apply(_ t: Theme) {
        window?.appearance = t.appearance
        content.color = t.color(\.bg)
        footer.textColor = t.color(\.muted)
        errorLabel.textColor = t.color(\.red)
        table.backgroundColor = t.color(\.bg)
        table.reloadData()
    }

    // MARK: data

    private func refresh() {
        guard !loading, let cli, let cwd = cwd() else {
            if cli == nil { errorLabel.stringValue = "kunj is not connected" }
            return
        }
        loading = true
        let args = sessionsListArguments(containers: containersBox.state == .on)
        Task { [weak self] in
            do {
                let json: SessionsJson = try await cli.run(args, cwd: cwd, timeout: 30)
                guard let self else { return }
                self.loading = false
                self.errorLabel.stringValue = json.tmux == "missing" ? "tmux is not installed"
                    : json.tmux == "failed" ? "tmux could not be asked"
                    : json.containers.map { $0.available ? "" : "Containers: \($0.message ?? "Docker could not be asked")" } ?? ""
                self.all = json.sessions
                self.render()
            } catch {
                guard let self else { return }
                self.loading = false
                self.errorLabel.stringValue = (error as? KunjCLIError)?.message ?? "\(error)"
            }
        }
    }

    private func render() {
        tabbed = tabSessionIds()
        let filter = SessionsFilter.allCases[max(0, filterPopup.indexOfSelectedItem)]
        let selected = Set(table.selectedRowIndexes.compactMap { $0 < rows.count ? rows[$0].name + "|" + (rows[$0].container ?? "") : nil })
        rows = sorted(all.filter { filter.includes($0, tabbed: isTabbed($0)) })
        table.reloadData()
        let keep = IndexSet(rows.indices.filter { selected.contains(rows[$0].name + "|" + (rows[$0].container ?? "")) })
        table.selectRowIndexes(keep, byExtendingSelection: false)
        footer.stringValue = sessionsSummary(rows)
        updateButtons()
    }

    private func isTabbed(_ s: TmuxSession) -> Bool { sessionIsTabbed(s, tabSessionIds: tabbed) }

    private func sorted(_ list: [TmuxSession]) -> [TmuxSession] {
        guard let d = table.sortDescriptors.first, let key = d.key else { return list }
        let asc = d.ascending
        func cmp<T: Comparable>(_ a: T, _ b: T) -> Bool { asc ? a < b : a > b }
        return list.sorted { a, b in
            switch key {
            case Col.cpu.rawValue: return cmp(a.usage?.cpu ?? -1, b.usage?.cpu ?? -1)
            case Col.memory.rawValue: return cmp(a.usage?.memoryBytes ?? -1, b.usage?.memoryBytes ?? -1)
            case Col.active.rawValue: return cmp(a.lastActivityAt ?? "", b.lastActivityAt ?? "")
            case Col.status.rawValue: return cmp(sessionStatusText(a, tabbed: isTabbed(a)), sessionStatusText(b, tabbed: isTabbed(b)))
            default: return cmp(sessionPlace(a), sessionPlace(b))
            }
        }
    }

    private func updateButtons() {
        endSelectedButton.isEnabled = !busy && !table.selectedRowIndexes.isEmpty
        endOrphansButton.isEnabled = !busy && all.contains { $0.orphan != nil && !isTabbed($0) }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) { render() }

    func tableViewSelectionDidChange(_ notification: Notification) { updateButtons() }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let id = tableColumn?.identifier, let col = Col(rawValue: id.rawValue), row < rows.count else { return nil }
        let s = rows[row]
        let t = ThemeManager.shared.current
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? NSTableCellView) ?? makeCell(id)
        let field = cell.textField!
        let mono = col == .name || col == .cpu || col == .memory || col == .command
        field.font = mono ? Theme.mono(DesignTokens.TypeScale.small) : Theme.sans(DesignTokens.TypeScale.small)
        field.alignment = (col == .cpu || col == .memory || col == .active) ? .right : .left
        field.textColor = t.color(\.text)
        let tabOpen = isTabbed(s)
        switch col {
        case .kind:
            field.stringValue = s.kind == "agent" ? "agent" : "shell"
            field.textColor = s.kind == "agent" ? t.color(\.link) : t.color(\.muted)
        case .place:
            field.stringValue = sessionPlace(s)
            if s.worktree == nil && s.container == nil { field.textColor = t.color(\.muted) }
        case .command: field.stringValue = s.command ?? "—"
        case .attached:
            field.stringValue = sessionAttachedText(s)
            field.textColor = s.attached.isEmpty ? t.color(\.muted) : t.color(\.green)
            field.toolTip = s.attached.map { "\($0.via ?? "?") · \($0.tty) · pid \($0.pid)" }.joined(separator: "\n")
        case .cpu:
            field.stringValue = formatCPU(s.usage)
            if let c = s.usage?.cpu, c >= 50 { field.textColor = t.color(\.amber) }
        case .memory: field.stringValue = formatMemory(s.usage)
        case .active:
            field.stringValue = formatAge(s.lastActivityAt)
            field.toolTip = "Started \(formatAge(s.createdAt)) ago"
        case .status:
            field.stringValue = sessionStatusText(s, tabbed: tabOpen)
            field.textColor = s.orphan != nil && !tabOpen ? t.color(\.amber) : tabOpen ? t.color(\.green) : t.color(\.muted)
        case .name:
            field.stringValue = s.container.map { "\($0): \(s.name)" } ?? s.name
            field.textColor = t.color(\.muted)
            field.toolTip = [s.name, s.cwd.map { "in \($0)" }].compactMap { $0 }.joined(separator: "\n")
        }
        return cell
    }

    private func makeCell(_ id: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = id
        let field = NSTextField(labelWithString: "")
        field.lineBreakMode = .byTruncatingMiddle
        field.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(field)
        cell.textField = field
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    // MARK: actions

    @objc private func filterChanged(_ sender: Any?) { render() }

    @objc private func containersChanged(_ sender: Any?) {
        UserDefaults.standard.set(containersBox.state == .on, forKey: Self.containersKey)
        refresh()
    }

    @objc private func refreshClicked(_ sender: Any?) { refresh() }

    /// The clicked row (context menu), else the selection.
    private func targets() -> [TmuxSession] {
        let clicked = table.clickedRow
        if clicked >= 0, clicked < rows.count, !table.selectedRowIndexes.contains(clicked) { return [rows[clicked]] }
        return table.selectedRowIndexes.compactMap { $0 < rows.count ? rows[$0] : nil }
    }

    @objc private func endClicked(_ sender: Any?) { end(targets()) }
    @objc private func endSelected(_ sender: Any?) { end(targets()) }
    /// kunj checks attachment again before each kill: the listing may be 5 s old and the sheet open longer
    @objc private func endOrphans(_ sender: Any?) { end(all.filter { $0.orphan != nil && !isTabbed($0) }, ifDetached: true) }

    @objc private func copyName(_ sender: Any?) {
        guard let s = targets().first else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s.name, forType: .string)
    }

    @objc private func copyAttach(_ sender: Any?) {
        guard let s = targets().first else { return }
        let cmd = s.container.map { "docker exec -it \($0) tmux attach -t \(s.name)" } ?? "tmux attach -t \(s.name)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
    }

    private func end(_ sessions: [TmuxSession], ifDetached: Bool = false) {
        guard !sessions.isEmpty, !busy, let cli, let cwd = cwd(), let window else { return }
        let tabs = sessions.filter { isTabbed($0) }.count
        let attached = sessions.filter { !$0.attached.isEmpty }.count
        let a = NSAlert()
        a.messageText = sessions.count == 1 ? "End \(sessionPlace(sessions[0]))'s \(sessions[0].kind) session?" : "End \(sessions.count) sessions?"
        var detail = "Whatever runs in \(sessions.count == 1 ? "it" : "them") is stopped (an agent loses its conversation unless it can resume it)."
        if attached > 0 { detail += " \(attached) \(attached == 1 ? "has" : "have") a terminal attached." }
        if tabs > 0 { detail += " \(tabs) \(tabs == 1 ? "is" : "are") open in a tab, which will show the session ended." }
        a.informativeText = detail
        a.addButton(withTitle: "End")
        a.addButton(withTitle: "Cancel")
        a.alertStyle = .warning
        a.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.busy = true
            self.updateButtons()
            Task { [weak self] in
                var failures: [String] = []
                for args in sessionsKillArguments(sessions, ifDetached: ifDetached) {
                    do {
                        let r: SessionsKillJson = try await cli.run(args, cwd: cwd, timeout: 30)
                        failures += r.failed.map { "\($0.name): \($0.error)" }
                    } catch {
                        failures.append((error as? KunjCLIError)?.message ?? "\(error)")
                    }
                }
                guard let self else { return }
                self.busy = false
                self.errorLabel.stringValue = failures.isEmpty ? "" : failures.joined(separator: "; ")
                self.loading = false
                self.refresh()
            }
        }
    }
}
