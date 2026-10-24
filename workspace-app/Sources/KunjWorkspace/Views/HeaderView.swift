import AppKit
import KunjWorkspaceCore

enum HeaderAction {
    case shell, agent, open, createPR
    /// The overflow button; the view is the anchor for its menu.
    case more(NSView)
}

/// The header (52 px): the branch (sans 14/600), the meta line (mono 11 `muted`, ` · ` in
/// `faintest`; the PR is a `link` opening its URL, ports open `http://localhost:<host>`), and the
/// actions right-aligned: Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O (outlined), Create PR ⌘⇧P (filled), `…`.
final class HeaderView: NSView {
    var onAction: (HeaderAction) -> Void = { _ in }
    /// Opens a URL (the PR, a port); the app passes NSWorkspace.open.
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// The plan of an action (the app's ActionRunner): Open in VS Code and Create PR are enabled
    /// by it, with the reason as the tooltip when not.
    var plan: (EnvAction, Environment) -> ActionPlan = { _, _ in .disabled(reason: "kunj is not ready") }
    var theme: Theme { didSet { apply() } }
    private(set) var environment: Environment?

    private let title = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.title, weight: .semibold), color: .clear)
    private let meta = NSStackView()
    private let shell: OutlinedButton
    private let agent: OutlinedButton
    private let open: OutlinedButton
    private let createPR: FilledButton
    private let more: ActionButton
    private var buttons: [ActionButton] { [shell, agent, open, createPR, more] }

    init(theme: Theme) {
        self.theme = theme
        shell = OutlinedButton("Shell", hint: "⌘T", icon: .shell, theme: theme)
        agent = OutlinedButton("Agent", hint: "⌘⇧A", theme: theme)
        open = OutlinedButton("Open in VS Code", hint: "⌘O", theme: theme)
        createPR = FilledButton("Create PR", hint: "⌘⇧P", theme: theme)
        more = ActionButton("More actions", icon: .dots, style: .iconOnly, theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        meta.orientation = .horizontal
        meta.spacing = 6
        meta.alignment = .firstBaseline
        meta.translatesAutoresizingMaskIntoConstraints = false
        meta.setHuggingPriority(.defaultLow, for: .horizontal)
        meta.setClippingResistancePriority(.defaultLow, for: .horizontal)

        let actions = NSStackView(views: buttons)
        actions.orientation = .horizontal
        actions.spacing = 6
        actions.translatesAutoresizingMaskIntoConstraints = false
        actions.setHuggingPriority(.required, for: .horizontal)
        for b in buttons { b.setContentCompressionResistancePriority(.required, for: .horizontal) }

        shell.onPress = { [weak self] in self?.onAction(.shell) }
        agent.onPress = { [weak self] in self?.onAction(.agent) }
        open.onPress = { [weak self] in self?.onAction(.open) }
        createPR.onPress = { [weak self] in self?.onAction(.createPR) }
        more.onPress = { [weak self] in if let self { self.onAction(.more(self.more)) } }

        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for v in [title, meta, actions] as [NSView] { addSubview(v) }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            title.bottomAnchor.constraint(equalTo: centerYAnchor, constant: 1),
            title.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -16),
            meta.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            meta.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 1),
            meta.trailingAnchor.constraint(lessThanOrEqualTo: actions.leadingAnchor, constant: -16),
            actions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            actions.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        apply()
        show(nil)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func apply() {
        title.textColor = theme.color(\.text)
        for b in buttons { b.theme = theme }
        show(environment)
    }

    /// Fills the header from an environment; nil hides its content.
    func show(_ env: Environment?) {
        environment = env
        for v in subviews { v.isHidden = env == nil }
        guard let env else { return }
        title.stringValue = env.branch
        title.setAccessibilityLabel("\(env.branch), \(env.statusVerb)")
        meta.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let font = Theme.mono(DesignTokens.TypeScale.caption)
        func part(_ s: String, _ color: NSColor) -> NSTextField {
            let l = makeLabel(s, font: font, color: color)
            l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return l
        }
        func link(_ s: String, _ url: URL) -> NSTextField {
            let l = LinkLabel(labelWithString: s)
            l.font = font
            l.textColor = theme.color(\.link)
            l.toolTip = url.absoluteString
            l.onClick = { [weak self] in self?.openURL(url) }
            l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return l
        }
        let sep = { part("·", self.theme.color(\.faintest)) }
        for (i, s) in env.metaLine.enumerated() {
            if i > 0 { meta.addArrangedSubview(sep()) }
            if i == 0, let r = s.range(of: " / ") {
                meta.addArrangedSubview(part(String(s[..<r.lowerBound]), theme.color(\.muted)))
                meta.addArrangedSubview(part("/", theme.color(\.faintest)))
                meta.addArrangedSubview(part(String(s[r.upperBound...]), theme.color(\.muted)))
            } else if s.hasPrefix("#"), let pr = env.pullRequest, let url = URL(string: pr.url) {
                meta.addArrangedSubview(link(s, url))
            } else if s.hasPrefix(":"), let port = Int(s.dropFirst()),
                      let url = URL(string: "http://localhost:\(port)") {
                meta.addArrangedSubview(link(s, url))
            } else {
                meta.addArrangedSubview(part(s, theme.color(\.muted)))
            }
        }
        let usable = env.state != .missing && env.state != .stopped
        shell.isEnabled = usable
        agent.isEnabled = usable
        shell.toolTip = usable ? nil : (env.kind == .container ? "Start the container first" : "The worktree directory is missing")
        agent.toolTip = shell.toolTip
        let openAction: EnvAction = env.kind == .container ? .ctOpen : .worktreeOpen
        for (button, action) in [(open as ActionButton, openAction), (createPR as ActionButton, EnvAction.createPR)] {
            if case .disabled(let reason) = plan(action, env) {
                button.isEnabled = false
                button.toolTip = reason
            } else {
                button.isEnabled = true
                button.toolTip = nil
            }
        }
        for b in buttons { b.needsDisplay = true }
    }
}
