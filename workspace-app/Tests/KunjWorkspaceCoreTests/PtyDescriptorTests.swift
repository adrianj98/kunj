import Foundation
import SwiftTerm
import Testing

@Suite struct PtyDescriptorTests {
    /// A terminal tab's child must not inherit the app's pipes (kunj events' stdin, a running kunj
    /// call's output) or other tabs' PTY masters: a background job started in a shell would keep
    /// them open after the app dies, and kunj events would never see its stdin close.
    @Test func terminalChildInheritsOnlyItsTerminal() throws {
        let dir = try tempDirectory()
        let out = dir.appendingPathComponent("fds.txt")
        let pipe = Pipe()
        let leaked = pipe.fileHandleForWriting.fileDescriptor
        var size = winsize(ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0)
        let child = PseudoTerminalHelpers.fork(andExec: "/bin/sh",
                                               args: ["/bin/sh", "-c", "ls /dev/fd > '\(out.path)'"],
                                               env: ["PATH=/usr/bin:/bin"], desiredWindowSize: &size)
        let (pid, master) = try #require(child)
        defer { close(master) }
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        let fds = try String(contentsOf: out, encoding: .utf8).split(separator: "\n").compactMap { Int32($0) }
        #expect(!fds.contains(leaked))
        // 0-2 are the terminal; sh and ls may each hold one of their own (before: 12 of the app's)
        #expect(fds.filter { $0 > 2 }.count <= 2)
        _ = pipe
    }
}
