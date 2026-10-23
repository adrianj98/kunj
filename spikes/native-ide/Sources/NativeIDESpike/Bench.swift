import AppKit
import WebKit
import SwiftTerm

/// Scripted scenarios: `NativeIDESpike --bench <name> [--out file.json]`.
/// Names: throughput, multi, claudes, fidelity, monaco, memory, all.
@MainActor
final class Bench {
    let wc: WorkspaceWindowController
    let outPath: String?
    var results: [String: Any] = [:]
    let shotsDir: String

    init(wc: WorkspaceWindowController, outPath: String?) {
        self.wc = wc
        self.outPath = outPath
        shotsDir = ProcessInfo.processInfo.environment["SPIKE_SHOTS"]
            ?? (repoRoot + "/spikes/native-ide/screenshots")
    }

    var benchFile: String {
        ProcessInfo.processInfo.environment["SPIKE_CAT_FILE"] ?? "/tmp/native-ide-spike-50mb.txt"
    }

    func run(_ name: String) async {
        try? FileManager.default.createDirectory(atPath: shotsDir, withIntermediateDirectories: true)
        results["bench"] = name
        results["swiftTerm"] = "1.20.0"
        results["loginPathMs"] = Bench.r2(loginPathMs)
        results["renderer"] = useMetal ? "metal" : "coregraphics"
        results["screen"] = NSScreen.main.map { "\(Int($0.frame.width))x\(Int($0.frame.height))@\($0.backingScaleFactor)x" } ?? "?"
        let names = name == "all" ? ["throughput", "multi", "fidelity", "monaco", "memory"] : [name]
        for n in names {
            log("bench \(n) start")
            switch n {
            case "throughput": results["throughput"] = await throughput()
            case "multi": results["multi"] = await multi()
            case "claudes": results["claudes"] = await claudes()
            case "redraw": results["redraw"] = await redraw()
            case "fidelity": results["fidelity"] = await fidelity()
            case "monaco": results["monaco"] = await monaco()
            case "memory": results["memory"] = await memory()
            case "keys": results["keys"] = await keys()
            default: results["error"] = "unknown bench \(n)"
            }
            log("bench \(n) done")
            if outPath != nil { save() }  // partial results survive a crash in a later bench
        }
        finish()
    }

    var useMetal: Bool { CommandLine.arguments.contains("--metal") }

    /// JSON cannot hold NaN/inf: replace them with null.
    nonisolated static func sanitize(_ v: Any) -> Any {
        switch v {
        case let d as Double: return d.isFinite ? d : NSNull()
        case let a as [Any]: return a.map(sanitize)
        case let m as [String: Any]: return m.mapValues(sanitize)
        default: return v
        }
    }

