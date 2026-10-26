import AppKit
import KunjWorkspaceCore

/// Settings (⌘,): the kunj command (`kunjCommand` default; a change re-runs discovery), the theme
/// (the `theme` default View > Theme writes too, applied at once) and two agent toggles that are
/// kunj's own settings (`agent.tmux`, `agent.tmuxStatus` in the global config), read with
/// `kunj config --get <key> --global --json` and written with `kunj config --set <key>=<bool> --global`.
/// A failed write shows inline and reverts the checkbox. Containers shows where a new container's
/// GitHub token comes from (`kunj ct token status --json`, a stored global `GH_TOKEN` winning),
/// the `container.useGhToken` toggle, and the Claude Code token (`kunj secret list --global
/// --json`), set up in an action tab of the selected environment (`claudeTokenSetupSpec`) and
/// removed with `kunj secret rm`. The app never sees a token: the hidden prompt of `kunj secret
/// set` in the tab takes it.
@MainActor
final class SettingsWindow: NSWindowController, NSTextFieldDelegate {
    static let kunjCommandKey = "kunjCommand"

    /// The kunj command changed (after editing ends): rediscover kunj with it.
    var onKunjCommandChanged: () -> Void = {}
    /// The CLI the agent toggles use (nil until discovery: they are disabled).
    var cli: KunjCLI? { didSet { if cli !== oldValue { loadAgentSettings(); loadContainerSettings() } } }
    /// The main window's selected environment (where Set Up… opens its action tab).
    var selectedEnvironment: () -> Environment? = { nil }
    /// Opens an action tab running `spec` in `env`; `onFinish` gets the exit code.
    var openAction: (Environment, TerminalSpec, @escaping (Int32) -> Void) -> Void = { _, _, _ in }

