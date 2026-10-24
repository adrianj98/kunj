import AppKit
import KunjWorkspaceCore

/// The left column under the header: the tab bar (40 px, a `border` hairline under it) over the
/// terminal area in `term`. It holds every open tab's view of every environment (the registry's),
/// shows the selected environment's active tab and keeps the others hidden, so their processes
/// and scrollback are never touched by switching. An inline message (a refused Shell or Agent)
/// or a hint replaces the terminal when there is nothing to show.
final class TerminalColumn: NSView {
    var theme: Theme { didSet { apply() } }
    private(set) var environment: Environment?
    let registry: TabRegistry
    /// The tab bar's `+`.
    var onNewTab: () -> Void = {}

    private let tabBar: TabBarView
    private let barLine = FillView(.clear)
    private let body = FillView(.clear)
    private let message = makeLabel("", font: Theme.sans(DesignTokens.TypeScale.body), color: .clear)
    private let hint = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private var messageText: String?
    private var timer: Timer?

    /// The terminal's padding inside the column (warm.html: 16px 20px).
    static let insetY: CGFloat = 16
    static let insetX: CGFloat = 20

    init(theme: Theme) {
        self.theme = theme
        registry = TabRegistry(theme: theme)
        tabBar = TabBarView(theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for v in [tabBar, barLine, body] as [NSView] { addSubview(v) }
        for v in [message, hint] { body.addSubview(v); v.alignment = .center }
        NSLayoutConstraint.activate([
            tabBar.topAnchor.constraint(equalTo: topAnchor),
            tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            tabBar.heightAnchor.constraint(equalToConstant: DesignTokens.Layout.tabbarHeight),
            barLine.topAnchor.constraint(equalTo: tabBar.bottomAnchor),
            barLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            barLine.trailingAnchor.constraint(equalTo: trailingAnchor),
            barLine.heightAnchor.constraint(equalToConstant: 1),
            body.topAnchor.constraint(equalTo: barLine.bottomAnchor),
            body.leadingAnchor.constraint(equalTo: leadingAnchor),
            body.trailingAnchor.constraint(equalTo: trailingAnchor),
            body.bottomAnchor.constraint(equalTo: bottomAnchor),
            message.centerXAnchor.constraint(equalTo: body.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: body.centerYAnchor, constant: -10),
            message.leadingAnchor.constraint(greaterThanOrEqualTo: body.leadingAnchor, constant: 24),
            hint.centerXAnchor.constraint(equalTo: body.centerXAnchor),
            hint.topAnchor.constraint(equalTo: message.bottomAnchor, constant: 6),
            hint.leadingAnchor.constraint(greaterThanOrEqualTo: body.leadingAnchor, constant: 24),
        ])
        tabBar.onSelect = { [weak self] id in
            guard let self, let tab = self.tab(id: id) else { return }
            self.registry.activate(tab)
            self.focusActive()
        }
        tabBar.onClose = { [weak self] id in
            guard let self, let tab = self.tab(id: id) else { return }
            self.registry.close(tab)
        }
        tabBar.onNewTab = { [weak self] in self?.onNewTab() }
        registry.onChange = { [weak self] envId in
            guard let self else { return }
            if envId == self.environment?.id { self.messageText = nil }
            self.sync()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.syncBar() }
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    /// The selected environment (nil: nothing selected). Called on every store change too, so the
    /// tab dots follow the agent's state.
    func show(_ env: Environment?) {
        if env?.id != environment?.id { messageText = nil }
        environment = env
        sync()
    }

    /// An inline message in place of the terminal ("Start the container first"); nil clears it.
    func showMessage(_ text: String?) {
        messageText = text
        sync()
    }

    var activeTab: TerminalTab? { environment.flatMap { registry.active(for: $0.id) } }

    /// Gives the active terminal the keyboard.
    func focusActive() {
        guard let tab = activeTab, !tab.inBackground else { return }
        window?.makeFirstResponder(tab)
    }

    private func tab(id: String) -> TerminalTab? {
        guard let env = environment else { return nil }
        return registry.tabs(for: env.id).first { $0.id == id }
    }

    private func sync() {
        let active = activeTab
        for tab in registry.allTabs {
            place(tab)
            tab.inBackground = tab !== active
        }
        let hasTabs = environment.map { !registry.tabs(for: $0.id).isEmpty } ?? false
        if let messageText {
            message.stringValue = messageText
            hint.stringValue = "⌘T shell · ⌘⇧A agent"
        } else {
            message.stringValue = "No terminal open"
            hint.stringValue = "⌘T shell · ⌘⇧A agent"
        }
        let showMessage = environment != nil && (messageText != nil || !hasTabs)
        message.isHidden = !showMessage
        hint.isHidden = !showMessage
        active?.inBackground = messageText != nil
        syncBar()
    }

    private func syncBar() {
        guard let env = environment else { tabBar.show([], tmux: nil); return }
        let tabs = registry.tabs(for: env.id)
        let active = registry.active(for: env.id)
        let items = tabs.map { t in
            TabBarItem(id: t.id, title: t.title,
                       dot: tabDot(kind: t.kind, running: t.running || t.spec == nil, agent: env.agent),
                       active: t === active,
                       toolTip: t.exited.map { "exited with code \($0)" } ?? t.programTitle)
        }
        var tmux: String?
        if let agentTab = tabs.first(where: { $0.kind == .agent }) {
            let session = env.agentSession ?? (env.kind == .container ? "agent" : nil)
            let up = uptime(since: agentTab.startedAt)
            tmux = session.map { "tmux \($0) · \(up)" } ?? up
        }
        tabBar.show(items, tmux: tmux)
    }

    private func place(_ tab: TerminalTab) {
        guard tab.superview !== body else { return }
        tab.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(tab)
        NSLayoutConstraint.activate([
            tab.topAnchor.constraint(equalTo: body.topAnchor, constant: Self.insetY),
            tab.leadingAnchor.constraint(equalTo: body.leadingAnchor, constant: Self.insetX),
            tab.trailingAnchor.constraint(equalTo: body.trailingAnchor, constant: -Self.insetX / 2),
            tab.bottomAnchor.constraint(equalTo: body.bottomAnchor, constant: -Self.insetY / 2),
        ])
    }

    private func apply() {
        tabBar.theme = theme
        registry.theme = theme
        barLine.color = theme.color(\.border)
        body.color = theme.color(\.term)
        message.textColor = theme.color(\.muted)
        hint.textColor = theme.color(\.faint)
        sync()
    }
}
