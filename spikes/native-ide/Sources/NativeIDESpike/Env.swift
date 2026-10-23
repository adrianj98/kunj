import Foundation
import Darwin

/// PATH from the user's login shell, the way macos-app resolves it: apps launched from
/// Finder do not get one.
enum ShellEnv {
    static let loginShell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"

    static let loginPath: String = {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: loginShell)
        p.arguments = ["-l", "-i", "-c", "printf \"<M>%s<M>\" \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        let fallback = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        do { try p.run() } catch { return fallback }
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return fallback }
        let s = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let parts = s.components(separatedBy: "<M>")
        return parts.count >= 3 && !parts[1].isEmpty ? parts[1] : fallback
    }()

    /// Environment for a terminal tab: TERM/COLORTERM/LANG set, PATH from the login shell.
    static func terminalEnvironment() -> [String] {
        var env = ProcessInfo.processInfo.environment
        for k in ["NO_COLOR", "FORCE_COLOR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
                  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
            env.removeValue(forKey: k)
        }
        // launched from a Claude Code session while benchmarking: do not leak its markers
        for k in env.keys where k.hasPrefix("CLAUDE_CODE") || k.hasPrefix("CLAUDECODE") { env.removeValue(forKey: k) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = nil
        env["PATH"] = loginPath
        env["HOME"] = env["HOME"] ?? NSHomeDirectory()
        return env.map { "\($0.key)=\($0.value)" }
    }
}

/// Wall clock in ms (monotonic).
@inline(__always) func nowMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
}

/// CPU time (user+system, seconds) of one thread, by mach port.
func threadCPUSeconds(_ thread: mach_port_t) -> Double {
    var info = thread_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
        }
    }
    guard kr == KERN_SUCCESS else { return 0 }
    return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
        + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
}

/// CPU time (user+system, seconds) of this process.
func processCPUSeconds() -> Double {
    var ru = rusage()
    getrusage(RUSAGE_SELF, &ru)
    return Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6
        + Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
}

let mainThreadPort: mach_port_t = pthread_mach_thread_np(pthread_self())

/// `ps -o %cpu=,rss= -p <pids>` → [pid: (cpu%, rssKB)]
func psSample(_ pids: [Int32]) -> [Int32: (cpu: Double, rssKB: Int)] {
    guard !pids.isEmpty else { return [:] }
    let out = runTool("/bin/ps", ["-o", "pid=,%cpu=,rss=", "-p", pids.map(String.init).joined(separator: ",")])
    var r: [Int32: (Double, Int)] = [:]
    for line in out.split(separator: "\n") {
        let f = line.split(separator: " ", omittingEmptySubsequences: true)
        if f.count >= 3, let pid = Int32(f[0]), let c = Double(f[1]), let m = Int(f[2]) { r[pid] = (c, m) }
    }
    return r
}

/// All processes: (pid, ppid, rssKB, command)
func psAll() -> [(pid: Int32, ppid: Int32, rssKB: Int, command: String)] {
    let out = runTool("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="])
    return out.split(separator: "\n").compactMap { line in
        let f = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
        guard f.count == 4, let pid = Int32(f[0]), let pp = Int32(f[1]), let rss = Int(f[2]) else { return nil }
        return (pid, pp, rss, String(f[3]))
    }
}

/// Descendants of a pid (PTY children and their children).
func descendants(of root: Int32, in table: [(pid: Int32, ppid: Int32, rssKB: Int, command: String)]) -> [Int32] {
    var result: [Int32] = []
    var frontier = [root]
    while let p = frontier.popLast() {
        for row in table where row.ppid == p { result.append(row.pid); frontier.append(row.pid) }
    }
    return result
}

@discardableResult
func runTool(_ exe: String, _ args: [String], cwd: String? = nil, stdin: String? = nil) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    if let stdin {
        let inp = Pipe()
        p.standardInput = inp
        try? p.run()
        inp.fileHandleForWriting.write(stdin.data(using: .utf8)!)
        try? inp.fileHandleForWriting.close()
    } else {
        p.standardInput = FileHandle.nullDevice
        try? p.run()
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
}

func log(_ s: String) {
    FileHandle.standardError.write(("[spike] " + s + "\n").data(using: .utf8)!)
}

/// phys_footprint in MB via /usr/bin/footprint (what Activity Monitor calls Memory).
func footprintMB(_ pid: Int32) -> Double? {
    let out = runTool("/usr/bin/footprint", ["-p", String(pid)])
    guard let r = out.range(of: #"Footprint: ([0-9.]+) (KB|MB|GB)"#, options: .regularExpression) else { return nil }
    let parts = out[r].split(separator: " ")
    guard parts.count == 3, let v = Double(parts[1]) else { return nil }
    switch parts[2] { case "KB": return v / 1024; case "GB": return v * 1024; default: return v }
}
