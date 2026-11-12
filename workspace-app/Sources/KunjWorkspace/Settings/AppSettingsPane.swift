import AppKit
import KunjWorkspaceCore

extension Notification.Name {
    /// A view preference (`showFiles`, `showChanges`, `showEmptyRepos`) changed, from the View menu
    /// or from Settings; `object` is the UserDefaults key.
    static let viewPreferenceChanged = Notification.Name("kunjViewPreferenceChanged")
}

/// Settings › App: the app's own preferences, kept in UserDefaults and applied at once: the kunj
/// command (a change re-runs discovery), the theme (the default View > Theme writes too) and the
/// three view toggles the View menu also has (`AppDelegate.setViewPreference`).
@MainActor
final class AppSettingsPane: NSView, NSTextFieldDelegate {
    /// What search matches this pane on.
    static let searchTerms = ["app", "kunj command", "theme", "repositories", "sessions", "files column", "changes column", "editor", "auto save", "save on focus loss", "reload"]

    /// The kunj command changed (after editing ends): rediscover kunj with it.
    var onKunjCommandChanged: () -> Void = {}
    /// A view toggle was clicked: (UserDefaults key, on).
    var onViewPreference: (String, Bool) -> Void = { _, _ in }

    private let commandField = NSTextField()
    private let themePopup = NSPopUpButton()
    private let emptyReposBox = NSButton(checkboxWithTitle: "Show repositories with no sessions", target: nil, action: nil)
    private let filesBox = NSButton(checkboxWithTitle: "Show the Files column", target: nil, action: nil)
    private let changesBox = NSButton(checkboxWithTitle: "Show the Changes column", target: nil, action: nil)
    private let autoSaveBox = NSButton(checkboxWithTitle: "Save files when the editor loses focus", target: nil, action: nil)
    private var labels: [NSTextField] = []
    private var notes: [NSTextField] = []
    private var observer: NSObjectProtocol?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        func label(_ s: String) -> NSTextField {
            let l = makeLabel(s, font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
            l.alignment = .right
            labels.append(l)
            return l
        }
        func note(_ s: String) -> NSTextField {
            let l = NSTextField(wrappingLabelWithString: s)
            l.font = Theme.sans(DesignTokens.TypeScale.caption)
            l.isSelectable = false
            l.preferredMaxLayoutWidth = 320
            notes.append(l)
            return l
        }
        commandField.font = Theme.mono(12)
        commandField.placeholderString = "kunj"
        commandField.delegate = self
        commandField.translatesAutoresizingMaskIntoConstraints = false
        commandField.setAccessibilityLabel("kunj command")
        for c in ThemeChoice.allCases {
            themePopup.addItem(withTitle: c == .auto ? "Auto (light or warm, with the system)" : c.title)
            themePopup.lastItem?.representedObject = c.rawValue
        }
        themePopup.target = self
        themePopup.action = #selector(themeChosen)
        themePopup.setAccessibilityLabel("Theme")
        for b in [emptyReposBox, filesBox, changesBox] { b.target = self; b.action = #selector(viewToggled(_:)) }
        let view = NSStackView(views: [emptyReposBox, filesBox, changesBox, note("Also in the View menu.")])
        view.orientation = .vertical
        view.alignment = .leading
        view.spacing = 6
        autoSaveBox.target = self
        autoSaveBox.action = #selector(autoSaveToggled)
        let editor = NSStackView(views: [autoSaveBox, note("On a click elsewhere, another tab or another app. A file that changed on disk meanwhile is not overwritten. A file without unsaved edits always reloads when it changes on disk.")])
        editor.orientation = .vertical
        editor.alignment = .leading
        editor.spacing = 6
        let grid = NSGridView(views: [
            [label("kunj command"), commandField],
            [NSGridCell.emptyContentView, note("A command or path, e.g. node ~/src/kunj/dist/index.js. Empty: kunj on your login PATH.")],
            [label("Theme"), themePopup],
            [label("Window"), view],
            [label("Editor"), editor],
        ])
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 10
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 0).yPlacement = .center
        grid.row(at: 2).yPlacement = .center
        grid.row(at: 3).topPadding = 8
        grid.cell(atColumnIndex: 0, rowIndex: 3).yPlacement = .top
        grid.row(at: 4).topPadding = 8
        grid.cell(atColumnIndex: 0, rowIndex: 4).yPlacement = .top
        addSubview(grid)
        NSLayoutConstraint.activate([
            commandField.widthAnchor.constraint(equalToConstant: 320),
            grid.topAnchor.constraint(equalTo: topAnchor),
            grid.leadingAnchor.constraint(equalTo: leadingAnchor),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            grid.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        observer = NotificationCenter.default.addObserver(forName: .viewPreferenceChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Re-reads UserDefaults and the theme into the controls.
    func refresh() {
        let d = UserDefaults.standard
        if commandField.currentEditor() == nil {
            commandField.stringValue = d.string(forKey: SettingsWindow.kunjCommandKey) ?? ""
        }
        let raw = ThemeManager.shared.choice.rawValue
        if let item = themePopup.itemArray.first(where: { $0.representedObject as? String == raw }) {
            themePopup.select(item)
        }
        emptyReposBox.state = d.bool(forKey: AppDelegate.showEmptyReposKey) ? .on : .off
        filesBox.state = d.bool(forKey: AppDelegate.showFilesKey) ? .on : .off
        changesBox.state = d.bool(forKey: AppDelegate.showChangesKey) ? .on : .off
        autoSaveBox.state = d.bool(forKey: TabRegistry.autoSaveKey) ? .on : .off
    }

    func apply(_ t: Theme) {
        for l in labels { l.textColor = t.color(\.text2) }
        for n in notes { n.textColor = t.color(\.muted) }
        refresh()
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        let value = commandField.stringValue.trimmingCharacters(in: .whitespaces)
        let current = UserDefaults.standard.string(forKey: SettingsWindow.kunjCommandKey) ?? ""
        guard value != current else { return }
        if value.isEmpty {
            UserDefaults.standard.removeObject(forKey: SettingsWindow.kunjCommandKey)
        } else {
            UserDefaults.standard.set(value, forKey: SettingsWindow.kunjCommandKey)
        }
        onKunjCommandChanged()
    }

    @objc private func themeChosen() {
        guard let raw = themePopup.selectedItem?.representedObject as? String, let c = ThemeChoice(rawValue: raw) else { return }
        ThemeManager.shared.override = nil
        ThemeManager.shared.choice = c
    }

    @objc private func autoSaveToggled() {
        UserDefaults.standard.set(autoSaveBox.state == .on, forKey: TabRegistry.autoSaveKey)
    }

    @objc private func viewToggled(_ sender: NSButton) {
        let key = sender === emptyReposBox ? AppDelegate.showEmptyReposKey
            : sender === filesBox ? AppDelegate.showFilesKey : AppDelegate.showChangesKey
        onViewPreference(key, sender.state == .on)
    }
}
