import AppKit
import KunjWorkspaceCore

/// Language servers for the editor tabs (docs/specs/language-servers.md): one `kunj lsp run` child
/// per worktree and language, started when a tab of that language opens and stopped by `LspPolicy`
/// (tabs closed, idle, at most `maxServers`). Swift speaks LSP with the real file URIs it holds; the
/// page only sends tab ids, positions and its text. Definition and references open inside the
/// worktree only; without a server, or when it is slow or finds nothing, the search fallback runs.
@MainActor
final class LspCoordinator {
    private let cli: KunjCLI
    private let registry: TabRegistry
    private var config: LspListJson?
    private var policy: LspPolicy?
    private var connections: [LspKey: LspConnection] = [:]
    /// Open documents: tab id -> (server, URI, version).
    private var documents: [String: (key: LspKey, uri: String, version: Int)] = [:]
    /// Exits within the last 5 minutes per server; a third disables it until a tab of it reopens.
    private var crashes: [LspKey: [Date]] = [:]
    private var failed: Set<LspKey> = []
    /// Servers being stopped on purpose (their exit is not a crash).
    private var stopping: Set<LspKey> = []
    private var timer: Timer?
    private var menu: DefinitionMenu?
    /// The status bar's text (nil: none running).
    var onStatus: ((String?) -> Void)?
    /// Each worktree's language server memory in bytes, by standardized path, after every sample.
    var onMemory: (([String: Double]) -> Void)?
    /// The environment selected in the sidebar: the status bar shows its servers and only counts the rest.
    var selectedEnvId: String? { didSet { if oldValue != selectedEnvId { renderStatus() } } }
    /// A message for the editor column (a server failed, nothing found).
    var onMessage: ((String) -> Void)?

