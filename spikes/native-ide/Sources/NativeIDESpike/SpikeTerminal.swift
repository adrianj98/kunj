import AppKit
import SwiftTerm

/// LocalProcessTerminalView with hooks the benchmarks need: byte counting, a marker that
/// says "the last line has been fed", and a watched byte for keystroke-echo latency.
/// SwiftTerm's draw(_:) is not open, so "drawn" is measured by forcing a display pass
/// after the marker has been fed.
final class SpikeTerminal: LocalProcessTerminalView {
    let title: String
    private(set) var bytesReceived = 0
    private(set) var exitCode: Int32?
    private(set) var exitedAtMs: Double?
    private(set) var startedAtMs: Double?
    var onExit: ((SpikeTerminal) -> Void)?

    /// Called on the main thread right after the chunk containing `marker` was fed.
    var marker: [UInt8]?
    var onMarker: (() -> Void)?
    private var tail: [UInt8] = []

    /// Called when `watchByte` arrives (keystroke echo latency).
    var watchByte: UInt8?
    var onWatchByte: (() -> Void)?

    init(title: String) {
        self.title = title
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Runs `command` through /bin/sh -c (benchmarks) or a login shell (interactive tabs).
    func start(command: String?, cwd: String? = nil) {
        startedAtMs = nowMs()
        let env = ShellEnv.terminalEnvironment()
        if let command {
            startProcess(executable: "/bin/sh", args: ["-c", command], environment: env,
                         execName: nil, currentDirectory: cwd)
        } else {
            let shell = ShellEnv.loginShell
            startProcess(executable: shell, args: ["-l"], environment: env,
                         execName: "-" + (shell as NSString).lastPathComponent, currentDirectory: cwd)
        }
    }

    var childPid: Int32 { process?.shellPid ?? 0 }

    /// Writes bytes into the PTY as if the user had typed them.
    func inject(_ s: String) { send(txt: s) }

    override func dataReceived(slice: ArraySlice<UInt8>) {
        bytesReceived += slice.count
        super.dataReceived(slice: slice)
        if let w = watchByte, slice.contains(w) {
            watchByte = nil
            onWatchByte?()
        }
        if let m = marker, slice.contains(m.last!) {
            var hay = tail
            hay.append(contentsOf: slice)
            let found = hay.withUnsafeBytes { h in
                m.withUnsafeBytes { n in memmem(h.baseAddress, h.count, n.baseAddress, n.count) != nil }
            }
            if found {
                marker = nil
                tail = []
                onMarker?()
            } else {
                tail = Array(hay.suffix(m.count))
            }
        }
    }

    override func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        self.exitCode = exitCode
        exitedAtMs = nowMs()
        super.processTerminated(source, exitCode: exitCode)
        onExit?(self)
    }
}
