import AppKit
import KunjWorkspaceCore

/// A tab of the left column: a terminal (`TerminalTab`) or an editor (`EditorTab`).
@MainActor
protocol WorkspaceTab: AnyObject {
    var id: String { get }
    var envId: String { get }
    var kind: TabKind { get }
    var title: String { get }
    /// The tab's process runs (always true for an editor).
    var running: Bool { get }
}

extension TerminalTab: WorkspaceTab {}

/// Every open tab, terminals and editors, per environment id, and which one is active in each.
/// Terminal views are created here and placed by the TerminalColumn; closing a terminal ends its
/// process. Editor tabs share one Monaco page (`editorView`, created with the first one); closing a
/// dirty one asks first.
@MainActor
final class TabRegistry {
    private var tabsByEnv: [String: [any WorkspaceTab]] = [:]
    private var activeByEnv: [String: String] = [:]
    private var counters: [String: Int] = [:]
    var theme: Theme {
        didSet {
            for t in allTerminals { t.apply(theme) }
            if let editorPage { Task { await editorPage.call("setTheme", ["tokens": MonacoWebView.tokens(theme)]) } }
        }
    }
    /// Called after tabs were opened, closed, activated or changed state; the argument is the
    /// environment id whose tabs changed.
    var onChange: ((String) -> Void)?
    /// A key press went to a tab of this environment (its `lastActivity`).
    var onInput: ((String) -> Void)?
    /// Reads and writes editor tabs' files (set once kunj is discovered; no editor tabs before).
    var fileAccess: FileAccess?
    /// An editor tab saved its file (the Changes column reloads).
    var onSaved: ((EditorTab) -> Void)?
    /// Opens a file of an environment in an editor tab (a ⌘-click on a path in a terminal).
    var onOpenFile: ((Environment, String) -> Void)?
    private var editorPage: MonacoWebView?
    /// The editor tab the editor page shows on screen (set by the TerminalColumn), so key presses
    /// in the page count as activity of its environment.
    weak var shownEditor: EditorTab?
    private var keyMonitor: Any?

