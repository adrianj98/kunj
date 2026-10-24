import AppKit
import KunjWorkspaceCore

/// Every open terminal tab, per environment id, and which one is active in each. The views are
/// created here and placed by the TerminalColumn; closing a tab ends its process.
@MainActor
final class TabRegistry {
    private var tabsByEnv: [String: [TerminalTab]] = [:]
    private var activeByEnv: [String: String] = [:]
    private var counters: [String: Int] = [:]
    var theme: Theme {
        didSet { for t in allTabs { t.apply(theme) } }
    }
    /// Called after tabs were opened, closed, activated or changed state; the argument is the
    /// environment id whose tabs changed.
    var onChange: ((String) -> Void)?

    init(theme: Theme) {
        self.theme = theme
    }

    var allTabs: [TerminalTab] { tabsByEnv.values.flatMap { $0 } }

    func tabs(for envId: String) -> [TerminalTab] { tabsByEnv[envId] ?? [] }

    func active(for envId: String) -> TerminalTab? {
        let tabs = tabs(for: envId)
        return tabs.first { $0.id == activeByEnv[envId] } ?? tabs.first
    }

    /// Opens a tab running `spec` in `env` and makes it active.
    @discardableResult
    func open(spec: TerminalSpec, env: Environment, kind: TabKind) -> TerminalTab {
        let tab = makeTab(env: env, kind: kind, title: spec.title, spec: spec)
        tab.start()
        // after start, so the tab bar sees the process running (its dot)
        onChange?(env.id)
        return tab
    }

    /// A tab without a process showing `text` (`--demo`).
    @discardableResult
    func openDemo(env: Environment, kind: TabKind, title: String, text: String) -> TerminalTab {
        let tab = makeTab(env: env, kind: kind, title: title, spec: nil)
        tab.show(text: text)
        onChange?(env.id)
        return tab
    }

    private func makeTab(env: Environment, kind: TabKind, title: String, spec: TerminalSpec?) -> TerminalTab {
        let key = "\(env.id)#\(kind.rawValue)"
        let n = (counters[key] ?? 0) + 1
        counters[key] = n
        let tab = TerminalTab(id: "\(key)#\(n)", envId: env.id, kind: kind, title: title, spec: spec, theme: theme)
        tab.onExit = { [weak self] t in self?.exited(t) }
        tab.onTitle = { [weak self] t in self?.onChange?(t.envId) }
        tabsByEnv[env.id, default: []].append(tab)
        activeByEnv[env.id] = tab.id
        return tab
    }

    func activate(_ tab: TerminalTab) {
        guard activeByEnv[tab.envId] != tab.id else { return }
        activeByEnv[tab.envId] = tab.id
        onChange?(tab.envId)
    }

    /// The next (`by` 1) or previous (-1) tab of the environment, wrapping.
    func cycle(envId: String, by step: Int) {
        let tabs = tabs(for: envId)
        guard tabs.count > 1, let current = active(for: envId),
              let i = tabs.firstIndex(where: { $0 === current }) else { return }
        activate(tabs[(i + step + tabs.count) % tabs.count])
    }

    /// Ends the tab's process and removes it; the tab to its left (else right) becomes active.
    func close(_ tab: TerminalTab) {
        guard var tabs = tabsByEnv[tab.envId], let i = tabs.firstIndex(where: { $0 === tab }) else { return }
        tab.onExit = nil
        tab.close()
        tab.removeFromSuperview()
        tabs.remove(at: i)
        tabsByEnv[tab.envId] = tabs.isEmpty ? nil : tabs
        if activeByEnv[tab.envId] == tab.id {
            activeByEnv[tab.envId] = tabs.isEmpty ? nil : tabs[max(0, i - 1)].id
        }
        onChange?(tab.envId)
    }

    /// Ends every tab's process (the app is quitting). tmux sessions stay: `tmux attach` only detaches.
    func closeAll() {
        for tab in allTabs {
            tab.onExit = nil
            tab.close()
        }
    }

    /// A shell that exits 0 (`exit`) and an action whose spec says so close themselves; any other
    /// tab stays, with the exit status printed, so its output can be read.
    private func exited(_ tab: TerminalTab) {
        let code = tab.exited ?? -1
        if code == 0 && (tab.kind == .shell || tab.spec?.closeOnExitZero == true) {
            close(tab)
            return
        }
        let muted = "\u{1b}[90m"
        tab.feed(text: "\r\n\(muted)[process exited with code \(code)]\u{1b}[0m\r\n")
        onChange?(tab.envId)
    }
}