    private let content = FillView(.clear)
    private let commandField = NSTextField()
    private let themePopup = NSPopUpButton()
    private let tmuxBox = NSButton(checkboxWithTitle: "Run agents in tmux", target: nil, action: nil)
    private let statusBox = NSButton(checkboxWithTitle: "Show tmux status line", target: nil, action: nil)
    private let tmuxNote = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let agentError = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private let githubLine = makeLabel("…", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let useGhBox = NSButton(checkboxWithTitle: "Use gh's GitHub token", target: nil, action: nil)
    private let claudeLine = makeLabel("…", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let setUpButton = NSButton(title: "Set Up…", target: nil, action: nil)
    private let removeButton = NSButton(title: "Remove", target: nil, action: nil)
    private let testButton = NSButton(title: "Test", target: nil, action: nil)
    /// The last Test's answer (`kunj ct token check`), green when the token works, red when not.
    private let claudeCheck = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private var checking = false
    private var checkValid: Bool?
    private let containerError = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.caption), color: .clear)
    private var tokenStatus: TokenStatusJson?
    private var globalSecrets: SecretListJson?
    private var containerLoad = 0
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
        loadContainerSettings()
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
        for b in [tmuxBox, statusBox, useGhBox] { b.target = self; b.action = #selector(agentToggled(_:)) }
        tmuxNote.lineBreakMode = .byWordWrapping
        tmuxNote.maximumNumberOfLines = 2
        agentError.lineBreakMode = .byWordWrapping
        agentError.maximumNumberOfLines = 3
        agentError.preferredMaxLayoutWidth = 300

        let agents = NSStackView(views: [tmuxBox, tmuxNote, statusBox, note("kunj settings, shared with the CLI; they apply to agents started afterwards."), agentError])
        agents.orientation = .vertical
        agents.alignment = .leading
        agents.spacing = 6

        for b in [setUpButton, testButton, removeButton] { b.bezelStyle = .rounded; b.controlSize = .small; b.target = self }
        testButton.action = #selector(testClaudeToken)
        testButton.setAccessibilityLabel("Test the Claude Code token")
        testButton.toolTip = "Run Claude Code once with the token new containers get (kunj ct token check)"
        claudeCheck.lineBreakMode = .byWordWrapping
        claudeCheck.maximumNumberOfLines = 3
        claudeCheck.preferredMaxLayoutWidth = 300
        claudeCheck.isHidden = true
        setUpButton.action = #selector(setUpClaudeToken)
        removeButton.action = #selector(removeClaudeToken)
        setUpButton.setAccessibilityLabel("Set up the Claude Code token")
        removeButton.setAccessibilityLabel("Remove the Claude Code token")
        containerError.lineBreakMode = .byWordWrapping
        containerError.maximumNumberOfLines = 3
        containerError.preferredMaxLayoutWidth = 300
        let githubTitle = label("GitHub token")
        githubTitle.alignment = .left
        let claudeTitle = label("Claude Code token")
        claudeTitle.alignment = .left
        let claudeRow = NSStackView(views: [claudeLine, setUpButton, testButton, removeButton])
        claudeRow.orientation = .horizontal
        claudeRow.spacing = 8
        let containers = NSStackView(views: [githubTitle, githubLine, useGhBox, claudeTitle, claudeRow, claudeCheck,
                                             note("Containers get these tokens; the agent inside can use them."), containerError])
        containers.orientation = .vertical
        containers.alignment = .leading
        containers.spacing = 6
        containers.setCustomSpacing(12, after: useGhBox)
        let grid = NSGridView(views: [
            [label("kunj command"), commandField],
            [NSGridCell.emptyContentView, note("A command or path, e.g. node ~/src/kunj/dist/index.js. Empty: kunj on your login PATH.")],
            [label("Theme"), themePopup],
            [label("Agents"), agents],
            [label("Containers"), containers],
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
        content.addSubview(grid)
        NSLayoutConstraint.activate([
            commandField.widthAnchor.constraint(equalToConstant: 300),
            grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -24),
            grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
        ])
        renderAgents()
        renderContainers()
    }

    private func apply(_ t: Theme) {
        window?.appearance = t.appearance
        content.color = t.color(\.bg)
        for l in labels { l.textColor = t.color(\.text2) }
        for n in notes { n.textColor = t.color(\.muted) }
        tmuxNote.textColor = t.color(\.muted)
        agentError.textColor = t.color(\.red)
        containerError.textColor = t.color(\.red)
        githubLine.textColor = t.color(\.text)
        claudeLine.textColor = t.color(\.text)
        renderCheck()
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
        renderContainers()
    }

    @objc private func agentToggled(_ sender: NSButton) {
        guard let cli else { return }
        let setting: KunjSetting = sender === tmuxBox ? .agentTmux : sender === useGhBox ? .containerUseGhToken : .agentTmuxStatus
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
            // whether gh is asked changes where the GitHub token comes from
            if setting == .containerUseGhToken { self.loadContainerSettings() }
        }
    }

    // MARK: container tokens

    /// Reads where the GitHub token comes from and the global secrets (both in the home
    /// directory: outside a repository the token status is for github.com). A later load wins.
    private func loadContainerSettings() {
        containerLoad += 1
        let load = containerLoad
        guard let cli else { tokenStatus = nil; globalSecrets = nil; renderContainers(); return }
        containerError.stringValue = ""
        Task { @MainActor in
            var errors: [String] = []
            async let status: TokenStatusJson = cli.run(tokenStatusArgs, cwd: NSHomeDirectory(), timeout: 30)
            async let list: SecretListJson = cli.run(globalSecretListArgs, cwd: NSHomeDirectory(), timeout: 60)
            var s: TokenStatusJson?
            var l: SecretListJson?
            do { s = try await status } catch { errors.append("Could not read the GitHub token status: \(Self.message(error))") }
            do { l = try await list } catch { errors.append("Could not read the stored secrets: \(Self.message(error))") }
            guard load == self.containerLoad else { return }
            self.tokenStatus = s
            self.globalSecrets = l
            self.containerError.stringValue = errors.joined(separator: "\n")
            self.renderContainers()
        }
    }

    private static func message(_ error: Error) -> String {
        (error as? KunjCLIError)?.message ?? "\(error)"
    }