    init(theme: Theme) {
        self.theme = theme
        // Key presses, not `send(source:data:)`: SwiftTerm also sends the terminal's own replies
        // (device attributes, cursor reports) through it, which are not the user's activity.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let responder = event.window?.firstResponder
            MainActor.assumeIsolated {
                guard let self else { return }
                if let tab = responder as? TerminalTab {
                    self.onInput?(tab.envId)
                } else if let view = responder as? NSView, let page = self.editorPage, view.isDescendant(of: page),
                          let editor = self.shownEditor {
                    // Typing in the editor page: the editor tab it shows
                    self.onInput?(editor.envId)
                }
            }
            return event
        }
    }

    var allTabs: [any WorkspaceTab] { tabsByEnv.values.flatMap { $0 } }
    var allTerminals: [TerminalTab] { allTabs.compactMap { $0 as? TerminalTab } }
    var allEditors: [EditorTab] { allTabs.compactMap { $0 as? EditorTab } }

    func tabs(for envId: String) -> [any WorkspaceTab] { tabsByEnv[envId] ?? [] }

    func active(for envId: String) -> (any WorkspaceTab)? {
        let tabs = tabs(for: envId)
        return tabs.first { $0.id == activeByEnv[envId] } ?? tabs.first
    }

    /// Opens a tab running `spec` in `env` and makes it active.
    @discardableResult
    func open(spec: TerminalSpec, env: Environment, kind: TabKind, onFinish: ((Int32) -> Void)? = nil) -> TerminalTab {
        let tab = makeTab(env: env, kind: kind, title: spec.title, spec: spec)
        if let onFinish { finishers[tab.id] = onFinish }
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
        let tab = TerminalTab(id: nextId(env: env, kind: kind), envId: env.id, kind: kind, title: title, spec: spec,
                              theme: theme)
        tab.onExit = { [weak self] t in self?.exited(t) }
        tab.onTitle = { [weak self] t in self?.onChange?(t.envId) }
        tab.onOpenLink = { [weak self] t, link in self?.openLink(link, from: t, env: env) ?? false }
        add(tab)
        return tab
    }

    private func nextId(env: Environment, kind: TabKind) -> String {
        let key = "\(env.id)#\(kind.rawValue)"
        let n = (counters[key] ?? 0) + 1
        counters[key] = n
        return "\(key)#\(n)"
    }

    private func add(_ tab: any WorkspaceTab) {
        tabsByEnv[tab.envId, default: []].append(tab)
        activeByEnv[tab.envId] = tab.id
    }

    // MARK: editors

    /// The editor tabs' Monaco page, created with the first editor tab.
    var editorView: MonacoWebView {
        if let editorPage { return editorPage }
        let page = MonacoWebView(mode: "editor")
        page.onMessage = { [weak self] m in self?.editorMessage(m) }
        editorPage = page
        Task { await page.call("setTheme", ["tokens": MonacoWebView.tokens(theme)]) }
        return page
    }
    var hasEditorView: Bool { editorPage != nil }

    /// Opens `path` of `env` in an editor tab and makes it active (an open tab of that file is
    /// activated instead). The file loads in the background; when it cannot be read (or is binary
    /// or too large) the tab closes and `failed` gets the reason. nil before kunj is discovered.
    @discardableResult
    func openEditor(env: Environment, path: String, failed: @escaping (String) -> Void = { _ in }) -> EditorTab? {
        if let open = tabs(for: env.id).lazy.compactMap({ $0 as? EditorTab }).first(where: { $0.path == path }) {
            activate(open)
            return open
        }
        guard let access = fileAccess else { return nil }
        let tab = EditorTab(id: nextId(env: env, kind: .editor), env: env, path: path, access: access, page: editorView)
        add(tab)
        onChange?(env.id)
        Task { @MainActor in
            do {
                try await tab.load()
                self.onChange?(env.id) // the column shows it now that the page has it
            } catch {
                log("editor: cannot open \(path) in \(env.id): \(error)")
                self.remove(tab)
                failed("Cannot open \(path): \(EditorTab.message(error))")
            }
        }
        return tab
    }

    /// A ⌘-clicked file in a terminal opens in an editor tab: in a worktree the first candidate
    /// that exists (else the default opener gets the link), in a container the first one (its
    /// files are not on this Mac, and a missing one shows the editor's message).
    private func openLink(_ link: String, from tab: TerminalTab, env: Environment) -> Bool {
        guard let onOpenFile else { return false }
        let root = env.kind == .container ? "/workspace" : env.path
        guard let root else { return false }
        let paths = terminalLinkPaths(link, root: root, cwd: tab.reportedDirectory)
        let path = env.kind == .container
            ? paths.first
            : paths.first { FileManager.default.fileExists(atPath: root + "/" + $0) }
        guard let path else { return false }
        onOpenFile(env, path)
        return true
    }

    /// Saves an editor tab (File > Save, ⌘S in the page); `onSaved` follows a save.
    @discardableResult
    func save(_ tab: EditorTab) async -> Bool {
        let saved = await tab.save()
        if saved { onSaved?(tab) }
        return saved
    }

    /// Messages from the editor page: `dirty` and `save` carry only a tab id.
    private func editorMessage(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "dirty":
            guard let tab = editor(id: m["id"]), let dirty = m["dirty"] as? Bool, tab.dirty != dirty else { return }
            tab.dirty = dirty
            onChange?(tab.envId)
        case "save":
            guard let tab = editor(id: m["id"]) else { return }
            Task { await self.save(tab) }
        case "ready":
            // A page reloaded after its process ended has lost every model: read the files again
            // (unsaved text is gone with the process).
            for tab in allEditors where tab.loaded {
                Task { @MainActor in
                    if (try? await tab.load()) == nil { self.remove(tab) }
                    self.onChange?(tab.envId)
                }
            }
        default:
            break
        }
    }

    private func editor(id: Any?) -> EditorTab? {
        guard let id = id as? String else { return nil }
        return allEditors.first { $0.id == id }
    }

    // MARK: activation and closing

    func activate(_ tab: any WorkspaceTab) {
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

    /// Closes a tab: a terminal's process ends; a dirty editor asks first (Save closes it once
    /// saved, Don't Save closes it, Cancel keeps it). The tab to its left (else right) becomes active.
    func close(_ tab: any WorkspaceTab) {
        guard let editor = tab as? EditorTab, editor.dirty else { remove(tab); return }
        let alert = NSAlert()
        alert.messageText = "Save changes to \(editor.title)?"
        alert.informativeText = "\(editor.path): your changes are lost if you don't save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            Task { @MainActor in
                if await self.save(editor) { self.remove(editor) }
            }
        case .alertSecondButtonReturn:
            remove(editor)
        default:
            break
        }
    }

    /// Closes a tab without asking, unsaved text included (Close Session asked already).
    func discard(_ tab: any WorkspaceTab) {
        remove(tab)
    }

    /// Called with an action tab's exit code (`open(onFinish:)`); dropped when the tab closes first.
    private var finishers: [String: (Int32) -> Void] = [:]

    private func remove(_ tab: any WorkspaceTab) {
        guard var tabs = tabsByEnv[tab.envId], let i = tabs.firstIndex(where: { $0 === tab }) else { return }
        finishers.removeValue(forKey: tab.id)
        if let terminal = tab as? TerminalTab {
            // closed by the user (quitting goes through closeAll): its tmux session ends too
            if terminal.spec?.session != nil { onSessionClosed?(terminal) }
            terminal.onExit = nil
            terminal.close()
            terminal.removeFromSuperview()
        } else if let editor = tab as? EditorTab {
            editor.discard()
        }
        tabs.remove(at: i)
        tabsByEnv[tab.envId] = tabs.isEmpty ? nil : tabs
        if activeByEnv[tab.envId] == tab.id {
            activeByEnv[tab.envId] = tabs.isEmpty ? nil : tabs[max(0, i - 1)].id
        }
        onChange?(tab.envId)
    }

    /// Ends every terminal's process (the app is quitting). tmux sessions stay: `tmux attach` only
    /// detaches. Editor tabs need nothing (the app asked about unsaved ones before).
    /// A tab with a tmux session was closed: end the session (`sessionKillArguments`).
    var onSessionClosed: ((TerminalTab) -> Void)?

    func closeAll() {
        for tab in allTerminals {
            tab.onExit = nil
            tab.close()
        }
    }

    /// A shell that exits 0 (`exit`) and an action whose spec says so close themselves; any other
    /// tab stays, with the exit status printed, so its output can be read.
    private func exited(_ tab: TerminalTab) {
        let code = tab.exited ?? -1
        finishers.removeValue(forKey: tab.id)?(code)
        if code == 0 && (tab.kind == .shell || tab.spec?.closeOnExitZero == true) {
            remove(tab)
            return
        }
        let muted = "\u{1b}[90m"
        tab.feed(text: "\r\n\(muted)[process exited with code \(code)]\u{1b}[0m\r\n")
        onChange?(tab.envId)
    }
}
