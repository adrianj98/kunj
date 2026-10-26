import AppKit
import KunjWorkspaceCore
import SwiftTerm

/// One terminal tab of the left column: a PTY started from a `TerminalSpec`. Its view stays in the
/// window while the tab is open, hidden when not shown, so switching environments never touches
/// the process. While `inBackground` (`hidden` would clash with NSView's), output is queued and fed by the shared `HiddenFeedScheduler` under
/// its time budget; showing the tab feeds the rest at once.
final class TerminalTab: LocalProcessTerminalView {
    /// `"<envId>#<kind>#<n>"`
    let id: String
    let envId: String
    let kind: TabKind
    let spec: TerminalSpec?
    var title: String
    /// The title the program set (OSC 0/2), shown as the pill's tooltip.
    private(set) var programTitle: String?
    private(set) var exited: Int32?
    /// When the process started (the tab bar's agent uptime); `--demo` sets it.
    var startedAt = Date()
    var onExit: ((TerminalTab) -> Void)?
    var onTitle: ((TerminalTab) -> Void)?
    /// A ⌘-clicked link; true when it was handled (a file opened in an editor tab), else the
    /// default opener gets it.
    var onOpenLink: ((TerminalTab, String) -> Bool)?
    /// The directory the shell reported (OSC 7), for links relative to it.
    fileprivate(set) var reportedDirectory: String?
    var running: Bool { exited == nil && process?.running == true }

    private var queue: HiddenFeedQueue!
    /// SwiftTerm's process delegate; a separate object because the delegate protocol's
    /// `sizeChanged(source:)` clashes with the view's own method of that name.
    private var events: TabProcessEvents!

    var inBackground: Bool = true {
        didSet {
            isHidden = inBackground
            guard !inBackground, oldValue else { return }
            queue.drainAll()
            needsDisplay = true
        }
    }

    init(id: String, envId: String, kind: TabKind, title: String, spec: TerminalSpec?, theme: Theme,
         scheduler: HiddenFeedScheduler = .shared) {
        self.id = id
        self.envId = envId
        self.kind = kind
        self.title = title
        self.spec = spec
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        queue = scheduler.makeQueue { [weak self] slice in self?.feed(byteArray: slice) }
        events = TabProcessEvents(tab: self)
        processDelegate = events
        isHidden = true
        font = Theme.mono(12.5)
        // CSS line-height 1.6 over the font's natural height (≈1.32 for JetBrains Mono)
        lineSpacing = 1.2
        optionAsMetaKey = true
        apply(theme)
        setAccessibilityLabel("\(title) terminal")
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Starts the spec's process. A login shell (`arguments` starting with `-l`) gets
    /// `-<name>` as argv[0], as Terminal.app does.
    func start() {
        guard let spec else { return }
        startedAt = Date()
        let name = URL(fileURLWithPath: spec.executable).lastPathComponent
        let execName = spec.arguments.first == "-l" ? "-" + name : nil
        startProcess(executable: spec.executable, args: spec.arguments,
                     environment: spec.environment.map { "\($0.key)=\($0.value)" }.sorted(),
                     execName: execName, currentDirectory: spec.cwd)
    }

    /// Text shown without a process (`--demo`).
    func show(text: String) {
        feed(text: text.replacingOccurrences(of: "\n", with: "\r\n"))
    }

    /// Ends the tab's process like closing a terminal window: SIGHUP to the process (a shell passes
    /// it to its jobs; `tmux attach` detaches, leaving the session), then SwiftTerm's SIGTERM and
    /// close of the PTY. Once the process has exited (and was reaped) nothing is signalled: its pid
    /// may already belong to another process; the PTY closes when the tab is released.
    func close() {
        guard exited == nil else { return }
        if let pid = process?.shellPid, pid > 0, process.running { kill(pid, SIGHUP) }
        terminate()
    }

    var pid: pid_t? {
        guard let p = process?.shellPid, p > 0 else { return nil }
        return p
    }

    func apply(_ theme: Theme) {
        nativeBackgroundColor = theme.color(\.term)
        nativeForegroundColor = theme.color(\.termText)
        caretColor = theme.color(\.termAccent)
        selectedTextBackgroundColor = theme.color(\.termAccent, alpha: 0.3)
        // SwiftTerm's default (.base16Lab) rebuilds colours 16-255 by blending the 16 below with the
        // background, so a program's 256-colour green came out as a muted theme tint; keep xterm's
        // cube and grey ramp so those colours are the ones the program asked for.
        getTerminal().ansi256PaletteStrategy = .xterm
        installColors(Self.palette(theme))
    }

    /// The 16 ANSI colours from the theme: 8 (bright black) = termMuted, 4 and 12 (blue) = termAccent,
    /// 2/10 = green, 3/11 = amber, 1/9 = red; magenta and cyan are real magenta and cyan (the theme
    /// has neither); the rest from the text ramp.
    static func palette(_ t: Theme) -> [SwiftTerm.Color] {
        func c(_ key: KeyPath<ThemeTokens, String>) -> SwiftTerm.Color { hex(t.tokens[keyPath: key]) }
        func hex(_ s: String) -> SwiftTerm.Color {
            let rgba = parseHex(s) ?? RGBA(r: 1, g: 0, b: 1, a: 1)
            return SwiftTerm.Color(red: UInt16(rgba.r * 65535), green: UInt16(rgba.g * 65535),
                                   blue: UInt16(rgba.b * 65535))
        }
        let black = c(\.term), red = c(\.red), green = c(\.green), amber = c(\.amber), blue = c(\.termAccent)
        let magenta = hex(t.isDark ? "#d670d6" : "#bc05bc"), cyan = hex(t.isDark ? "#29b8db" : "#0598bc")
        let white = c(\.termText)
        return [black, red, green, amber, blue, magenta, cyan, white,
                c(\.termMuted), red, green, amber, blue, magenta, cyan, c(\.text)]
    }

    // MARK: output

    override func dataReceived(slice: ArraySlice<UInt8>) {
        if inBackground || queue.hasPending {
            queue.append(slice)
            if !inBackground { queue.drainAll() }
        } else {
            feed(byteArray: slice)
        }
    }

    override func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        super.processTerminated(source, exitCode: exitCode)
        guard exited == nil else { return }
        // SwiftTerm passes waitpid's raw status (exit 1 arrives as 256)
        exited = exitCode.map { KunjWorkspaceCore.exitCode(waitStatus: $0) } ?? -1
        queue.drainAll()
        onExit?(self)
    }

