import AppKit
import KunjWorkspaceCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let screenshotPath: String?
    /// `--demo`: the mockup's environments (DemoData) instead of kunj.
    private let demo: Bool
    private var windowController: MainWindowController!
    /// The kunj CLI once discovery succeeded (Tasks 4+ build the environment store on it).
    private(set) var kunj: KunjCLI?
    private(set) var kunjStatus: KunjStatus?
    private var discovery: Task<Void, Never>?
    /// The environments (live) and the `kunj events` child that keeps them current.
    private var store: EnvironmentStore?
    private var events: EventStream?
    /// Saves and restores each environment's tabs and its `lastActivity` (not in `--demo`).
    private var layoutKeeper: LayoutKeeper?
    private var terminating = false
    /// Header buttons, the overflow menu, port links and New session.
    private let runner = ActionRunner()
    private var settings: SettingsWindow?
    private var newSessionSheet: NewSessionSheet?
    /// `--theme <name>`: this run's theme (not saved), for screenshots against light.png/graphite.png.
    private let themeArgument: ThemeChoice?
    /// `--changes` / `--no-changes`: the Changes column open or closed for this run (not saved).
    private let changesArgument: Bool?

    /// The app-wide Changes column setting (default closed).
    static let showChangesKey = "showChanges"

    nonisolated init(arguments: [String]) {
        if let i = arguments.firstIndex(of: "--screenshot"), i + 1 < arguments.count {
            screenshotPath = arguments[i + 1]
        } else {
            screenshotPath = nil
        }
        if let i = arguments.firstIndex(of: "--theme"), i + 1 < arguments.count {
            themeArgument = ThemeChoice(rawValue: arguments[i + 1])
        } else {
            themeArgument = nil
        }
        changesArgument = arguments.contains("--changes") ? true : (arguments.contains("--no-changes") ? false : nil)
        demo = arguments.contains("--demo")
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logFonts()
        if let themeArgument {
            ThemeManager.shared.override = themeArgument
        } else if demo && UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["theme"] == nil {
            ThemeManager.shared.override = .warm
        }
        NSApp.mainMenu = buildMenu()
        windowController = MainWindowController()
        windowController.onHeaderAction = { [weak self] action, env in self?.headerAction(action, env) }
        windowController.terminalColumn.onNewTab = { [weak self] in self?.openTab(.shell) }
        wireEditors()
        windowController.onNewSession = { [weak self] in self?.newSession(nil) }
        windowController.onToggleChanges = { [weak self] in self?.toggleChanges(nil) }
        windowController.sidebar.search.onEscape = { [weak self] in self?.windowController.terminalColumn.focusActive() }
        // --demo renders the mockup, which shows the column; otherwise the saved setting (closed by default)
        let changesOpen = changesArgument ?? (demo || UserDefaults.standard.bool(forKey: Self.showChangesKey))
        windowController.setChangesVisible(changesOpen, animated: false)
        wireRunner()
        windowController.showWindow(nil)
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if demo {
            windowController.changesColumn.source = DemoChanges()
            windowController.lastActivity = DemoData.lastActivity
            windowController.render(repos: DemoData.repos, selected: DemoData.selectedId)
            windowController.setKunjVersion(DemoData.version)
            DemoData.openTabs(in: windowController.terminalColumn)
        } else {
            discovery = Task { await self.discoverKunj() }
        }

        if let screenshotPath {
            // After discovery (so the sidebar shows the kunj version and the list) and the next layout pass
            Task { @MainActor [weak self] in
                await self?.discovery?.value
                // Monaco loads in about a second; give the diff time to render (at most 8 s)
                for _ in 0..<80 where self?.windowController.changesVisible == true
                    && self?.windowController.changesColumn.diffView.ready != true {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self?.windowController.snapshotPNG { data in
                    if let data {
                        FileManager.default.createFile(atPath: screenshotPath, contents: data)
                        log("screenshot written to \(screenshotPath)")
                    } else {
                        log("screenshot failed")
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }

    /// Resolves the login-shell PATH, then runs `kunj -V` (both off the main thread) and shows the
    /// version at the sidebar's foot (`kunj 1.4.2`, `kunj 1.0.0 dev`), or the window's error state
    /// (`kunj not found on your PATH: npm install -g kunj`). The command is the `kunjCommand`
    /// default (`defaults write <bundle id> kunjCommand "node /path/dist/index.js"`), else `kunj`.
    private func discoverKunj() async {
        let configured = UserDefaults.standard.string(forKey: SettingsWindow.kunjCommandKey)?
            .trimmingCharacters(in: .whitespaces)
        let command = (configured?.isEmpty ?? true) ? "kunj" : configured!
        let path = await ShellEnvironment.loginPath()
        do {
            let (cli, status) = try await KunjCLI.discover(command: command, path: path)
            // Settings changed the command while this ran: the new discovery owns the window
            if Task.isCancelled { return }
            log("kunj: \(status.binary) \(status.version)\(status.dev ? " (dev build)" : "")")
            await MainActor.run {
                self.kunj = cli
                self.kunjStatus = status
                self.windowController.setKunjVersion(status.label)
                self.windowController.changesColumn.source = DiffService(cli: cli)
                self.windowController.terminalColumn.registry.fileAccess = FileAccess(cli: cli)
                self.settings?.cli = cli
                self.windowController.header.show(self.windowController.selectedEnvironment)
            }
            await loadEnvironments(cli: cli)
        } catch {
            let message = (error as? KunjCLIError)?.message ?? "\(error)"
            log("kunj: \(message) (command \(command), PATH \(path))")
            await MainActor.run { self.windowController.showDiscoveryError(message) }
        }
    }

    /// The EnvironmentStore: one full listing, then `kunj events --json` keeps it current (each
    /// change re-renders the window).
    @MainActor
    private func loadEnvironments(cli: KunjCLI) async {
        let store = EnvironmentStore(cli: cli)
        self.store = store
        let keeper = makeLayoutKeeper(store: store)
        store.onChange = { [weak self, weak store] in
            guard let self, let store else { return }
            keeper.listed(store.repos)
            self.windowController.render(repos: store.repos)
            self.runner.listed(store.repos)
            self.windowController.showListingError(store.lastError?.message)
            // a selected environment that could not restore its tabs (stopped) may now
            keeper.selected(self.windowController.selectedEnvironment)
        }
        // the Changes column follows git events and container status changes of its repository
        store.onRepoChanged = { [weak windowController] root in windowController?.changesColumn.repoChanged(root: root) }
        await store.refreshAll()
        // a change of the kunj command (reconnect) dropped this store while it listed: starting
        // its event stream now would leave a second `kunj events` running that nothing stops
        guard self.store === store else { return }
        windowController.render(repos: store.repos)
        windowController.showListingError(store.lastError?.message)
        guard !terminating else { return }
        let events = store.makeEventStream()
        self.events = events
        store.start(events: events)
        openTabsFromArguments()
    }

    /// The layout file's keeper, wired to the store, the registry and the window: selecting an
    /// environment restores its tabs, tab changes are saved, listings and key presses bump
    /// `lastActivity`, which the sidebar shows.
    private func makeLayoutKeeper(store: EnvironmentStore) -> LayoutKeeper {
        // after a change of the kunj command the keeper stays (its restored set, its chained
        // registry handler) and only reads the new store
        if let keeper = layoutKeeper {
            keeper.environment = { [weak store] id in store?.environment(id: id) }
            return keeper
        }
        let keeper = LayoutKeeper()
        layoutKeeper = keeper
        let registry = windowController.terminalColumn.registry
        keeper.environment = { [weak store] id in store?.environment(id: id) }
        keeper.tabs = { [weak registry] id in
            guard let registry else { return ([], nil) }
            let tabs = registry.tabs(for: id)
            let active = registry.active(for: id)
            return (tabs.map { SavedTab(kind: $0.kind, title: $0.title, path: ($0 as? EditorTab)?.path) },
                    tabs.firstIndex { $0 === active })
        }
        keeper.open = { [weak self] env, tab in
            if tab.kind == .editor {
                if let path = tab.path { self?.windowController.terminalColumn.registry.openEditor(env: env, path: path) }
            } else {
                _ = self?.startTab(env: env, kind: tab.kind)
            }
        }
        keeper.activate = { [weak registry] id, index in
            guard let registry else { return }
            let tabs = registry.tabs(for: id)
            if tabs.indices.contains(index) { registry.activate(tabs[index]) }
        }
        keeper.onActivity = { [weak self] in self?.windowController.sidebar.refreshTimes() }
        // the column already listens to the registry: keep its handler and add the keeper's
        let columnHandler = registry.onChange
        registry.onChange = { [weak keeper] id in
            columnHandler?(id)
            keeper?.tabsChanged(id)
        }
        registry.onInput = { [weak keeper] id in keeper?.input(id) }
        windowController.lastActivity = { [weak keeper] id in keeper?.lastActivity(id) }
        windowController.onSelect = { [weak keeper] env in keeper?.selected(env) }
        return keeper
    }

    /// `-openTabs "<environment id>#<kind>,…"` (e.g. `kunj|worktree|main#shell,kunj|worktree|main#agent`)
    /// selects each environment and opens the tab after the first listing: a way to check
    /// terminals without a person at the keyboard. An entry without `#<kind>` only selects (which
    /// restores the environment's saved tabs).
    private func openTabsFromArguments() {
        guard let raw = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["openTabs"] as? String
        else { return }
        for entry in raw.split(separator: ",") {
            guard let hash = entry.lastIndex(of: "#"), let kind = TabKind(rawValue: String(entry[entry.index(after: hash)...]))
            else {
                windowController.select(String(entry))
                continue
            }
            windowController.select(String(entry[..<hash]))
            openTab(kind)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Ends every tab's process (tmux sessions stay) and the `kunj events` child before quitting,
    /// so nothing the app started outlives it.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        guard confirmQuitWithUnsavedEditors() else { return .terminateCancel }
        terminating = true
        windowController?.terminalColumn.registry.closeAll()
        layoutKeeper?.flush()
        guard let events else { return .terminateNow }
        // terminate may be called from a main-actor job (the --screenshot path); the main queue
        // is then busy for as long as AppKit waits for the reply, so neither stop() nor the
        // reply may need the main actor: the reply goes through the run loop, not GCD.
        Task.detached {
            await events.stop()
            log("kunj events stopped")
            let main = CFRunLoopGetMain()
            CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) {
                MainActor.assumeIsolated { NSApp.reply(toApplicationShouldTerminate: true) }
            }
            CFRunLoopWakeUp(main)
        }
        return .terminateLater
    }

    // MARK: tabs

    private func headerAction(_ action: HeaderAction, _ env: Environment) {
        switch action {
        case .shell: openTab(.shell)
        case .agent: openTab(.agent)
        case .open: runner.perform(env.kind == .container ? .ctOpen : .worktreeOpen, env: env)
        case .createPR: runner.perform(.createPR, env: env)
        case .more(let anchor):
            let menu = runner.overflowMenu(env: env)
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
        }
    }

    /// The runner's view of the app: the store's environments, action tabs in the terminal column,
    /// alerts on the window. The header asks it which buttons are enabled.
    private func wireRunner() {
        runner.cli = { [weak self] in self?.kunj }
        runner.repos = { [weak self] in self?.store?.repos ?? self?.windowController.repos ?? [] }
        runner.window = { [weak self] in self?.windowController.window }
        runner.openAction = { [weak self] env, spec in
            guard let column = self?.windowController.terminalColumn else { return }
            column.registry.open(spec: spec, env: env, kind: .action)
            DispatchQueue.main.async { column.focusActive() }
        }
        runner.showMessage = { [weak self] text in self?.windowController.terminalColumn.showMessage(text) }
        runner.select = { [weak self] id in self?.windowController.select(id) }
        runner.openAgent = { [weak self] env in
            self?.windowController.select(env.id)
            self?.openTab(.agent)
        }
        // --demo renders the mockup, whose buttons are all enabled (its container has no host
        // worktree in DemoData, and nothing runs without kunj anyway)
        let demo = self.demo
        windowController.header.plan = { [weak self] action, env in
            if demo { return .run(args: []) }
            return self?.runner.plan(action, env) ?? .disabled(reason: "kunj is not ready")
        }
    }

    @objc func openShell(_ sender: Any?) { openTab(.shell) }
    @objc func openAgent(_ sender: Any?) { openTab(.agent) }

    @objc func openInEditor(_ sender: Any?) {
        guard let env = windowController.selectedEnvironment else { return }
        runner.perform(env.kind == .container ? .ctOpen : .worktreeOpen, env: env)
    }

    @objc func createPR(_ sender: Any?) {
        guard let env = windowController.selectedEnvironment else { return }
        runner.perform(.createPR, env: env)
    }

    /// New Session (⌘N): the sheet over the window; Create runs it through the runner.
    @objc func newSession(_ sender: Any?) {
        guard newSessionSheet == nil, let window = windowController.window else { return }
        let repos = store?.repos ?? windowController.repos
        guard !repos.isEmpty else { NSSound.beep(); return }
        let sheet = NewSessionSheet(repos: repos, preferred: windowController.selectedEnvironment?.repo,
                                    theme: ThemeManager.shared.current)
        sheet.onCreate = { [weak self] request in
            guard let self else { return }
            log("new session: \(request.kind.rawValue) \(request.branch) in \(request.repo.name)")
            self.runner.newSession(request, fallback: self.windowController.selectedEnvironment)
        }
        newSessionSheet = sheet
        guard let panel = sheet.window else { return }
        window.beginSheet(panel) { [weak self] _ in self?.newSessionSheet = nil }
    }

    /// ⌘K: the sidebar's search field.
    @objc func focusSearch(_ sender: Any?) { windowController.sidebar.search.focus() }

    /// ⌘1–9: the nth row the search leaves.
    @objc func switchSession(_ sender: NSMenuItem) {
        let ids = windowController.visibleEnvironmentIds
        let n = sender.tag
        guard n >= 1, n <= ids.count else { NSSound.beep(); return }
        windowController.select(ids[n - 1])
        windowController.terminalColumn.focusActive()
    }

    /// View > Show/Hide Changes (⌘⇧C) and the tab bar's pill; saved app-wide.
    @objc func toggleChanges(_ sender: Any?) {
        let visible = !windowController.changesVisible
        windowController.setChangesVisible(visible, animated: true)
        UserDefaults.standard.set(visible, forKey: Self.showChangesKey)
    }

    @objc func showSettings(_ sender: Any?) {
        if settings == nil {
            let s = SettingsWindow()
            s.onKunjCommandChanged = { [weak self] in self?.reconnect() }
            settings = s
        }
        settings?.cli = kunj
        settings?.showWindow(nil)
        settings?.window?.makeKeyAndOrderFront(nil)
    }

    /// The kunj command changed in Settings: stop the event stream, drop the store and discover
    /// kunj again with the new command (open tabs keep running with the command they started with).
    private func reconnect() {
        guard !demo, !terminating else { return }
        log("kunj command changed: rediscovering")
        discovery?.cancel()
        let oldEvents = events
        events = nil
        store?.onChange = nil
        store?.onRepoChanged = nil
        store = nil
        kunj = nil
        kunjStatus = nil
        settings?.cli = nil
        windowController.render(repos: [])
        windowController.setKunjVersion("")
        windowController.showListingError(nil)
        windowController.showDiscoveryError(nil)
        discovery = Task {
            if let oldEvents { await oldEvents.stop() }
            await self.discoverKunj()
        }
    }

    /// Opens a shell or the agent in the selected environment. Agent activates a running agent
    /// tab; a refused spec (missing worktree, stopped container) shows inline in the column.
    private func openTab(_ kind: TabKind) {
        guard let env = windowController.selectedEnvironment else { return }
        let column = windowController.terminalColumn
        if kind == .agent,
           let existing = column.registry.tabs(for: env.id).first(where: { $0.kind == .agent && $0.running }) {
            column.registry.activate(existing)
            column.focusActive()
            return
        }
        if startTab(env: env, kind: kind) {
            DispatchQueue.main.async { column.focusActive() }
        }
    }

    /// Opens a `kind` tab in `env` (also one restored from the layout file); a refused spec shows
    /// inline in the column and opens nothing.
    @discardableResult
    private func startTab(env: Environment, kind: TabKind) -> Bool {
        let column = windowController.terminalColumn
        guard let cli = kunj else { return false }
        do {
            let spec = try terminalSpec(cli: cli, env: env, kind: kind, shell: Self.loginShell,
                                        terminalEnv: ProcessInfo.processInfo.environment)
            column.registry.open(spec: spec, env: env, kind: kind)
            log("opened \(kind.rawValue) in \(env.id): \(spec.executable) \(spec.arguments.joined(separator: " ")) (cwd \(spec.cwd))")
            return true
        } catch let error as TerminalSpecError {
            column.showMessage(error.message)
        } catch {
            column.showMessage("\(error)")
        }
        return false
    }

    @objc func nextTab(_ sender: Any?) { cycleTab(1) }
    @objc func previousTab(_ sender: Any?) { cycleTab(-1) }

    private func cycleTab(_ step: Int) {
        guard let env = windowController.selectedEnvironment else { return }
        windowController.terminalColumn.registry.cycle(envId: env.id, by: step)
        windowController.terminalColumn.focusActive()
    }

    @objc func closeTab(_ sender: Any?) {
        let column = windowController.terminalColumn
        guard let tab = column.activeTab else { return }
        column.registry.close(tab)
        column.focusActive()
    }

    /// The user's login shell: `$SHELL`, else the account's, else zsh.
    static var loginShell: String {
        if let s = ProcessInfo.processInfo.environment["SHELL"], !s.isEmpty { return s }
        if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell { return String(cString: sh) }
        return "/bin/zsh"
    }

    /// The bundled fonts register through ATSApplicationFontsPath (only inside the .app).
    private func logFonts() {
        for name in ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "JetBrainsMono-Regular"] {
            log("font \(name): \(NSFont(name: name, size: 12) != nil ? "available" : "missing (system fallback)")")
        }
    }

    // MARK: menus (one function per menu, so later tasks add items in separate places)

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        for menu in [appMenu(), fileMenu(), editMenu(), viewMenu(), environmentMenu(), tabsMenu(), windowMenu()] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        return main
    }

    private func appMenu() -> NSMenu {
        let menu = NSMenu(title: "Kunj Workspace")
        menu.addItem(withTitle: "Settings…", action: #selector(showSettings(_:)), keyEquivalent: ",").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Hide Kunj Workspace", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Kunj Workspace", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    // MARK: editor tabs and File > Save

    /// File: Save ⌘S (the active editor tab; ⌘S inside the editor page posts the same save).
    private func fileMenu() -> NSMenu {
        let menu = NSMenu(title: "File")
        menu.addItem(withTitle: "Save", action: #selector(saveFile(_:)), keyEquivalent: "s").target = self
        return menu
    }

    @objc func saveFile(_ sender: Any?) {
        let column = windowController.terminalColumn
        guard let editor = column.activeEditor else { return }
        Task { await column.registry.save(editor) }
    }

    /// Edit (or a double-click) in the Changes column opens the file in an editor tab; a save
    /// reloads the column (its counts), since a working-tree edit makes no `git` event.
    private func wireEditors() {
        let column = windowController.terminalColumn
        windowController.changesColumn.onEdit = { [weak column] env, path in
            guard let column else { return }
            column.showMessage(nil)
            column.registry.openEditor(env: env, path: path) { [weak column] reason in column?.showMessage(reason) }
            DispatchQueue.main.async { column.focusActive() }
        }
        column.registry.onSaved = { [weak windowController] tab in
            windowController?.changesColumn.repoChanged(root: tab.env.repo.root)
        }
    }

    /// Quitting with unsaved editor tabs asks first; true to quit.
    private func confirmQuitWithUnsavedEditors() -> Bool {
        let dirty = windowController?.terminalColumn.registry.allEditors.filter(\.dirty) ?? []
        guard !dirty.isEmpty else { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = dirty.count == 1 ? "\(dirty[0].title) has unsaved changes"
            : "\(dirty.count) files have unsaved changes"
        alert.informativeText = dirty.map(\.path).joined(separator: "\n")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Quit Without Saving")
        return alert.runModal() == .alertSecondButtonReturn
    }

    private func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        menu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        menu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        return menu
    }

    /// View > Theme: Auto (light ↔ warm with the system), Warm, Light, Graphite.
    private func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        let themeItem = NSMenuItem(title: "Theme", action: nil, keyEquivalent: "")
        let themes = NSMenu(title: "Theme")
        for choice in ThemeChoice.allCases {
            let item = NSMenuItem(title: choice.title, action: #selector(chooseTheme(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = choice.rawValue
            themes.addItem(item)
        }
        themeItem.submenu = themes
        menu.addItem(themeItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Show Changes", action: #selector(toggleChanges(_:)), keyEquivalent: "C").target = self
        return menu
    }

    /// Environment: the header's buttons (Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O, Create PR ⌘⇧P),
    /// New Session ⌘N, Search ⌘K and Switch to Session ⌘1–9.
    private func environmentMenu() -> NSMenu {
        let menu = NSMenu(title: "Environment")
        menu.addItem(withTitle: "New Shell", action: #selector(openShell(_:)), keyEquivalent: "t").target = self
        menu.addItem(withTitle: "Agent", action: #selector(openAgent(_:)), keyEquivalent: "A").target = self
        menu.addItem(withTitle: "Open in VS Code", action: #selector(openInEditor(_:)), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "Create PR", action: #selector(createPR(_:)), keyEquivalent: "P").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "New Session…", action: #selector(newSession(_:)), keyEquivalent: "n").target = self
        menu.addItem(withTitle: "Search Sessions", action: #selector(focusSearch(_:)), keyEquivalent: "k").target = self
        let switchItem = NSMenuItem(title: "Switch to Session", action: nil, keyEquivalent: "")
        let switches = NSMenu(title: "Switch to Session")
        for n in 1...9 {
            let item = NSMenuItem(title: "Session \(n)", action: #selector(switchSession(_:)), keyEquivalent: "\(n)")
            item.tag = n
            item.target = self
            switches.addItem(item)
        }
        switchItem.submenu = switches
        menu.addItem(switchItem)
        return menu
    }

    /// Tabs: next ⌘⇧], previous ⌘⇧[, close ⌘W.
    private func tabsMenu() -> NSMenu {
        let menu = NSMenu(title: "Tabs")
        menu.addItem(withTitle: "Next Tab", action: #selector(nextTab(_:)), keyEquivalent: "}").target = self
        menu.addItem(withTitle: "Previous Tab", action: #selector(previousTab(_:)), keyEquivalent: "{").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w").target = self
        return menu
    }

    private func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = menu
        return menu
    }

    @objc private func chooseTheme(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let choice = ThemeChoice(rawValue: raw) else { return }
        ThemeManager.shared.override = nil
        ThemeManager.shared.choice = choice
    }
}

extension AppDelegate: NSMenuItemValidation {
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(chooseTheme(_:)) {
            item.state = (item.representedObject as? String) == ThemeManager.shared.choice.rawValue ? .on : .off
        }
        let env = windowController?.selectedEnvironment
        switch item.action {
        case #selector(openShell(_:)), #selector(openAgent(_:)):
            return env != nil && kunj != nil && env?.state != .missing && env?.state != .stopped
        case #selector(nextTab(_:)), #selector(previousTab(_:)):
            return env.map { windowController.terminalColumn.registry.tabs(for: $0.id).count > 1 } ?? false
        case #selector(closeTab(_:)):
            return windowController?.terminalColumn.activeTab != nil
        case #selector(saveFile(_:)):
            return windowController?.terminalColumn.activeEditor?.loaded == true
        case #selector(openInEditor(_:)):
            guard let env else { return false }
            if case .disabled = runner.plan(env.kind == .container ? .ctOpen : .worktreeOpen, env) { return false }
            return kunj != nil
        case #selector(createPR(_:)):
            guard let env else { return false }
            if case .disabled = runner.plan(.createPR, env) { return false }
            return kunj != nil
        case #selector(newSession(_:)):
            return kunj != nil && !(store?.repos.isEmpty ?? true) && newSessionSheet == nil
        case #selector(switchSession(_:)):
            return item.tag <= (windowController?.visibleEnvironmentIds.count ?? 0)
        case #selector(toggleChanges(_:)):
            item.title = windowController?.changesVisible == true ? "Hide Changes" : "Show Changes"
            return true
        default:
            return true
        }
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data(("[workspace] " + s + "\n").utf8))
}
