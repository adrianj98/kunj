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
    private var terminating = false

    nonisolated init(arguments: [String]) {
        if let i = arguments.firstIndex(of: "--screenshot"), i + 1 < arguments.count {
            screenshotPath = arguments[i + 1]
        } else {
            screenshotPath = nil
        }
        demo = arguments.contains("--demo")
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logFonts()
        if demo && UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["theme"] == nil {
            ThemeManager.shared.override = .warm
        }
        NSApp.mainMenu = buildMenu()
        windowController = MainWindowController()
        windowController.onHeaderAction = { [weak self] action, env in self?.headerAction(action, env) }
        windowController.terminalColumn.onNewTab = { [weak self] in self?.openTab(.shell) }
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
                for _ in 0..<80 where self?.windowController.changesColumn.diffView.ready != true {
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
        let configured = UserDefaults.standard.string(forKey: "kunjCommand")?
            .trimmingCharacters(in: .whitespaces)
        let command = (configured?.isEmpty ?? true) ? "kunj" : configured!
        let path = await ShellEnvironment.loginPath()
        do {
            let (cli, status) = try await KunjCLI.discover(command: command, path: path)
            log("kunj: \(status.binary) \(status.version)\(status.dev ? " (dev build)" : "")")
            await MainActor.run {
                self.kunj = cli
                self.kunjStatus = status
                self.windowController.setKunjVersion(status.label)
                self.windowController.changesColumn.source = DiffService(cli: cli)
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
        store.onChange = { [weak self, weak store] in
            guard let self, let store else { return }
            self.windowController.render(repos: store.repos)
            self.windowController.showListingError(store.lastError?.message)
        }
        // the Changes column follows git events and container status changes of its repository
        store.onRepoChanged = { [weak windowController] root in windowController?.changesColumn.repoChanged(root: root) }
        await store.refreshAll()
        windowController.render(repos: store.repos)
        windowController.showListingError(store.lastError?.message)
        guard !terminating else { return }
        let events = store.makeEventStream()
        self.events = events
        store.start(events: events)
        openTabsFromArguments()
    }

    /// `-openTabs "<environment id>#<kind>,…"` (e.g. `kunj|worktree|main#shell,kunj|worktree|main#agent`)
    /// selects each environment and opens the tab after the first listing: a way to check
    /// terminals without a person at the keyboard.
    private func openTabsFromArguments() {
        guard let raw = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["openTabs"] as? String
        else { return }
        for entry in raw.split(separator: ",") {
            guard let hash = entry.lastIndex(of: "#"), let kind = TabKind(rawValue: String(entry[entry.index(after: hash)...]))
            else { continue }
            windowController.select(String(entry[..<hash]))
            openTab(kind)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Ends every tab's process (tmux sessions stay) and the `kunj events` child before quitting,
    /// so nothing the app started outlives it.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateLater }
        terminating = true
        windowController?.terminalColumn.registry.closeAll()
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
        default: log("header action \(action) for \(env.id)")
        }
    }

    @objc func openShell(_ sender: Any?) { openTab(.shell) }
    @objc func openAgent(_ sender: Any?) { openTab(.agent) }

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
        guard let cli = kunj else { return }
        do {
            let spec = try terminalSpec(cli: cli, env: env, kind: kind, shell: Self.loginShell,
                                        terminalEnv: ProcessInfo.processInfo.environment)
            column.registry.open(spec: spec, env: env, kind: kind)
            log("opened \(kind.rawValue) in \(env.id): \(spec.executable) \(spec.arguments.joined(separator: " ")) (cwd \(spec.cwd))")
            DispatchQueue.main.async { column.focusActive() }
        } catch let error as TerminalSpecError {
            column.showMessage(error.message)
        } catch {
            column.showMessage("\(error)")
        }
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
        for menu in [appMenu(), editMenu(), viewMenu(), environmentMenu(), tabsMenu(), windowMenu()] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        return main
    }

    private func appMenu() -> NSMenu {
        let menu = NSMenu(title: "Kunj Workspace")
        menu.addItem(withTitle: "Hide Kunj Workspace", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Kunj Workspace", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
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
        return menu
    }

    /// Environment: Shell ⌘T, Agent ⌘⇧A (the header's buttons).
    private func environmentMenu() -> NSMenu {
        let menu = NSMenu(title: "Environment")
        menu.addItem(withTitle: "New Shell", action: #selector(openShell(_:)), keyEquivalent: "t").target = self
        menu.addItem(withTitle: "Agent", action: #selector(openAgent(_:)), keyEquivalent: "A").target = self
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
        default:
            return true
        }
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data(("[workspace] " + s + "\n").utf8))
}
