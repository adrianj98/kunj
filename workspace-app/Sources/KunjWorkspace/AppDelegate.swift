import AppKit
import KunjWorkspaceCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let screenshotPath: String?
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
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logFonts()
        NSApp.mainMenu = buildMenu()
        windowController = MainWindowController()
        windowController.showWindow(nil)
        windowController.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        discovery = Task { await self.discoverKunj() }

        if let screenshotPath {
            // After discovery (so the status bar shows the kunj version) and the next layout pass
            Task { @MainActor [weak self] in
                await self?.discovery?.value
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
    /// result on the right of the status bar: `kunj 1.4.2`, `kunj 1.0.0 dev`, or the error
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
                self.windowController.setKunjStatus(status.label, isError: false)
            }
        } catch {
            let message = (error as? KunjCLIError)?.message ?? "\(error)"
            log("kunj: \(message) (command \(command), PATH \(path))")
            await MainActor.run { self.windowController.setKunjStatus(message, isError: true) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// The bundled fonts register through ATSApplicationFontsPath (only inside the .app).
    private func logFonts() {
        for name in ["Inter-Regular", "Inter-SemiBold", "JetBrainsMono-Regular"] {
            log("font \(name): \(NSFont(name: name, size: 12) != nil ? "available" : "missing (system fallback)")")
        }
    }

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Kunj Workspace", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Kunj Workspace", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        return main
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data(("[workspace] " + s + "\n").utf8))
}
