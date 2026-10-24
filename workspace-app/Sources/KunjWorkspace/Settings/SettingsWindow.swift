import AppKit
import KunjWorkspaceCore

/// Settings (⌘,): the kunj command (`kunjCommand` default; a change re-runs discovery), the theme
/// (the `theme` default View > Theme writes too, applied at once) and two agent toggles that are
/// kunj's own settings (`agent.tmux`, `agent.tmuxStatus` in the global config), read with
/// `kunj config --get <key> --global --json` and written with `kunj config --set <key>=<bool> --global`.
/// A failed write shows inline and reverts the checkbox.
@MainActor
final class SettingsWindow: NSWindowController, NSTextFieldDelegate {
    static let kunjCommandKey = "kunjCommand"

    /// The kunj command changed (after editing ends): rediscover kunj with it.
    var onKunjCommandChanged: () -> Void = {}
    /// The CLI the agent toggles use (nil until discovery: they are disabled).
    var cli: KunjCLI? { didSet { if cli !== oldValue { loadAgentSettings() } } }

    private let content = FillView(.clear)
    private let commandField = NSTextField()
    private let themePopup = NSPopUpButton()
    private let tmuxBox = NSButton(checkboxWithTitle: "Run agents in tmux", target: nil, action: nil)
    private let statusBox = NSButton(checkboxWithTitle: "Show tmux status line", target: nil, action: nil)
    private let tmuxNote = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let agentError = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private var labels: [NSTextField] = []
    private var notes: [NSTextField] = []
    private var values: [KunjSetting: Bool] = [:]
    private var writing = false

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                              styleMask: [.titled, .closable], backing: .buffered, defer: true)
        window.title = "Settings"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        build(window)
        ThemeManager.shared.onChange.append { [weak self] t in self?.apply(t) }
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        commandField.stringValue = UserDefaults.standard.string(forKey: Self.kunjCommandKey) ?? ""
        selectTheme()
        loadAgentSettings()
        if window?.isVisible != true { window?.center() }
        super.showWindow(sender)
    }

    // MARK: layout

    private func build(_ window: NSWindow) {
        window.contentView = content
        func label(_ s: String) -> NSTextField {
            let l = makeLabel(s, font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
            l.alignment = .right
            labels.append(l)
            return l
        }
        func note(_ s: String) -> NSTextField {
            let l = makeLabel(s, font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
            l.lineBreakMode = .byWordWrapping
            l.maximumNumberOfLines = 3
            l.preferredMaxLayoutWidth = 300
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
        for b in [tmuxBox, statusBox] { b.target = self; b.action = #selector(agentToggled(_:)) }
        tmuxNote.lineBreakMode = .byWordWrapping
        tmuxNote.maximumNumberOfLines = 2
        agentError.lineBreakMode = .byWordWrapping
        agentError.maximumNumberOfLines = 3
        agentError.preferredMaxLayoutWidth = 300

        let agents = NSStackView(views: [tmuxBox, tmuxNote, statusBox, note("kunj settings, shared with the CLI; they apply to agents started afterwards."), agentError])
        agents.orientation = .vertical
        agents.alignment = .leading
        agents.spacing = 6
        let grid = NSGridView(views: [
            [label("kunj command"), commandField],
            [NSGridCell.emptyContentView, note("A command or path, e.g. node ~/src/kunj/dist/index.js. Empty: kunj on your login PATH.")],
            [label("Theme"), themePopup],
            [label("Agents"), agents],
        ])
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 10
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 0).yPlacement = .center
        grid.row(at: 2).yPlacement = .center
        grid.row(at: 3).topPadding = 8
        grid.cell(atColumnIndex: 0, rowIndex: 3).yPlacement = .top
        content.addSubview(grid)
        NSLayoutConstraint.activate([
            commandField.widthAnchor.constraint(equalToConstant: 300),
            grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -24),
            grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
        ])
        renderAgents()
    }

    private func apply(_ t: Theme) {
        window?.appearance = t.appearance
        content.color = t.color(\.bg)
        for l in labels { l.textColor = t.color(\.text2) }
        for n in notes { n.textColor = t.color(\.muted) }
        tmuxNote.textColor = t.color(\.muted)
        agentError.textColor = t.color(\.red)
        selectTheme()
    }

    // MARK: kunj command

    func controlTextDidEndEditing(_ obj: Notification) {
        let value = commandField.stringValue.trimmingCharacters(in: .whitespaces)
        let current = UserDefaults.standard.string(forKey: Self.kunjCommandKey) ?? ""
        guard value != current else { return }
        if value.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.kunjCommandKey)
        } else {
            UserDefaults.standard.set(value, forKey: Self.kunjCommandKey)
        }
        onKunjCommandChanged()
    }

    // MARK: theme

    private func selectTheme() {
        let raw = ThemeManager.shared.choice.rawValue
        if let item = themePopup.itemArray.first(where: { $0.representedObject as? String == raw }) {
            themePopup.select(item)
        }
    }

    @objc private func themeChosen() {
        guard let raw = themePopup.selectedItem?.representedObject as? String, let c = ThemeChoice(rawValue: raw) else { return }
        ThemeManager.shared.override = nil
        ThemeManager.shared.choice = c
    }

    // MARK: agent settings

    private func loadAgentSettings() {
        guard let cli else { values = [:]; renderAgents(); return }
        agentError.stringValue = ""
        Task { @MainActor in
            for setting in KunjSetting.allCases {
                do {
                    let json: ConfigValueJson = try await cli.run(configGetArgs(setting), cwd: NSHomeDirectory(), timeout: 30)
                    self.values[setting] = json.bool ?? setting.defaultValue
                } catch {
                    self.values[setting] = nil
                    self.agentError.stringValue = "Could not read \(setting.rawValue): \((error as? KunjCLIError)?.message ?? "\(error)")"
                }
            }
            self.renderAgents()
        }
    }

    private func renderAgents() {
        let tmux = values[.agentTmux]
        let status = values[.agentTmuxStatus]
        tmuxBox.state = (tmux ?? KunjSetting.agentTmux.defaultValue) ? .on : .off
        statusBox.state = (status ?? KunjSetting.agentTmuxStatus.defaultValue) ? .on : .off
        tmuxBox.isEnabled = cli != nil && tmux != nil && !writing
        statusBox.isEnabled = cli != nil && status != nil && tmux == true && !writing
        tmuxNote.stringValue = tmux == false ? "Agents stop when their tab closes" : ""
        tmuxNote.isHidden = tmux != false
    }

    @objc private func agentToggled(_ sender: NSButton) {
        guard let cli else { return }
        let setting: KunjSetting = sender === tmuxBox ? .agentTmux : .agentTmuxStatus
        let value = sender.state == .on
        let previous = values[setting]
        values[setting] = value
        writing = true
        agentError.stringValue = ""
        renderAgents()
        Task { @MainActor in
            do {
                let out = try await cli.runRaw(configSetArgs(setting, value), cwd: NSHomeDirectory(), stdin: nil, timeout: 30)
                if out.exit != 0 {
                    throw KunjCLIError(code: .commandFailed,
                                       message: out.stderr.split(separator: "\n").last.map(String.init) ?? "kunj exited with code \(out.exit)")
                }
                log("kunj config: \(setting.rawValue)=\(value)")
            } catch {
                self.values[setting] = previous
                self.agentError.stringValue = "Could not change \(setting.rawValue): \((error as? KunjCLIError)?.message ?? "\(error)")"
            }
            self.writing = false
            self.renderAgents()
        }
    }
}
