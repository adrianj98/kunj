import AppKit
import KunjWorkspaceCore

/// New session (⌘N): repository, branch, base ("repo default" when blank), Worktree or Container
/// (Container disabled while the repository's container backend is unavailable), "Run on" (this Mac
/// or a `kunj remote`, shown for a container when the repository's listing reported remotes),
/// "Start an agent".
/// Create checks the branch name against `git check-ref-format --branch` rules and hands a
/// `NewSessionRequest` to `onCreate`; the sheet closes itself.
@MainActor
final class NewSessionSheet: NSWindowController, NSTextFieldDelegate {
    var onCreate: (NewSessionRequest) -> Void = { _ in }

    private let groups: [RepoEnvironments]
    private let theme: Theme
    private let repoPopup = NSPopUpButton()
    private let branchField = NSTextField()
    private let baseField = NSTextField()
    private let worktreeRadio = NSButton(radioButtonWithTitle: "Worktree", target: nil, action: nil)
    private let containerRadio = NSButton(radioButtonWithTitle: "Container", target: nil, action: nil)
    private let agentBox = NSButton(checkboxWithTitle: "Start an agent", target: nil, action: nil)
    private let runOnPopup = NSPopUpButton()
    private var runOnRow: NSGridRow?
    private var runOn: [RunOnChoice] = []
    private let errorLabel = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let backendNote = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let createButton = NSButton(title: "Create", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

    /// `repos` from the store; `preferred` is the repository selected first (the selected
    /// environment's).
    init(repos: [RepoEnvironments], preferred: RepoRef?, theme: Theme) {
        groups = repos
        self.theme = theme
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
                            styleMask: [.titled, .docModalWindow], backing: .buffered, defer: true)
        panel.title = "New Session"
        super.init(window: panel)
        build(panel)
        for g in repos { repoPopup.addItem(withTitle: g.repo.name) }
        if let preferred, let i = repos.firstIndex(where: { $0.repo == preferred }) { repoPopup.selectItem(at: i) }
        worktreeRadio.state = .on
        repoChanged()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build(_ panel: NSPanel) {
        panel.appearance = theme.appearance
        let content = FillView(theme.color(\.bg))
        panel.contentView = content

        let title = makeLabel("New session", font: Theme.sans(DesignTokens.TypeScale.title, weight: .semibold),
                              color: theme.color(\.text))
        func caption(_ s: String) -> NSTextField {
            let l = makeLabel(s, font: Theme.sans(DesignTokens.TypeScale.small), color: theme.color(\.text2))
            l.alignment = .right
            return l
        }
        for f in [branchField, baseField] {
            f.font = Theme.mono(12)
            f.translatesAutoresizingMaskIntoConstraints = false
            f.delegate = self
        }
        branchField.placeholderString = "feature/my-task"
        branchField.setAccessibilityLabel("Branch")
        baseField.placeholderString = "repo default"
        baseField.setAccessibilityLabel("Base branch")
        repoPopup.target = self
        repoPopup.action = #selector(repoChangedAction)
        repoPopup.setAccessibilityLabel("Repository")
        runOnPopup.setAccessibilityLabel("Run on")
        // A remote that did not answer stays listed but cannot be picked
        runOnPopup.autoenablesItems = false
        // As wide as its longest name, like the repository popup above it
        runOnPopup.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        worktreeRadio.target = self
        worktreeRadio.action = #selector(kindChanged(_:))
        containerRadio.target = self
        containerRadio.action = #selector(kindChanged(_:))
        errorLabel.textColor = theme.color(\.red)
        errorLabel.lineBreakMode = .byWordWrapping
        errorLabel.maximumNumberOfLines = 2
        backendNote.textColor = theme.color(\.muted)
        createButton.bezelStyle = .rounded
        createButton.keyEquivalent = "\r"
        createButton.target = self
        createButton.action = #selector(create)
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.target = self
        cancelButton.action = #selector(cancel)

        let kind = NSStackView(views: [worktreeRadio, containerRadio, backendNote])
        kind.orientation = .horizontal
        kind.spacing = 12
        let grid = NSGridView(views: [
            [caption("Repository"), repoPopup],
            [caption("Branch"), branchField],
            [caption("Base"), baseField],
            [caption("Kind"), kind],
            [caption("Run on"), runOnPopup],
            [NSGridCell.emptyContentView, agentBox],
        ])
        runOnRow = grid.row(at: 4)
        grid.cell(for: runOnPopup)?.xPlacement = .leading
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 10
        grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        for r in 0..<grid.numberOfRows { grid.row(at: r).yPlacement = .center }
        grid.column(at: 1).width = 280

        let buttons = NSStackView(views: [cancelButton, createButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        for v in [title, grid, errorLabel, buttons] as [NSView] { content.addSubview(v) }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            grid.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 16),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -20),
            branchField.widthAnchor.constraint(equalToConstant: 280),
            baseField.widthAnchor.constraint(equalToConstant: 280),
            errorLabel.topAnchor.constraint(equalTo: grid.bottomAnchor, constant: 12),
            errorLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            errorLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            buttons.topAnchor.constraint(equalTo: errorLabel.bottomAnchor, constant: 12),
            buttons.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            buttons.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
        ])
        panel.initialFirstResponder = branchField
    }

    private var selectedGroup: RepoEnvironments? {
        let i = repoPopup.indexOfSelectedItem
        return groups.indices.contains(i) ? groups[i] : nil
    }

    @objc private func repoChangedAction() { repoChanged() }

    /// Container is offered only while the repository's container backend answers.
    private func repoChanged() {
        let available: Bool
        if case .unavailable = selectedGroup?.backend { available = false } else { available = selectedGroup != nil }
        containerRadio.isEnabled = available
        backendNote.stringValue = available ? "" : "Docker unavailable"
        if !available && containerRadio.state == .on {
            containerRadio.state = .off
            worktreeRadio.state = .on
        }
        createButton.isEnabled = selectedGroup != nil

        // Where a container can run, for this repository: this Mac and its remotes
        let (choices, selected) = selectedGroup.map(runOnChoices) ?? ([], 0)
        runOn = choices
        runOnPopup.removeAllItems()
        for c in choices {
            runOnPopup.addItem(withTitle: c.title)
            runOnPopup.lastItem?.isEnabled = c.available
        }
        if choices.indices.contains(selected) { runOnPopup.selectItem(at: selected) }
        updateRunOn()
    }

    /// The popup shows only for a container, and only when there is a remote to choose.
    private func updateRunOn() {
        runOnRow?.isHidden = runOn.isEmpty || containerRadio.state != .on
    }

    @objc private func kindChanged(_ sender: NSButton) {
        worktreeRadio.state = sender === worktreeRadio ? .on : .off
        containerRadio.state = sender === containerRadio ? .on : .off
        updateRunOn()
    }

    func controlTextDidChange(_ obj: Notification) { errorLabel.stringValue = "" }

    @objc private func create() {
        guard let group = selectedGroup else { return }
        let branch = branchField.stringValue.trimmingCharacters(in: .whitespaces)
        guard isValidBranchName(branch) else {
            errorLabel.stringValue = branch.isEmpty ? "Enter a branch name" : "“\(branch)” is not a valid branch name"
            window?.makeFirstResponder(branchField)
            return
        }
        let base = baseField.stringValue.trimmingCharacters(in: .whitespaces)
        // a base may be any ref (a tag, HEAD~2); it only must not read as an option
        if base.hasPrefix("-") || base.contains(where: \.isWhitespace) {
            errorLabel.stringValue = "“\(base)” is not a valid base"
            window?.makeFirstResponder(baseField)
            return
        }
        let kind: EnvironmentKind = containerRadio.state == .on ? .container : .worktree
        // nil when no remote is registered: kunj then picks the backend as it always did
        var remote: String?
        if kind == .container, runOn.indices.contains(runOnPopup.indexOfSelectedItem) {
            let choice = runOn[runOnPopup.indexOfSelectedItem]
            guard choice.available else {
                errorLabel.stringValue = "\(choice.title): choose a machine that answers"
                return
            }
            remote = choice.remote
        }
        let request = NewSessionRequest(repo: group.repo, branch: branch, base: base.isEmpty ? nil : base,
                                        kind: kind, startAgent: agentBox.state == .on, remote: remote)
        close(.OK)
        onCreate(request)
    }

    @objc private func cancel() { close(.cancel) }

    /// Selects Container, as a click on its radio would (`--new-session container --screenshot`).
    func selectContainer() {
        guard containerRadio.isEnabled else { return }
        kindChanged(containerRadio)
    }

    /// The sheet's content as a PNG (`--new-session <kind> --screenshot`).
    func snapshotPNG() -> Data? {
        guard let root = window?.contentView else { return nil }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).representation(using: .png, properties: [:])
    }

    private func close(_ code: NSApplication.ModalResponse) {
        guard let w = window else { return }
        if let parent = w.sheetParent { parent.endSheet(w, returnCode: code) } else { w.close() }
    }
}
