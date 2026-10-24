import AppKit
import KunjWorkspaceCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let screenshotPath: String?
    /// `--demo`: the mockup's environments (DemoData) instead of kunj.
    private let demo: Bool
    private var windowController: MainWindowController!
    /// The kunj CLI once discovery succeeded (Tasks 4+ build the environment store on it).
    private(set) var kunj: KunjCLI?
    private(set) var kunjStatus: KunjStatus?
    private var discovery: Task<Void, Never>?

    init(arguments: [String]) {
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
        windowController.onHeaderAction = { action, env in log("header action \(action) for \(env.id)") }
        windowController.showWindow(nil)
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if demo {
            windowController.lastActivity = DemoData.lastActivity
            windowController.render(repos: DemoData.repos, selected: DemoData.selectedId)
            windowController.setKunjVersion(DemoData.version)
        } else {
            discovery = Task { await self.discoverKunj() }
        }

        if let screenshotPath {
            // After discovery (so the sidebar shows the kunj version and the list) and the next layout pass
            Task { @MainActor [weak self] in
                await self?.discovery?.value
                try? await Task.sleep(nanoseconds: 300_000_000)
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
            }
            await loadEnvironments(cli: cli)
        } catch {
            let message = (error as? KunjCLIError)?.message ?? "\(error)"
            log("kunj: \(message) (command \(command), PATH \(path))")
            await MainActor.run { self.windowController.showDiscoveryError(message) }
        }
    }

    /// One listing of every environment. Task 7 replaces this with the EnvironmentStore (Task 5):
    /// `windowController.render(repos: store.repos)` on each `onChange`.
    private func loadEnvironments(cli: KunjCLI) async {
        let (repos, error) = await listEnvironments(cli: cli)
        await MainActor.run {
            self.windowController.render(repos: repos)
            self.windowController.showListingError(error?.message)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// The bundled fonts register through ATSApplicationFontsPath (only inside the .app).
    private func logFonts() {
        for name in ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "JetBrainsMono-Regular"] {
            log("font \(name): \(NSFont(name: name, size: 12) != nil ? "available" : "missing (system fallback)")")
        }
    }

    // MARK: menus (one function per menu, so later tasks add items in separate places)

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        for menu in [appMenu(), editMenu(), viewMenu(), windowMenu()] {
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
        return true
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data(("[workspace] " + s + "\n").utf8))
}