    override func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if onOpenLink?(self, link) == true { return }
        super.requestOpenLink(source: source, link: link, params: params)
    }

    // MARK: selection over mouse reporting

    /// While a program has the mouse (tmux with `mouse on`, a full-screen agent), a drag goes to it,
    /// not to a selection ⌘C could copy. With ⌥ (as in iTerm) or ⇧ held at the press the view
    /// selects instead, and mouse reporting stays off until ⌘C, the next plain click or a scroll
    /// over the tab: with it on, SwiftTerm drops the selection at the next line of output, before ⌘C.
    /// A shell tab selects on every press, ⌥ or not: its mouse belongs to tmux (`mouse on`), whose own
    /// copy never reaches the Mac clipboard, and a plain click there keeps the mode.
    private var selectingOverMouseReporting = false
    /// Ends the mode on a scroll over the tab, before SwiftTerm's `scrollWheel` (not overridable)
    /// handles it: with reporting off the wheel would become arrow keys (alternate scroll).
    private var scrollMonitor: Any?

    override func mouseDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let plain = flags.intersection([.option, .shift]).isEmpty
        if plain && kind != .shell { endSelectingOverMouseReporting() }
        if !plain || kind == .shell, getTerminal().mouseMode != .off, allowMouseReporting {
            selectingOverMouseReporting = true
            allowMouseReporting = false
            scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                MainActor.assumeIsolated {
                    guard let self, event.window === self.window,
                          self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return }
                    self.endSelectingOverMouseReporting()
                }
                return event
            }
        }
        super.mouseDown(with: event)
    }

    override func copy(_ sender: Any) {
        super.copy(sender)
        endSelectingOverMouseReporting()
    }

    private func endSelectingOverMouseReporting() {
        guard selectingOverMouseReporting else { return }
        selectingOverMouseReporting = false
        allowMouseReporting = true
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }
        scrollMonitor = nil
    }

    fileprivate func programSetTitle(_ title: String) {
        programTitle = title.isEmpty ? nil : title
        onTitle?(self)
    }
}

private final class TabProcessEvents: LocalProcessTerminalViewDelegate {
    weak var tab: TerminalTab?
    init(tab: TerminalTab) { self.tab = tab }
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) { tab?.programSetTitle(title) }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) { tab?.reportedDirectory = directory }
    func processTerminated(source: TerminalView, exitCode: Int32?) {}
}
