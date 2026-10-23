import AppKit

// Pin the main thread's mach port before anything else touches the lazy global.
_ = mainThreadPort

var loginPathMs: Double = 0
var diffBase = "HEAD~1"

let repoRoot: String = {
    if let r = ProcessInfo.processInfo.environment["KUNJ_REPO"] { return r }
    return "/Users/adrian/projects/kunj"
}()

func diffPayload() -> DiffPayload {
    let path = "src/commands/container.ts"
    // HEAD~1 per the brief, unless the file did not change in HEAD (the repo moves under
    // us): then the parent of the last commit that touched it.
    var base = "HEAD~1"
    let headVersion = runTool("/usr/bin/git", ["show", "HEAD~1:\(path)"], cwd: repoRoot)
    let modified0 = (try? String(contentsOfFile: repoRoot + "/" + path, encoding: .utf8)) ?? ""
    if headVersion == modified0 {
        let last = runTool("/usr/bin/git", ["log", "-1", "--format=%H", "--", path], cwd: repoRoot)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !last.isEmpty { base = last + "~1" }
    }
    diffBase = base
    let original = runTool("/usr/bin/git", ["show", "\(base):\(path)"], cwd: repoRoot)
    let modified = (try? String(contentsOfFile: repoRoot + "/" + path, encoding: .utf8)) ?? ""
    return DiffPayload(original: original, modified: modified, language: ProcessInfo.processInfo.environment["SPIKE_LANG"] ?? "typescript")
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var wc: WorkspaceWindowController!
    var activity: NSObjectProtocol?
    let benchName: String?
    let outPath: String?

    init(benchName: String?, outPath: String?) {
        self.benchName = benchName
        self.outPath = outPath
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        // No App Nap / timer coalescing while measuring.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "spike")
        NSApp.mainMenu = buildMenu()
        wc = WorkspaceWindowController()
        wc.showWindow(nil)
        wc.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Resolve the login-shell PATH before any terminal starts (it blocks for as long as
        // the user's shell startup takes; the real app should do this off the main thread).
        let t0 = nowMs()
        _ = ShellEnv.loginPath
        loginPathMs = nowMs() - t0

        if let benchName {
            let bench = Bench(wc: wc, outPath: outPath)
            Task { @MainActor in await bench.run(benchName) }
        } else {
            setUpDemo()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func setUpDemo() {
        let host = wc.addEnvironment("kunj (host)")
        wc.addTerminal(to: host, title: "shell", command: nil, cwd: repoRoot)
        wc.addDiff(to: host, title: "diff container.ts", payload: diffPayload())
        wc.addTerminal(to: host, title: "claude", command: "exec claude", cwd: repoRoot)
        let feat = wc.addEnvironment("feature/x (host)")
        wc.addTerminal(to: feat, title: "shell", command: nil, cwd: repoRoot)
        wc.addTerminal(to: feat, title: "top", command: "exec top")
        let ct = wc.addEnvironment("feature/y (container)")
        wc.addTerminal(to: ct, title: "ct list", command: "cd \(repoRoot) && node dist/index.js ct list; exec $SHELL -l")
        wc.select(env: 0, tab: 0)
        wc.focusCurrent()
    }

    func buildMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit NativeIDESpike", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Standard Edit menu: WKWebView only gets copy:/paste:/selectAll: (and so Cmd+C/V/A)
        // through these first-responder actions. No Find item: Cmd+F must reach Monaco.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let tabsItem = NSMenuItem()
        let tabs = NSMenu(title: "Tabs")
        // Cmd+Shift+] arrives as characters "}" (shift is not stripped from
        // charactersIgnoringModifiers), so the equivalent is "}" + Cmd, like Safari's.
        let next = tabs.addItem(withTitle: "Next Tab", action: #selector(WorkspaceWindowController.nextTab(_:)), keyEquivalent: "}")
        next.keyEquivalentModifierMask = [.command]
        tabs.addItem(withTitle: "Close Tab", action: #selector(WorkspaceWindowController.closeTab(_:)), keyEquivalent: "w")
        tabsItem.submenu = tabs
        main.addItem(tabsItem)
        return main
    }
}

let args = CommandLine.arguments
func argValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate(benchName: argValue("--bench"), outPath: argValue("--out"))
app.delegate = delegate
app.run()