    init(cli: KunjCLI, registry: TabRegistry) {
        self.cli = cli
        self.registry = registry
        Task { await self.loadConfig() }
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func loadConfig() async {
        do {
            let list: LspListJson = try await cli.run(["lsp", "list", "--json"], cwd: NSHomeDirectory())
            config = list
            policy = LspPolicy(config: list)
            log("lsp: \(list.servers.filter(\.installed).map(\.language).joined(separator: ", ")) installed")
            for tab in registry.allEditors where tab.loaded { editorLoaded(tab) }
        } catch {
            log("lsp: kunj lsp list failed (\(error)); go to definition searches")
        }
    }

    private var page: MonacoWebView { registry.editorView }

    private func key(for tab: EditorTab) -> (LspKey, LspListJson.Server)? {
        guard tab.env.kind == .worktree, tab.env.path != nil, let server = config?.server(forPath: tab.path) else { return nil }
        let key = LspKey(envId: tab.env.id, language: server.language)
        return failed.contains(key) ? nil : (key, server)
    }

    private func uri(_ tab: EditorTab) -> String? {
        guard let root = tab.env.path else { return nil }
        return URL(fileURLWithPath: root).appendingPathComponent(tab.path).standardizedFileURL.absoluteString
    }

    // MARK: tabs

    /// A tab's file reached the page: its server starts (or is reused) and the document opens.
    func editorLoaded(_ tab: EditorTab) {
        guard documents[tab.id] == nil, var policy, let (key, server) = key(for: tab), let uri = uri(tab) else { return }
        documents[tab.id] = (key, uri, 1)
        let evict = policy.tabOpened(key, cached: server.restart == "cached", now: Date())
        self.policy = policy
        for k in evict ?? [] { stop(k) }
        if evict != nil { start(key, env: tab.env) }
        Task {
            await page.call("lspTrack", ["id": tab.id, "on": true])
            await self.sendOpen(tab.id)
        }
    }

    func editorClosed(_ tab: EditorTab) {
        guard let doc = documents.removeValue(forKey: tab.id) else { return }
        connections[doc.key]?.notify("textDocument/didClose", ["textDocument": ["uri": doc.uri]])
        policy?.tabClosed(doc.key, now: Date())
        // a tab of a failed server reopening later gives it another chance
        if !documents.values.contains(where: { $0.key == doc.key }) { failed.remove(doc.key) }
    }

    /// The page's text after an edit (debounced there).
    func textChanged(_ tab: EditorTab, text: String) {
        guard var doc = documents[tab.id], let c = connections[doc.key], c.isReady else { return }
        doc.version += 1
        documents[tab.id] = doc
        c.notify("textDocument/didChange", ["textDocument": ["uri": doc.uri, "version": doc.version],
                                            "contentChanges": [["text": text]]])
    }

    private func sendOpen(_ id: String) async {
        guard let doc = documents[id], let c = connections[doc.key], await c.waitReady(timeout: 120),
              let text = await page.call("lspText", ["id": id]) as? String else { return }
        let language = config?.servers.first { $0.language == doc.key.language }.map { languageId($0, uri: doc.uri) } ?? doc.key.language
        c.notify("textDocument/didOpen", ["textDocument": ["uri": doc.uri, "languageId": language, "version": doc.version, "text": text]])
    }

    /// LSP's language id for the file (typescript serves .js and .tsx too).
    private func languageId(_ server: LspListJson.Server, uri: String) -> String {
        switch (uri as NSString).pathExtension.lowercased() {
        case "ts", "mts", "cts": return "typescript"
        case "tsx": return "typescriptreact"
        case "js", "mjs", "cjs": return "javascript"
        case "jsx": return "javascriptreact"
        case "c", "h": return "c"
        case "cc", "cpp", "cxx", "hpp", "hh": return "cpp"
        case "m": return "objective-c"
        case "mm": return "objective-cpp"
        default: return server.language
        }
    }

    // MARK: servers

    private func start(_ key: LspKey, env: Environment) {
        guard let root = env.path else { return }
        let spec = cli.spawnSpec(["lsp", "run", key.language, "--branch", env.branch], cwd: env.repo.root)
        let c = LspConnection(key: key, root: root, spec: spec)
        branches[key] = env.branch
        roots[key] = (root as NSString).standardizingPath
        c.onNotification = { [weak self] method, params in
            guard method == "textDocument/publishDiagnostics" else { return }
            let p = params as? [String: Any]
            let uri = p?["uri"] as? String
            let markers = lspMarkers(p?["diagnostics"])
            Task { @MainActor in self?.diagnostics(uri: uri, markers: markers) }
        }
        c.onExit = { [weak self, weak c] status in
            Task { @MainActor in
                guard let self, let c else { return }
                self.exited(key, connection: c, status: status)
            }
        }
        connections[key] = c
        do {
            try c.start()
            log("lsp: started \(key)")
        } catch {
            log("lsp: \(key) could not start: \(error)")
            connections[key] = nil
            policy?.stopped(key)
        }
        updateStatus()
    }

    private func stop(_ key: LspKey) {
        guard let c = connections[key] else { policy?.stopped(key); return }
        stopping.insert(key)
        log("lsp: stopping \(key)")
        c.stop()
    }

    private func exited(_ key: LspKey, connection: LspConnection, status: Int32) {
        guard connections[key] === connection else { return }
        connections[key] = nil
        policy?.stopped(key)
        if stopping.remove(key) == nil {
            let now = Date()
            let recent = (crashes[key] ?? []).filter { now.timeIntervalSince($0) < 300 } + [now]
            crashes[key] = recent
            log("lsp: \(key) exited (\(status))")
            if recent.count > 2 {
                failed.insert(key)
                for (id, doc) in documents where doc.key == key { Task { await page.call("lspTrack", ["id": id, "on": false]) } }
                onMessage?("The \(key.language) language server keeps stopping; go to definition searches instead")
            }
        }
        updateStatus()
    }

    /// Makes sure `key`'s server runs (restarting a stopped one and reopening its documents); true
    /// once it answers within the ready timeout.
    private func ready(_ key: LspKey, env: Environment) async -> LspConnection? {
        guard var policy else { return nil }
        let evict = policy.used(key, now: Date())
        self.policy = policy
        if let evict {
            for k in evict { stop(k) }
            start(key, env: env)
            for (id, doc) in documents where doc.key == key {
                documents[id]?.version = 1
                Task { await self.sendOpen(id) }
            }
        }
        guard let c = connections[key] else { return nil }
        let timeout = (config?.readyTimeoutMs ?? 1500) / 1000
        return await c.waitReady(timeout: timeout) ? c : nil
    }

    private func tick() {
        guard let policy else { return }
        for key in policy.due(now: Date()) { stop(key) }
        updateStatus()
    }

    private func diagnostics(uri: String?, markers: [[String: Any]]) {
        guard let uri else { return }
        for (id, doc) in documents where doc.uri == uri {
            Task { await page.call("lspDiagnostics", ["id": id, "markers": markers]) }
        }
    }

    // MARK: requests

    /// Go to definition at a 1-based line and UTF-16 column; false when it should search instead
    /// (no server, not ready in time, nothing inside the worktree).
    func definition(_ tab: EditorTab, word: String, line: Int, column: Int) async -> Bool {
        await locations(tab, method: "textDocument/definition", title: "Declarations of \(word)", line: line, column: column,
                        extra: [:])
    }

    func references(_ tab: EditorTab, word: String, line: Int, column: Int) async -> Bool {
        await locations(tab, method: "textDocument/references", title: "References to \(word)", line: line, column: column,
                        extra: ["context": ["includeDeclaration": true]])
    }

    private func locations(_ tab: EditorTab, method: String, title: String, line: Int, column: Int, extra: [String: Any]) async -> Bool {
        guard let doc = documents[tab.id], let root = tab.env.path else { return false }
        let at = NSEvent.mouseLocation
        guard let c = await ready(doc.key, env: tab.env) else { return false }
        var params: [String: Any] = ["textDocument": ["uri": doc.uri], "position": ["line": line - 1, "character": column - 1]]
        for (k, v) in extra { params[k] = v }
        guard let result = try? await c.request(method, params) else { return false }
        let found: [DefinitionCandidate] = lspLocations(result).compactMap { loc in
            guard let rel = lspRelativePath(loc.path, root: root) else { return nil }
            let text = Self.line(loc.line, of: loc.path)
            let col = codePointColumn(utf16Column: loc.column, in: text)
            let length = max(0, codePointColumn(utf16Column: loc.endColumn, in: text) - col)
            return DefinitionCandidate(path: rel, line: loc.line, column: col, length: length,
                                       text: text.trimmingCharacters(in: .whitespaces), tier: 0, rank: [0])
        }
        guard !found.isEmpty else { return false }
        if found.count == 1 {
            open(found[0], env: tab.env)
        } else {
            menu = DefinitionMenu(word: "", title: title, candidates: found) { [weak self] c in self?.open(c, env: tab.env) }
            menu?.show(at: at)
        }
        return true
    }

    func hover(_ tab: EditorTab, req: Int, line: Int, column: Int) {
        Task {
            var markdown: String?
            if let doc = documents[tab.id], let c = await ready(doc.key, env: tab.env) {
                let result = try? await c.request("textDocument/hover", ["textDocument": ["uri": doc.uri],
                                                                         "position": ["line": line - 1, "character": column - 1]])
                markdown = lspHoverMarkdown(result ?? nil)
            }
            await page.call("lspHover", ["req": req, "markdown": markdown ?? ""])
        }
    }

    private func open(_ c: DefinitionCandidate, env: Environment) {
        registry.openEditor(env: env, path: c.path, at: (c.line, c.column, c.length)) { [weak self] reason in
            self?.onMessage?(reason)
        }
    }

    private static func line(_ n: Int, of path: String) -> String {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return "" }
        var i = 1
        for l in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if i == n { return String(l) }
            i += 1
        }
        return ""
    }

    // MARK: status

    private func updateStatus() {
        let running = connections.values.filter { $0.pid > 0 }
        guard !running.isEmpty else { sizes = [:]; onStatus?(nil); onMemory?([:]); return }
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-axo", "pid=,ppid=,rss="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        sizes = Dictionary(uniqueKeysWithValues: running.map { ($0.key, processTreeRSS(text, root: $0.pid)) })
        renderStatus()
        var memory: [String: Double] = [:]
        for (key, kb) in sizes { if let root = roots[key] { memory[root, default: 0] += Double(kb) * 1024 } }
        onMemory?(memory)
    }

    /// Memory (KB) of each server at the last `ps` sample.
    private var sizes: [LspKey: Int] = [:]

    /// The status text from the last sample; a selection change redraws without running `ps`.
    private func renderStatus() {
        let running = connections.values.filter { $0.pid > 0 && sizes[$0.key] != nil }
        guard !running.isEmpty else { onStatus?(nil); return }
        let here = running.filter { $0.key.envId == selectedEnvId }
        var parts = here.sorted { $0.key.language < $1.key.language }.map { c -> String in
            let kb = sizes[c.key] ?? 0
            let size = kb >= 1024 * 1024 ? String(format: "%.1f GB", Double(kb) / 1024 / 1024) : "\(kb / 1024) MB"
            return "\(c.key.language) \(size)"
        }
        let elsewhere = running.count - here.count
        if elsewhere > 0 {
            let servers = elsewhere == 1 ? "1 server" : "\(elsewhere) servers"
            parts.append(here.isEmpty ? "\(servers) in other worktrees" : "+\(elsewhere) elsewhere")
        }
        onStatus?(parts.joined(separator: " · "))
    }

    /// The branch each server was started for, so two worktrees' servers of one language are told apart.
    private var branches: [LspKey: String] = [:]
    /// The worktree path each server runs in (standardized), for the sidebar's memory total.
    private var roots: [LspKey: String] = [:]

    /// "typescript · feat/x": the language and the worktree's branch.
    func label(_ key: LspKey) -> String {
        branches[key].map { "\(key.language) · \($0)" } ?? key.language
    }

    /// The servers running now, for the Language Servers menu.
    var running: [LspKey] { connections.keys.sorted { $0.description < $1.description } }

    func stopServer(_ key: LspKey) { stop(key) }

    /// Quitting: every server gets shutdown/exit.
    func stopAll() {
        for key in connections.keys { stop(key) }
    }
}

/// Environment > Language Servers: one item per running server (`swift in kunj/worktree/main`) with
/// Stop, or "None running".
@MainActor
final class LanguageServersMenu: NSObject, NSMenuDelegate {
    private let coordinator: () -> LspCoordinator?

    init(_ coordinator: @escaping () -> LspCoordinator?) {
        self.coordinator = coordinator
    }

    nonisolated func menuNeedsUpdate(_ menu: NSMenu) {
        MainActor.assumeIsolated {
            menu.removeAllItems()
            let running = coordinator()?.running ?? []
            if running.isEmpty {
                let none = NSMenuItem(title: "None running", action: nil, keyEquivalent: "")
                none.isEnabled = false
                menu.addItem(none)
                return
            }
            for key in running {
                let item = NSMenuItem(title: "Stop \(coordinator()?.label(key) ?? key.language)", action: #selector(stop(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = key
                menu.addItem(item)
            }
        }
    }

    @objc private func stop(_ item: NSMenuItem) {
        guard let key = item.representedObject as? LspKey else { return }
        coordinator()?.stopServer(key)
    }
}