    private func renderContainers() {
        githubLine.stringValue = githubTokenSummary(status: tokenStatus, secrets: globalSecrets) ?? (cli == nil ? "kunj not found" : "…")
        let claude = claudeTokenSummary(secrets: globalSecrets)
        claudeLine.stringValue = claude ?? (cli == nil ? "kunj not found" : "…")
        let useGh = values[.containerUseGhToken]
        useGhBox.state = (useGh ?? KunjSetting.containerUseGhToken.defaultValue) ? .on : .off
        useGhBox.isEnabled = cli != nil && useGh != nil && !writing
        setUpButton.isEnabled = cli != nil
        removeButton.isEnabled = cli != nil && claude == "Stored secret"
        testButton.isEnabled = cli != nil && !checking
    }

    /// Runs `kunj ct token check --json` in the home directory (the global token; a repo or branch
    /// one would be found only in that repository) and shows its answer under the row.
    @objc private func testClaudeToken() {
        guard let cli, !checking else { return }
        checking = true
        checkValid = nil
        claudeCheck.stringValue = "Checking with Claude Code…"
        renderCheck()
        renderContainers()
        Task { @MainActor in
            do {
                let check: TokenCheckJson = try await cli.run(claudeTokenCheckArgs, cwd: NSHomeDirectory(), timeout: 120)
                self.checkValid = check.claude.valid
                self.claudeCheck.stringValue = claudeTokenCheckText(check)
                log("kunj ct token check: \(check.claude.valid.map { "\($0)" } ?? "null")")
            } catch {
                self.checkValid = false
                self.claudeCheck.stringValue = "Could not check the token: \(Self.message(error))"
            }
            self.checking = false
            self.renderCheck()
            self.renderContainers()
        }
    }

    private func renderCheck() {
        let t = ThemeManager.shared.current
        claudeCheck.isHidden = claudeCheck.stringValue.isEmpty
        claudeCheck.textColor = checking ? t.color(\.muted) : checkValid == true ? t.color(\.green)
            : checkValid == false ? t.color(\.red) : t.color(\.muted)
    }

    /// The selected environment, whose tab runs a token action; nil (with an alert) when none is.
    private func environmentForTokenTab(_ verb: String, button: String) -> Environment? {
        if let env = selectedEnvironment() { return env }
        let a = NSAlert()
        a.messageText = "Select an environment first"
        a.informativeText = "The Claude Code token is \(verb) in a terminal tab of the selected environment. Select a worktree or container in the sidebar, then choose \(button) again."
        a.alertStyle = .informational
        if let w = window { a.beginSheetModal(for: w) } else { a.runModal() }
        return nil
    }

    @objc private func setUpClaudeToken() {
        guard let cli, let env = environmentForTokenTab("set up", button: "Set Up…") else { return }
        let spec = claudeTokenSetupSpec(cli: cli, env: env, terminalEnv: ProcessInfo.processInfo.environment)
        log("claude token setup tab in \(env.id)")
        openAction(env, spec) { [weak self] _ in self?.loadContainerSettings() }
    }

    @objc private func removeClaudeToken() {
        guard let cli, let window else { return }
        let a = NSAlert()
        a.messageText = "Remove the stored Claude Code token?"
        a.informativeText = "New containers no longer get CLAUDE_CODE_OAUTH_TOKEN. Containers that have it keep it until they are rebuilt."
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            self.containerError.stringValue = ""
            Task { @MainActor in
                do {
                    let out = try await cli.runRaw(claudeTokenRemoveArgs, cwd: NSHomeDirectory(), stdin: nil, timeout: 60)
                    if out.exit != 0 {
                        throw KunjCLIError(code: .commandFailed,
                                           message: out.stderr.split(separator: "\n").last.map(String.init) ?? "kunj exited with code \(out.exit)")
                    }
                    log("kunj secret rm \(claudeTokenName) --global")
                } catch {
                    self.containerError.stringValue = "Could not remove the token: \(Self.message(error))"
                }
                self.loadContainerSettings()
            }
        }
    }
}
