import AppKit
import KunjWorkspaceCore

/// Settings › Containers, above the container settings: where a new container's GitHub token comes
/// from (`kunj ct token status --json`, a stored global `GH_TOKEN` winning) and the Claude Code
/// token (`kunj secret list --global --json`), set up in an action tab of the selected environment
/// (`claudeTokenSetupSpec`), tested with `kunj ct token check` and removed with `kunj secret rm`.
/// The app never sees a token: the hidden prompt of `kunj secret set` in the tab takes it.
/// `container.useGhToken` is drawn here too, as the row the window hands in (`useGhRow`).
@MainActor
final class ContainerTokensView: NSView {
    /// The CLI (nil until discovery: the buttons are disabled).
    var cli: KunjCLI? { didSet { if cli !== oldValue { reload() } } }
    /// The main window's selected environment (where Set Up… opens its action tab).
    var selectedEnvironment: () -> Environment? = { nil }
    /// Opens an action tab running `spec` in `env`; `onFinish` gets the exit code.
    var openAction: (Environment, TerminalSpec, @escaping (Int32) -> Void) -> Void = { _, _, _ in }
    /// The `container.useGhToken` row, shown under the GitHub line.
    var useGhRow: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            guard let useGhRow else { return }
            let at = (stack.arrangedSubviews.firstIndex(of: githubLine) ?? 0) + 1
            stack.insertArrangedSubview(useGhRow, at: at)
            useGhRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            stack.setCustomSpacing(12, after: useGhRow)
        }
    }

    private let stack = NSStackView()
    private let githubTitle = makeLabel("GitHub token", font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium), color: .clear)
    private let claudeTitle = makeLabel("Claude Code token", font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium), color: .clear)
    private let githubLine = makeLabel("…", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let claudeLine = makeLabel("…", font: Theme.sans(DesignTokens.TypeScale.small), color: .clear)
    private let setUpButton = NSButton(title: "Set Up…", target: nil, action: nil)
    private let removeButton = NSButton(title: "Remove", target: nil, action: nil)
    private let testButton = NSButton(title: "Test", target: nil, action: nil)
    /// The last Test's answer (`kunj ct token check`), green when the token works, red when not.
    private let claudeCheck = NSTextField(wrappingLabelWithString: "")
    private let note = NSTextField(wrappingLabelWithString: "Containers get these tokens; the agent inside can use them.")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private var checking = false
    private var checkValid: Bool?
    /// Bumped when the stored token changes (Set Up…, Remove): a check still running then is dropped.
    private var checkGeneration = 0
    private var tokenStatus: TokenStatusJson?
    private var globalSecrets: SecretListJson?
    private var loadCount = 0

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for b in [setUpButton, testButton, removeButton] { b.bezelStyle = .rounded; b.controlSize = .small; b.target = self }
        testButton.action = #selector(testClaudeToken)
        testButton.setAccessibilityLabel("Test the Claude Code token")
        testButton.toolTip = "Run Claude Code once with the token new containers get (kunj ct token check)"
        setUpButton.action = #selector(setUpClaudeToken)
        removeButton.action = #selector(removeClaudeToken)
        setUpButton.setAccessibilityLabel("Set up the Claude Code token")
        removeButton.setAccessibilityLabel("Remove the Claude Code token")
        for l in [claudeCheck, note, errorLabel] {
            l.font = Theme.sans(DesignTokens.TypeScale.caption)
            l.isSelectable = false
        }
        claudeCheck.isHidden = true
        errorLabel.isHidden = true
        let claudeRow = NSStackView(views: [claudeLine, setUpButton, testButton, removeButton])
        claudeRow.orientation = .horizontal
        claudeRow.spacing = 8
        for v in [githubTitle, githubLine, claudeTitle, claudeRow, claudeCheck, note, errorLabel] { stack.addArrangedSubview(v) }
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.setCustomSpacing(12, after: githubLine)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        render()
    }
    required init?(coder: NSCoder) { fatalError() }

    func apply(_ t: Theme) {
        githubTitle.textColor = t.color(\.text)
        claudeTitle.textColor = t.color(\.text)
        githubLine.textColor = t.color(\.text2)
        claudeLine.textColor = t.color(\.text2)
        note.textColor = t.color(\.muted)
        errorLabel.textColor = t.color(\.red)
        renderCheck()
    }

    /// Reads where the GitHub token comes from and the global secrets (both in the home
    /// directory: outside a repository the token status is for github.com). A later load wins.
    func reload() {
        loadCount += 1
        let load = loadCount
        guard let cli else { tokenStatus = nil; globalSecrets = nil; render(); return }
        setError("")
        Task { @MainActor in
            var errors: [String] = []
            async let status: TokenStatusJson = cli.run(tokenStatusArgs, cwd: NSHomeDirectory(), timeout: 30)
            async let list: SecretListJson = cli.run(globalSecretListArgs, cwd: NSHomeDirectory(), timeout: 60)
            var s: TokenStatusJson?
            var l: SecretListJson?
            do { s = try await status } catch { errors.append("Could not read the GitHub token status: \(Self.message(error))") }
            do { l = try await list } catch { errors.append("Could not read the stored secrets: \(Self.message(error))") }
            guard load == self.loadCount else { return }
            self.tokenStatus = s
            self.globalSecrets = l
            self.setError(errors.joined(separator: "\n"))
            self.render()
        }
    }

    private static func message(_ error: Error) -> String {
        (error as? KunjCLIError)?.message ?? "\(error)"
    }

    private func setError(_ text: String) {
        errorLabel.stringValue = text
        errorLabel.isHidden = text.isEmpty
    }

    private func render() {
        githubLine.stringValue = githubTokenSummary(status: tokenStatus, secrets: globalSecrets) ?? (cli == nil ? "kunj not found" : "…")
        let claude = claudeTokenSummary(secrets: globalSecrets)
        claudeLine.stringValue = claude ?? (cli == nil ? "kunj not found" : "…")
        setUpButton.isEnabled = cli != nil
        removeButton.isEnabled = cli != nil && claude == "Stored secret"
        testButton.isEnabled = cli != nil && !checking
    }

    /// Runs `kunj ct token check --json` in the home directory (the global token; a repo or branch
    /// one would be found only in that repository) and shows its answer under the row.
    @objc private func testClaudeToken() {
        guard let cli, !checking else { return }
        checking = true
        let generation = checkGeneration
        checkValid = nil
        claudeCheck.stringValue = "Checking with Claude Code…"
        renderCheck()
        render()
        Task { @MainActor in
            do {
                let check: TokenCheckJson = try await cli.run(claudeTokenCheckArgs, cwd: NSHomeDirectory(), timeout: 120)
                guard generation == self.checkGeneration else { return self.checkDone() }
                self.checkValid = check.claude.valid
                self.claudeCheck.stringValue = claudeTokenCheckText(check)
                log("kunj ct token check: \(check.claude.valid.map { "\($0)" } ?? "null")")
            } catch {
                guard generation == self.checkGeneration else { return self.checkDone() }
                self.checkValid = false
                self.claudeCheck.stringValue = "Could not check the token: \(Self.message(error))"
            }
            self.checkDone()
        }
    }

    private func checkDone() {
        checking = false
        renderCheck()
        render()
    }

    /// The stored token changed: the last Test's answer no longer applies.
    private func clearCheck() {
        checkGeneration += 1
        checkValid = nil
        claudeCheck.stringValue = ""
        checkDone()
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
        openAction(env, spec) { [weak self] _ in self?.clearCheck(); self?.reload() }
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
            self.setError("")
            Task { @MainActor in
                do {
                    let out = try await cli.runRaw(claudeTokenRemoveArgs, cwd: NSHomeDirectory(), stdin: nil, timeout: 60)
                    if out.exit != 0 {
                        throw KunjCLIError(code: .commandFailed,
                                           message: out.stderr.split(separator: "\n").last.map(String.init) ?? "kunj exited with code \(out.exit)")
                    }
                    log("kunj secret rm \(claudeTokenName) --global")
                    self.clearCheck()
                } catch {
                    self.setError("Could not remove the token: \(Self.message(error))")
                }
                self.reload()
            }
        }
    }
}