    func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: Bench.sanitize(results), options: [.prettyPrinted, .sortedKeys]) else {
            log("results not serialisable"); return
        }
        if let outPath {
            FileManager.default.createFile(atPath: outPath, contents: data)
        } else {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        }
    }

    func finish() {
        for t in wc.envs.flatMap({ $0.tabs.compactMap(\.terminal) }) { t.terminate() }
        save()
        // give PTYs a moment to receive SIGHUP
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }

    // MARK: helpers

    func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }

    @discardableResult
    func waitUntil(_ timeout: Double, _ cond: () -> Bool) async -> Bool {
        let end = nowMs() + timeout * 1000
        while nowMs() < end {
            if cond() { return true }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        return cond()
    }

    func fresh(_ name: String) -> Environment {
        for t in wc.envs.flatMap({ $0.tabs.compactMap(\.terminal) }) { t.terminate(); t.removeFromSuperview() }
        wc.envs = []
        wc.gridTerminals = nil
        let e = wc.addEnvironment(name)
        return e
    }

    func terminal(_ env: Environment, _ title: String, _ cmd: String?, cwd: String? = nil) -> SpikeTerminal {
        let t = wc.addTerminal(to: env, title: title, command: cmd, cwd: cwd)
        if useMetal { do { try t.setUseMetal(true) } catch { log("metal: \(error)") } }
        return t
    }

    func screenText(_ t: SpikeTerminal) -> [String] {
        let term = t.getTerminal()
        return (0..<term.rows).map { term.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
    }

    func snapshot(_ name: String) async -> String? {
        let png: Data? = await withCheckedContinuation { c in wc.snapshotPNG { c.resume(returning: $0) } }
        guard let png else { return nil }
        let path = shotsDir + "/" + name + ".png"
        FileManager.default.createFile(atPath: path, contents: png)
        return path
    }

    /// Run-loop latency: how long a block queued on the main queue waits.
    final class LatencyProbe {
        var samples: [Double] = []
        var running = true
        func start() {
            func tick() {
                guard running else { return }
                let t = nowMs()
                DispatchQueue.main.async { [self] in
                    samples.append(nowMs() - t)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { tick() }
                }
            }
            tick()
        }
        func stats() -> [String: Double] { Bench.stats(samples) }
    }

    nonisolated static func stats(_ xs: [Double]) -> [String: Double] {
        guard !xs.isEmpty else { return [:] }
        let s = xs.sorted()
        func p(_ q: Double) -> Double { s[min(s.count - 1, Int(Double(s.count - 1) * q))] }
        return ["n": Double(s.count), "p50": r2(p(0.5)), "p95": r2(p(0.95)), "max": r2(s.last!),
                "mean": r2(s.reduce(0, +) / Double(s.count))]
    }

    nonisolated static func r2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

    // MARK: A. throughput

    func throughput() async -> [[String: Any]] {
        if !FileManager.default.fileExists(atPath: benchFile) { makeCatFile() }
        let fileMB = Double((try? FileManager.default.attributesOfItem(atPath: benchFile)[.size] as? Int) ?? 0) / 1e6
        let cases: [(String, String)] = [
            ("seq 1 2000000", "seq 1 2000000"),
            ("cat \(Int(fileMB.rounded())) MB text", "cat '\(benchFile)'"),
            ("yes | head -c 200000000", "yes | head -c 200000000"),
        ]
        var out: [[String: Any]] = []
        let reps = Int(ProcessInfo.processInfo.environment["SPIKE_REPS"] ?? "2") ?? 2
        for (label, cmd) in cases {
            for rep in 0..<reps {
                let env = fresh("throughput")
                // created by hand: the process starts only when the clock does
                let term = SpikeTerminal(title: label)
                wc.content.addSubview(term)
                env.tabs.append(Tab(title: label, kind: .terminal(term)))
                if useMetal { try? term.setUseMetal(true) }
                wc.select(env: 0, tab: 0)
                wc.focusCurrent()
                await sleep(0.3)

                var fedAt: Double?
                term.marker = Array("@@SPIKE_DONE@@".utf8)
                term.onMarker = { fedAt = nowMs() }
                let cpu0 = processCPUSeconds(), main0 = threadCPUSeconds(mainThreadPort)
                let probe = LatencyProbe(); probe.start()
                term.start(command: "\(cmd); printf '\\n@@SPIKE_DONE@@\\n'")
                let start = term.startedAtMs!
                let ok = await waitUntil(300) { fedAt != nil }
                // the 60 fps throttle in SwiftTerm, then a forced display pass = drawn
                await sleep(0.02)
                term.displayIfNeeded()
                let drawnAt = nowMs()
                probe.running = false
                await waitUntil(5) { term.exitedAtMs != nil }
                let cpu = processCPUSeconds() - cpu0, mainCpu = threadCPUSeconds(mainThreadPort) - main0
                let wall = (drawnAt - start) / 1000
                let mb = Double(term.bytesReceived) / 1e6
                let last = screenText(term).filter { !$0.isEmpty }.suffix(2)
                if rep == 0 { _ = await snapshot("A-\(label.split(separator: " ").first!)") }
                out.append([
                    "case": label, "rep": rep, "completed": ok,
                    "bytesMB": Bench.r2(mb),
                    "spawnToExitMs": Bench.r2((term.exitedAtMs ?? .nan) - start),
                    "spawnToLastLineFedMs": Bench.r2((fedAt ?? .nan) - start),
                    "spawnToDrawnMs": Bench.r2(drawnAt - start),
                    "MBps": Bench.r2(mb / wall),
                    "processCpuS": Bench.r2(cpu), "mainThreadCpuS": Bench.r2(mainCpu),
                    "mainThreadCpuPct": Bench.r2(100 * mainCpu / wall),
                    "runLoopLatencyMs": probe.stats(),
                    "lastLines": Array(last),
                ])
                log("A \(label) rep \(rep): \(Bench.r2(mb / wall)) MB/s, \(Bench.r2(drawnAt - start)) ms")
                term.terminate()
            }
        }
        return out
    }

    func makeCatFile() {
        // ~50 MB of real source text (kunj's src/, repeated)
        let files = runTool("/usr/bin/git", ["ls-files", "src"], cwd: repoRoot).split(separator: "\n")
            .filter { $0.hasSuffix(".ts") }
        var chunk = Data()
        for f in files {
            if let d = FileManager.default.contents(atPath: repoRoot + "/" + f) { chunk.append(d) }
        }
        var all = Data()
        while all.count < 50_000_000 { all.append(chunk) }
        FileManager.default.createFile(atPath: benchFile, contents: all.prefix(50_000_000))
    }

    // MARK: B. five tabs streaming

    func multi() async -> [String: Any] {
        let env = fresh("multi")
        var terms: [SpikeTerminal] = []
        for i in 0..<5 {
            terms.append(terminal(env, "stream \(i + 1)", "while true; do seq 1 20000; done"))
        }
        // a sixth, idle tab (cat): is the rest of the app responsive while five tabs stream?
        let idle = terminal(env, "idle cat", "exec cat")
        wc.select(env: 0, tab: 0)
        wc.focusCurrent()
        let pid = getpid()
        var phases: [String: Any] = ["appFootprintMBBefore": footprintMB(pid) ?? -1]
        let duration = Double(ProcessInfo.processInfo.environment["SPIKE_MULTI_SECS"] ?? "20") ?? 20
        for phase in ["oneVisibleFourHidden", "allFiveVisibleGrid"] {
            if phase == "allFiveVisibleGrid" {
                wc.gridTerminals = terms + [idle]
                wc.layoutContent()
            }
            await sleep(1)
            var idleEcho: [Double] = []
            for t in terms { t.bytesReceived0 = t.bytesReceived }
            var samples: [[String: Any]] = []
            var echo: [Double] = []
            let probe = LatencyProbe(); probe.start()
            let main0 = threadCPUSeconds(mainThreadPort)
            let proc0 = processCPUSeconds()
            let start = nowMs()
            var lastShot = false
            while nowMs() - start < duration * 1000 {
                // keystroke echo through the PTY of the visible (first) tab
                let t = terms[0]
                var echoed: Double?
                t.watchByte = UInt8(ascii: "Z")
                t.onWatchByte = { echoed = nowMs() }
                let sent = nowMs()
                t.inject("Z")
                await waitUntil(2) { echoed != nil }
                if let echoed { echo.append(echoed - sent) }
                var idleEchoed: Double?
                idle.watchByte = UInt8(ascii: "Q")
                idle.onWatchByte = { idleEchoed = nowMs() }
                let sentIdle = nowMs()
                idle.inject("Q")
                await waitUntil(1) { idleEchoed != nil }
                if let idleEchoed { idleEcho.append(idleEchoed - sentIdle) }
                await sleep(max(0, 1 - (nowMs() - sent) / 1000))
                if let s = psSample([pid])[pid] {
                    samples.append(["t": Bench.r2((nowMs() - start) / 1000), "cpuPct": s.cpu, "rssMB": Bench.r2(Double(s.rssKB) / 1024)])
                }
                if !lastShot && nowMs() - start > duration * 500 {
                    lastShot = true
                    _ = await snapshot("B-\(phase)")
                }
            }
            probe.running = false
            let wall = (nowMs() - start) / 1000
            let mainCpu = threadCPUSeconds(mainThreadPort) - main0
            let table = psAll()
            let childCpu = psSample(terms.flatMap { [$0.childPid] + descendants(of: $0.childPid, in: table) })
            let cpus = samples.compactMap { $0["cpuPct"] as? Double }
            let rss = samples.compactMap { $0["rssMB"] as? Double }
            phases[phase] = [
                "seconds": Bench.r2(wall),
                "appCpuPct": Bench.stats(Array(cpus.dropFirst())),
                "appRssMB": ["first": rss.first ?? 0, "last": rss.last ?? 0, "max": rss.max() ?? 0],
                "mainThreadCpuPct": Bench.r2(100 * mainCpu / wall),
                "processCpuPctRusage": Bench.r2(100 * (processCPUSeconds() - proc0) / wall),
                "echoLatencyMs": Bench.stats(echo),
                "echoMissed": samples.count - echo.count,
                "idleTabEchoLatencyMs": Bench.stats(idleEcho),
                "appFootprintMBAtEnd": footprintMB(pid) ?? -1,
                "runLoopLatencyMs": probe.stats(),
                "MBpsPerTab": terms.map { Bench.r2(Double($0.bytesReceived - $0.bytesReceived0) / 1e6 / wall) },
                "childrenCpuPctSum": Bench.r2(childCpu.values.reduce(0) { $0 + $1.cpu }),
                "samples": samples,
            ]
            log("B \(phase): \(phases[phase]!)")
        }
        for t in terms + [idle] { t.terminate() }
        return phases
    }

    // MARK: B''. five TUI-like full-screen redraw loops (Claude Code's pattern, exaggerated)

    func redraw() async -> [String: Any] {
        let env = fresh("redraw")
        // each tab repaints its whole screen with coloured text ~30 times a second
        let script = #"""
        perl -e 'use Time::HiRes qw(sleep time); $|=1; my ($r,$c)=split / /, `stty size`; $c||=120; $r||=40; my $f=0;
        print "\e[?1049h\e[?25l"; while (1) { my $o="\e[H"; for my $y (1..$r-1) { my $l=""; for my $x (0..int(($c-1)/10)-1) { my $col=16+(($x+$y+$f)%216); $l.="\e[38;5;${col}m".sprintf("%-9s",($f*7+$x*$y)%100000)." "; } $o.=$l."\e[0m\r\n"; }
        $o.="\e[7m frame $f \e[0m\e[K"; print $o; $f++; sleep(1/30); }'
        """#
        var terms: [SpikeTerminal] = []
        for i in 0..<5 { terms.append(terminal(env, "redraw \(i + 1)", script)) }
        let idle = terminal(env, "idle cat", "exec cat")
        let grid = ProcessInfo.processInfo.environment["SPIKE_REDRAW_GRID"] != "0"
        if grid { wc.gridTerminals = terms + [idle] }
        wc.select(env: 0, tab: 0)
        wc.layoutContent()
        await sleep(2)
        let pid = getpid()
        for t in terms { t.bytesReceived0 = t.bytesReceived }
        var cpu: [Double] = [], rss: [Double] = [], idleEcho: [Double] = []
        let probe = LatencyProbe(); probe.start()
        let main0 = threadCPUSeconds(mainThreadPort)
        let proc0 = processCPUSeconds()
        let start = nowMs()
        while nowMs() - start < 20_000 {
            var e: Double?
            idle.watchByte = UInt8(ascii: "Q"); idle.onWatchByte = { e = nowMs() }
            let s0 = nowMs(); idle.inject("Q")
            await waitUntil(1) { e != nil }
            if let e { idleEcho.append(e - s0) }
            await sleep(max(0, 1 - (nowMs() - s0) / 1000))
            if let s = psSample([pid])[pid] { cpu.append(s.cpu); rss.append(Double(s.rssKB) / 1024) }
        }
        probe.running = false
        let wall = (nowMs() - start) / 1000
        let mainCpu = threadCPUSeconds(mainThreadPort) - main0
        _ = await snapshot(grid ? "B-redraw-grid" : "B-redraw-single")
        let table = psAll()
        let kids = psSample(terms.flatMap { [$0.childPid] + descendants(of: $0.childPid, in: table) })
        let frames = terms.map { t -> String in screenText(t).last { $0.contains("frame") } ?? "" }
        for t in terms + [idle] { t.terminate() }
        return [
            "seconds": Bench.r2(wall), "grid": grid,
            "appCpuPct": Bench.stats(Array(cpu.dropFirst())), "appRssMBLast": rss.last ?? 0,
            "appFootprintMB": footprintMB(pid) ?? -1,
            "mainThreadCpuPct": Bench.r2(100 * mainCpu / wall),
            "processCpuPctRusage": Bench.r2(100 * (processCPUSeconds() - proc0) / wall),
            "MBpsPerTab": terms.map { Bench.r2(Double($0.bytesReceived - $0.bytesReceived0) / 1e6 / wall) },
            "idleTabEchoLatencyMs": Bench.stats(idleEcho),
            "runLoopLatencyMs": probe.stats(),
            "producerCpuPctSum": Bench.r2(kids.values.reduce(0) { $0 + $1.cpu }),
            "lastFrameLines": frames,
            "gridCellSize": "\(terms[0].getTerminal().cols)x\(terms[0].getTerminal().rows)",
        ]
    }

    // MARK: B'. five idle Claude Code TUIs

    func claudes() async -> [String: Any] {
        let env = fresh("claudes")
        var terms: [SpikeTerminal] = []
        for i in 0..<5 { terms.append(terminal(env, "claude \(i + 1)", "exec claude", cwd: repoRoot)) }
        wc.select(env: 0, tab: 0)
        await sleep(8)
        let pid = getpid()
        var samples: [Double] = [], rss: [Double] = []
        let main0 = threadCPUSeconds(mainThreadPort)
        let proc0 = processCPUSeconds()
        let start = nowMs()
        for _ in 0..<15 {
            await sleep(1)
            if let s = psSample([pid])[pid] { samples.append(s.cpu); rss.append(Double(s.rssKB) / 1024) }
        }
        let wall = (nowMs() - start) / 1000
        let mainCpu = threadCPUSeconds(mainThreadPort) - main0
        wc.gridTerminals = terms
        wc.layoutContent()
        await sleep(3)
        _ = await snapshot("B-five-claudes-grid")
        let table = psAll()
        let kids = terms.flatMap { [$0.childPid] + descendants(of: $0.childPid, in: table) }
        let kidStats = psSample(kids)
        for t in terms { t.terminate() }
        return [
            "appCpuPct": Bench.stats(samples), "appRssMB": rss.last ?? 0,
            "mainThreadCpuPct": Bench.r2(100 * mainCpu / wall),
            "processCpuPctRusage": Bench.r2(100 * (processCPUSeconds() - proc0) / wall),
            "claudeProcsRssMBSum": Bench.r2(Double(kidStats.values.reduce(0) { $0 + $1.rssKB }) / 1024),
            "bytesPerTab": terms.map(\.bytesReceived),
        ]
    }

    // MARK: C. TUI fidelity

    func fidelity() async -> [String: Any] {
        let env = fresh("fidelity")
        let colortest = """
        printf '256 colours:\\n'; i=0; while [ $i -lt 256 ]; do printf '\\033[48;5;%dm %3d \\033[0m' $i $i; \
        i=$((i+1)); [ $((i % 16)) -eq 0 ] && printf '\\n'; done; printf '\\ntruecolor:\\n'; \
        for r in 0 1 2 3; do c=0; while [ $c -lt 96 ]; do v=$((c*255/95)); \
        case $r in 0) printf '\\033[48;2;%d;0;0m ' $v;; 1) printf '\\033[48;2;0;%d;0m ' $v;; \
        2) printf '\\033[48;2;0;0;%dm ' $v;; 3) printf '\\033[48;2;%d;%d;%dm ' $v $((255-v)) 128;; esac; \
        c=$((c+1)); done; printf '\\033[0m\\n'; done; printf '\\033[1mbold\\033[0m \\033[3mitalic\\033[0m \\033[4munderline\\033[0m \\033[9mstrike\\033[0m  unicode: ─│┌┐└┘ ✓ ✗ → • ⏺ ⎿ 你好 🙂\\n'; exec cat
        """
        let tabs: [(String, String?)] = [
            ("claude", "exec claude"),
            ("vim", "exec vim -R src/commands/container.ts"),
            ("top", "exec top -o cpu"),
            ("colors", colortest),
        ]
        var terms: [SpikeTerminal] = []
        for (title, cmd) in tabs { terms.append(terminal(env, title, cmd, cwd: repoRoot)) }
        wc.select(env: 0, tab: 0)
        wc.focusCurrent()
        await sleep(8)  // claude's first paint
        var shots: [String] = []
        var screen: [String: [String]] = [:]
        var geometry: [String] = []
        let sizes: [(CGFloat, CGFloat)] = [(1280, 820), (860, 540), (1600, 1000)]
        for (w, h) in sizes {
            wc.window?.setContentSize(NSSize(width: w, height: h))
            for (i, (title, _)) in tabs.enumerated() {
                wc.select(env: 0, tab: i)
                await sleep(title == "claude" ? 2.5 : 1.2)
                if let p = await snapshot("C-\(title)-\(Int(w))x\(Int(h))") { shots.append(p) }
                geometry.append("\(title)@\(Int(w))x\(Int(h)): content=\(wc.content.bounds.size) term=\(terms[i].frame) grid=\(terms[i].getTerminal().cols)x\(terms[i].getTerminal().rows)")
                if w == 1280 { screen[title] = screenText(terms[i]) }
            }
        }
        // resize stress on the claude tab: 20 resizes, time each layout+display pass
        wc.select(env: 0, tab: 0)
        var resizeMs: [Double] = []
        for i in 0..<20 {
            let size = i % 2 == 0 ? NSSize(width: 900, height: 600) : NSSize(width: 1400, height: 900)
            let t0 = nowMs()
            wc.window?.setContentSize(size)
            wc.window?.contentView?.layoutSubtreeIfNeeded()
            wc.window?.displayIfNeeded()
            resizeMs.append(nowMs() - t0)
            await sleep(0.15)
        }
        await sleep(2)
        if let p = await snapshot("C-claude-after-resize-stress") { shots.append(p) }
        let cols = terms[0].getTerminal().cols, rows = terms[0].getTerminal().rows
        // screencapture with the real window id (needs Screen Recording permission)
        let wid = wc.window?.windowNumber ?? 0
        let capPath = shotsDir + "/C-screencapture-l.png"
        let cap = Process()
        cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        cap.arguments = ["-x", "-o", "-l", String(wid), capPath]
        let errPipe = Pipe(); cap.standardError = errPipe
        try? cap.run(); cap.waitUntilExit()
        let capErr = String(decoding: errPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        for t in terms { t.terminate() }
        return [
            "screenshots": shots.map { ($0 as NSString).lastPathComponent },
            "screenText1280": screen,
            "resizeLayoutMs": Bench.stats(resizeMs),
            "geometry": geometry,
            "claudeGridAfterResize": "\(cols)x\(rows)",
            "screencapture": ["windowId": wid, "exit": cap.terminationStatus, "stderr": capErr.trimmingCharacters(in: .whitespacesAndNewlines)],
        ]
    }

    // MARK: E. Monaco + key routing

    func monaco() async -> [String: Any] {
        let env = fresh("monaco")
        let before = Set(psAll().filter { $0.command.contains("com.apple.WebKit") }.map(\.pid))
        let payload = diffPayload()
        let created = nowMs()
        let ed = wc.editor  // creates the WKWebView now
        var rendered: [String: Any]?
        var readyAt: Double?
        var renderedAt: Double?
        var computedAt: Double?
        var computed: [String: Any]?
        ed.onMessage = { m in
            if m["type"] as? String == "ready" { readyAt = nowMs() }
            if m["type"] as? String == "diffRendered" { renderedAt = nowMs(); rendered = m }
            if m["type"] as? String == "diffComputed" { computedAt = nowMs(); computed = m }
        }
        wc.addDiff(to: env, title: "diff", payload: payload)
        _ = terminal(env, "shell 1", nil, cwd: repoRoot)
        _ = terminal(env, "shell 2", nil, cwd: repoRoot)
        wc.select(env: 0, tab: 0)
        wc.focusCurrent()
        await ensureActive()
        await waitUntil(30) { renderedAt != nil }
        await sleep(1)
        let changes = await js("const c = window.ed.getLineChanges(); return c ? c.length : -1")
        _ = await snapshot("E-monaco-diff")
        let wcPid = ed.webContentPid
        let after = psAll().filter { $0.command.contains("com.apple.WebKit") && !before.contains($0.pid) }
        var result: [String: Any] = [
            "creationToReadyMs": readyAt.map { Bench.r2($0 - created) } ?? "not reached",
            "creationToDiffRenderedMs": renderedAt.map { Bench.r2($0 - created) } ?? "not reached",
            "page": rendered ?? [:],
            "creationToDiffComputedMs": computedAt.map { Bench.r2($0 - created) } ?? "not reached",
            "pageComputed": computed ?? [:],
            "windowOcclusionVisible": wc.window?.occlusionState.contains(.visible) ?? false,
            "lineChangesAfter1s": changes ?? "nil",
            "diffBase": diffBase,
            "originalLines": payload.original.split(separator: "\n").count,
            "modifiedLines": payload.modified.split(separator: "\n").count,
            "webContentPid": wcPid.map { Int($0) } ?? -1,
            "webkitProcesses": after.map { ["pid": Int($0.pid), "rssMB": Bench.r2(Double($0.rssKB) / 1024),
                                            "footprintMB": footprintMB($0.pid).map(Bench.r2) ?? -1,
                                            "name": ($0.command.split(separator: " ").first.map(String.init) ?? "").components(separatedBy: "/").last ?? ""] },
            "schemeHandler": ["served": ed.handler.served, "failed": ed.handler.failed],
            "pageMessages": ed.messages.filter { ["error", "console"].contains($0["type"] as? String ?? "") }.prefix(10).map { "\($0)" },
        ]
        result["keys"] = await keys()
        return result
    }

    var keyLog: [String] = []
    /// The user's own apps can take activation back mid-run; menu key equivalents only fire
    /// in the active app, so re-activate and wait before every synthesized key.
    func ensureActive() async {
        for _ in 0..<20 {
            if NSApp.isActive && wc.window?.isKeyWindow == true { return }
            NSApp.activate(ignoringOtherApps: true)
            wc.window?.makeKeyAndOrderFront(nil)
            await sleep(0.05)
        }
    }
    func keyEvent(_ chars: String, keyCode: UInt16, mods: NSEvent.ModifierFlags) async {
        await ensureActive()
        guard let w = wc.window else { return }
        keyLog.append("\(chars) active=\(NSApp.isActive) key=\(w.isKeyWindow) fr=\(w.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")")
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: w.windowNumber, context: nil, characters: chars,
                                     charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode)!
            NSApp.sendEvent(e)
        }
    }

    func js(_ s: String) async -> Any? {
        await withCheckedContinuation { c in wc.editor.eval(s) { c.resume(returning: $0) } }
    }

    /// Key routing through NSApp.sendEvent (the same path AppKit uses for real key events
    /// once the window server has delivered them), then through System Events if allowed.
    func keys() async -> [String: Any] {
        var r: [String: Any] = [:]
        let env = wc.envs.first ?? fresh("keys")
        if env.tabs.isEmpty {
            wc.addDiff(to: env, title: "diff", payload: diffPayload())
            _ = terminal(env, "shell 1", nil); _ = terminal(env, "shell 2", nil)
        }
        let ed = wc.editor
        var pageKeys: [String] = []
        let prevHandler = ed.onMessage
        ed.onMessage = { m in prevHandler?(m); if m["type"] as? String == "key" { pageKeys.append("\(m["key"] ?? "")") } }
        NSApp.activate(ignoringOtherApps: true)
        wc.window?.makeKeyAndOrderFront(nil)

        // 1. webview focused: Cmd+F opens Monaco's find widget
        wc.select(env: 0, tab: 0); wc.focusCurrent()
        await sleep(0.3)
        _ = await js("return window.focusModified()")
        r["firstResponderIsWebView"] = wc.window?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        await keyEvent("f", keyCode: 3, mods: [.command])
        await sleep(0.5)
        r["cmdF_findWidgetVisible"] = await js("return window.findVisible()") as? Bool ?? false
        _ = await snapshot("E-monaco-find")
        await keyEvent("\u{1b}", keyCode: 53, mods: [])
        await sleep(0.2)

        // 2. Cmd+C copies the selection
        let len = await js("return window.selectAllModified()") as? Int ?? -1
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("SENTINEL", forType: .string)
        await keyEvent("c", keyCode: 8, mods: [.command])
        await sleep(0.5)
        let pb = NSPasteboard.general.string(forType: .string) ?? ""
        r["cmdC_copiedChars"] = pb == "SENTINEL" ? 0 : pb.count
        r["cmdC_selectionChars"] = len

        // 3. Next Tab (Cmd+Shift+]) with the webview focused
        var n0 = wc.nextTabCount
        wc.select(env: 0, tab: 0); wc.focusCurrent(); await sleep(0.3)
        await keyEvent("}", keyCode: 30, mods: [.command, .shift])
        await sleep(0.4)
        r["nextTab_fromWebView"] = ["fired": wc.nextTabCount > n0, "selectedAfter": env.selected]

        // 4. Next Tab with a terminal focused
        n0 = wc.nextTabCount
        wc.select(env: 0, tab: 1); wc.focusCurrent(); await sleep(0.3)
        r["terminalFirstResponder"] = wc.window?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        await keyEvent("}", keyCode: 30, mods: [.command, .shift])
        await sleep(0.3)
        r["nextTab_fromTerminal"] = ["fired": wc.nextTabCount > n0, "selectedAfter": env.selected]

        // 5. Close Tab (Cmd+W) with a terminal focused, then with the webview focused
        var c0 = wc.closeTabCount
        let tabsBefore = env.tabs.count
        wc.select(env: 0, tab: env.tabs.count - 1); wc.focusCurrent(); await sleep(0.3)
        await keyEvent("w", keyCode: 13, mods: [.command])
        await sleep(0.3)
        r["closeTab_fromTerminal"] = ["fired": wc.closeTabCount > c0, "tabs": "\(tabsBefore)->\(env.tabs.count)"]
        c0 = wc.closeTabCount
        wc.select(env: 0, tab: 0); wc.focusCurrent(); await sleep(0.3)
        let tb = env.tabs.count
        await keyEvent("w", keyCode: 13, mods: [.command])
        await sleep(0.5)
        r["closeTab_fromWebView"] = ["fired": wc.closeTabCount > c0, "tabs": "\(tb)->\(env.tabs.count)"]
        r["metaKeysSeenByPage"] = pageKeys
        r["keyLog"] = keyLog

        // 6. the same through real HID events (System Events), if Accessibility allows it
        r["systemEvents"] = await realKeys(env)
        ed.onMessage = prevHandler
        return r
    }

    func osascript(_ script: String) -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let err = Pipe(); p.standardError = err; p.standardOutput = Pipe()
        try? p.run(); p.waitUntilExit()
        return (p.terminationStatus, String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }

    func realKeys(_ env: Environment) async -> [String: Any] {
        var r: [String: Any] = [:]
        // a diff + terminal again
        if !env.tabs.contains(where: { if case .diff = $0.kind { return true }; return false }) {
            wc.addDiff(to: env, title: "diff", payload: diffPayload())
        }
        if env.tabs.filter({ $0.terminal != nil }).count < 2 {
            _ = terminal(env, "shell 3", nil); _ = terminal(env, "shell 4", nil)
        }
        wc.refresh()
        let diffIndex = env.tabs.firstIndex { if case .diff = $0.kind { return true }; return false }!
        NSApp.activate(ignoringOtherApps: true)
        wc.window?.makeKeyAndOrderFront(nil)
        wc.select(env: 0, tab: diffIndex); wc.focusCurrent()
        await sleep(0.8)
        r["frontmost"] = NSApp.isActive
        _ = await js("return window.focusModified()")
        let (code, err) = osascript("tell application \"System Events\" to keystroke \"f\" using command down")
        r["osascriptExit"] = code
        r["osascriptError"] = err.trimmingCharacters(in: .whitespacesAndNewlines)
        if code != 0 { return r }
        await sleep(0.5)
        r["cmdF_findWidgetVisible"] = await js("return window.findVisible()") as? Bool ?? false
        _ = osascript("tell application \"System Events\" to key code 53")
        _ = await js("return window.selectAllModified()")
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString("SENTINEL", forType: .string)
        _ = osascript("tell application \"System Events\" to keystroke \"c\" using command down")
        await sleep(0.5)
        let pb = NSPasteboard.general.string(forType: .string) ?? ""
        r["cmdC_copiedChars"] = pb == "SENTINEL" ? 0 : pb.count
        var n0 = wc.nextTabCount
        _ = osascript("tell application \"System Events\" to keystroke \"]\" using {command down, shift down}")
        await sleep(0.5)
        r["nextTab_fromWebView"] = wc.nextTabCount > n0
        n0 = wc.nextTabCount
        r["firstResponderAfter"] = wc.window?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
        _ = osascript("tell application \"System Events\" to keystroke \"]\" using {command down, shift down}")
        await sleep(0.5)
        r["nextTab_fromTerminal"] = wc.nextTabCount > n0
        let c0 = wc.closeTabCount
        _ = osascript("tell application \"System Events\" to keystroke \"w\" using command down")
        await sleep(0.5)
        r["closeTab_fromTerminal"] = wc.closeTabCount > c0
        wc.select(env: 0, tab: env.tabs.firstIndex { if case .diff = $0.kind { return true }; return false } ?? 0)
        wc.focusCurrent(); await sleep(0.5)
        let c1 = wc.closeTabCount
        _ = osascript("tell application \"System Events\" to keystroke \"w\" using command down")
        await sleep(0.5)
        r["closeTab_fromWebView"] = wc.closeTabCount > c1
        return r
    }

    // MARK: F. memory

    func memory() async -> [String: Any] {
        let env = fresh("memory")
        let before = Set(psAll().filter { $0.command.contains("com.apple.WebKit") }.map(\.pid))
        var terms: [SpikeTerminal] = []
        for i in 0..<5 { terms.append(terminal(env, "shell \(i + 1)", nil, cwd: repoRoot)) }
        wc.addDiff(to: env, title: "diff", payload: diffPayload())
        var rendered = false
        let prev = wc.editor.onMessage
        wc.editor.onMessage = { m in prev?(m); if ["diffRendered", "diffComputed"].contains(m["type"] as? String ?? "") { rendered = true } }
        for i in 0..<5 { wc.select(env: 0, tab: i); await sleep(0.3) }
        wc.select(env: 0, tab: 5)
        await ensureActive()
        await waitUntil(30) { rendered }
        await sleep(5)
        let table = psAll()
        let me = table.first { $0.pid == getpid() }
        let webkit = table.filter { $0.command.contains("com.apple.WebKit") && !before.contains($0.pid) }
        let kids = terms.flatMap { [$0.childPid] + descendants(of: $0.childPid, in: table) }
        let kidRss = table.filter { kids.contains($0.pid) }.reduce(0) { $0 + $1.rssKB }
        let appMB = Double(me?.rssKB ?? 0) / 1024
        let wkMB = Double(webkit.reduce(0) { $0 + $1.rssKB }) / 1024
        // phys_footprint (what Activity Monitor shows as Memory) for the app itself
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        _ = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        _ = await snapshot("F-memory-diff-tab")
        for t in terms { t.terminate() }
        return [
            "appRssMB": Bench.r2(appMB),
            "appPhysFootprintMB": Bench.r2(Double(info.phys_footprint) / 1048576),
            "webkitProcesses": webkit.map { ["pid": Int($0.pid), "rssMB": Bench.r2(Double($0.rssKB) / 1024),
                                             "footprintMB": footprintMB($0.pid).map(Bench.r2) ?? -1,
                                             "name": ($0.command.split(separator: " ").first.map(String.init) ?? "").components(separatedBy: "/").last ?? ""] },
            "webkitRssMBSum": Bench.r2(wkMB),
            "webkitFootprintMBSum": Bench.r2(webkit.compactMap { footprintMB($0.pid) }.reduce(0, +)),
            "appFootprintMB": footprintMB(getpid()).map(Bench.r2) ?? -1,
            "appPlusWebkitMB": Bench.r2(appMB + wkMB),
            "shellChildrenRssMB": Bench.r2(Double(kidRss) / 1024),
        ]
    }
}

extension SpikeTerminal {
    private static var baseline: [ObjectIdentifier: Int] = [:]
    var bytesReceived0: Int {
        get { SpikeTerminal.baseline[ObjectIdentifier(self)] ?? 0 }
        set { SpikeTerminal.baseline[ObjectIdentifier(self)] = newValue }
    }
}
