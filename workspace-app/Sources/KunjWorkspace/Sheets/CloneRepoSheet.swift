import AppKit
import KunjWorkspaceCore

/// Clone from GitHub (⌥⌘N): the repositories the gh login can clone (`kunj repos github`),
/// filtered by the search field, the ones already here last and greyed. Clone runs
/// `kunj repos clone <owner/name>` (into `repos.cloneDir`, bare when `repos.cloneBare`), keeps
/// the sheet open with a spinner until it ends, then hands the result to `onCloned` and closes.
@MainActor
final class CloneRepoSheet: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    var onCloned: (RepoCloneJson) -> Void = { _ in }

    private let cli: KunjCLI
    private let theme: Theme
    private var all: [GitHubRepo] = []
    private var rows: [GitHubRepo] = []
    private var busy = false
    private let search = NSSearchField()
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let spinner = NSProgressIndicator()
    private let statusLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let cloneButton = NSButton(title: "Clone", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

    private enum Col: String, CaseIterable {
        case repo, description, pushed
        var title: String { ["Repository", "Description", "Pushed"][Self.allCases.firstIndex(of: self)!] }
        var width: CGFloat { [230, 300, 70][Self.allCases.firstIndex(of: self)!] }
    }

    init(cli: KunjCLI, theme: Theme) {
        self.cli = cli
        self.theme = theme
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 660, height: 440),
                            styleMask: [.titled, .docModalWindow], backing: .buffered, defer: true)
        panel.title = "Clone from GitHub"
        super.init(window: panel)
        build(panel)
        load()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build(_ panel: NSPanel) {
        panel.appearance = theme.appearance
        let content = FillView(theme.color(\.bg))
        panel.contentView = content

        let title = makeLabel("Clone from GitHub", font: Theme.sans(DesignTokens.TypeScale.title, weight: .semibold),
                              color: theme.color(\.text))
        search.placeholderString = "Filter by name or description"
        search.delegate = self
        search.translatesAutoresizingMaskIntoConstraints = false
        search.setAccessibilityLabel("Filter repositories")

        for col in Col.allCases {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(col.rawValue))
            c.title = col.title
            c.width = col.width
            c.minWidth = 50
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.target = self
        table.doubleAction = #selector(clone)
        table.setAccessibilityLabel("GitHub repositories")
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = theme.color(\.muted)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        cloneButton.bezelStyle = .rounded
        cloneButton.keyEquivalent = "\r"
        cloneButton.target = self
        cloneButton.action = #selector(clone)
        cloneButton.isEnabled = false
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.target = self
        cancelButton.action = #selector(cancel)

        let buttons = NSStackView(views: [cancelButton, cloneButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        for v in [title, search, scroll, spinner, statusLabel, buttons] as [NSView] { content.addSubview(v) }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            search.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            search.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            search.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 240),
            buttons.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 12),
            buttons.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            buttons.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            spinner.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            spinner.centerYAnchor.constraint(equalTo: buttons.centerYAnchor),
            statusLabel.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 6),
            statusLabel.centerYAnchor.constraint(equalTo: buttons.centerYAnchor),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: buttons.leadingAnchor, constant: -12),
        ])
        panel.initialFirstResponder = search
    }

    // MARK: loading and cloning

    private func load() {
        setBusy(true, "Asking GitHub…")
        Task { [weak self, cli] in
            do {
                let doc: GitHubReposJson = try await cli.run(GitHubRepos.listArguments(), cwd: NSHomeDirectory(), timeout: 60)
                guard let self else { return }
                self.all = doc.repos
                self.setBusy(false, "")
                self.render()
            } catch {
                self?.setBusy(false, Self.message(error), error: true)
            }
        }
    }

    @objc private func clone() {
        guard !busy, let repo = selected, repo.local == nil else { return }
        setBusy(true, "Cloning \(repo.fullName)…")
        Task { [weak self, cli] in
            do {
                let result: RepoCloneJson = try await cli.run(GitHubRepos.cloneArguments(repo), cwd: NSHomeDirectory(),
                                                              timeout: 900)
                guard let self else { return }
                log("cloned \(repo.fullName) to \(result.path)")
                self.close(.OK)
                self.onCloned(result)
            } catch {
                self?.setBusy(false, Self.message(error), error: true)
            }
        }
    }

    /// kunj's own message, with the next step for the cases the user can fix.
    private static func message(_ error: Error) -> String {
        guard let e = error as? KunjCLIError else { return error.localizedDescription }
        switch e.kunjCode {
        case "gh-missing": return "Install the GitHub CLI (gh) to list and clone repositories"
        case "gh-auth": return "gh is not logged in: run `gh auth login` in a terminal"
        default:
            if e.message.contains("Unknown repos action") { return "This kunj is too old for GitHub cloning: update it" }
            return e.message
        }
    }

    private func setBusy(_ on: Bool, _ status: String, error: Bool = false) {
        busy = on
        on ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
        statusLabel.stringValue = status
        statusLabel.textColor = error ? theme.color(\.red) : theme.color(\.muted)
        statusLabel.toolTip = status
        search.isEnabled = !on
        table.isEnabled = !on
        updateButtons()
    }

    // MARK: table

    private var selected: GitHubRepo? { rows.indices.contains(table.selectedRow) ? rows[table.selectedRow] : nil }

    private func render() {
        let keep = selected?.fullName
        rows = GitHubRepos.filter(all, query: search.stringValue)
        table.reloadData()
        let index = rows.firstIndex { $0.fullName == keep } ?? rows.firstIndex { $0.local == nil }
        if let index { table.selectRowIndexes([index], byExtendingSelection: false) }
        if !busy {
            let here = all.filter { $0.local != nil }.count
            statusLabel.stringValue = all.isEmpty ? "No repositories" : "\(rows.count) of \(all.count) · \(here) already here"
        }
        updateButtons()
    }

    private func updateButtons() {
        cloneButton.isEnabled = !busy && selected.map { $0.local == nil } == true
    }

    func controlTextDidChange(_ obj: Notification) { render() }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableViewSelectionDidChange(_ notification: Notification) { updateButtons() }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let id = tableColumn?.identifier, let col = Col(rawValue: id.rawValue), row < rows.count else { return nil }
        let r = rows[row]
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? NSTableCellView) ?? makeCell(id)
        let field = cell.textField!
        field.toolTip = nil
        field.font = col == .repo ? Theme.mono(DesignTokens.TypeScale.small) : Theme.sans(DesignTokens.TypeScale.small)
        field.textColor = r.local == nil ? theme.color(\.text) : theme.color(\.muted)
        switch col {
        case .repo:
            let tags = [r.private ? "private" : nil, r.fork ? "fork" : nil].compactMap { $0 }
            field.stringValue = r.fullName + (tags.isEmpty ? "" : "  " + tags.joined(separator: " · "))
            field.toolTip = r.local.map { "Already here: \($0)" } ?? r.url
        case .description:
            field.stringValue = r.local.map { "✓ \($0)" } ?? (r.description ?? "")
            if r.local == nil && r.description == nil { field.textColor = theme.color(\.muted) }
            field.toolTip = r.description
        case .pushed:
            field.stringValue = formatAge(r.pushedAt)
            field.alignment = .right
        }
        return cell
    }

    private func makeCell(_ id: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = id
        let field = NSTextField(labelWithString: "")
        field.lineBreakMode = .byTruncatingTail
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

    @objc private func cancel() { close(.cancel) }

    private func close(_ code: NSApplication.ModalResponse) {
        guard let w = window else { return }
        if let parent = w.sheetParent { parent.endSheet(w, returnCode: code) } else { w.close() }
    }
}
