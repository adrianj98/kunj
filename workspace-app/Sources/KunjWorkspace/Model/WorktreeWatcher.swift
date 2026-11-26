import CoreServices
import Foundation
import KunjWorkspaceCore

/// Watches the selected worktree's files with FSEvents so the Files and Changes columns follow an
/// edit, a new or a deleted file at once instead of on `kunj events`' status poll (10 s, untracked
/// files every minute). One stream for the selected host worktree only; a container's clone cannot
/// be watched from the Mac and still follows the poll. Events inside `.git` (their changes come as
/// `git` events) and inside ignored folders (`node_modules`, build output, from one `git ls-files`
/// when the watch starts and again when a `.gitignore` changes) are dropped, so a build does not
/// reload the columns. The columns debounce what is left.
final class WorktreeWatcher {
    /// A change that matters in the watched environment.
    var onChange: (Environment) -> Void = { _ in }
    /// The ignored folders of an environment (relative, no trailing slash); nil while kunj is not
    /// found yet, asked again on the next `watch`.
    var ignoredDirectories: (Environment) async -> [String]? = { _ in nil }

    private(set) var environment: Environment?
    private var stream: FSEventStreamRef?
    /// The watched root as given and as FSEvents reports it (`/tmp` is `/private/tmp`), with a slash
    private var prefixes: [String] = []
    private var ignored: [String] = []
    private var ignoredLoaded = false
    private var generation = 0

    deinit { stop() }

    /// Watches `env` when it is an existing host worktree, else nothing. The same worktree again
    /// keeps its stream.
    func watch(_ env: Environment?) {
        let path = env.flatMap { $0.kind == .worktree && $0.exists ? $0.path : nil }
        if let path, let current = environment, current.id == env?.id, current.path == path, stream != nil {
            environment = env
            if !ignoredLoaded { loadIgnored(current) }
            return
        }
        stop()
        guard let env, let path, FileManager.default.fileExists(atPath: path) else { return }
        environment = env
        let root = (path as NSString).standardizingPath
        let real = realpath(root, nil).map { p -> String in defer { free(p) }; return String(cString: p) } ?? root
        prefixes = Array(Set([root, real])).map { $0.hasSuffix("/") ? $0 : $0 + "/" }
        loadIgnored(env)

        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<WorktreeWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            watcher.received(Array(list.prefix(count)))
        }
        let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents
                           | kFSEventStreamCreateFlagWatchRoot)
        guard let s = FSEventStreamCreate(kCFAllocatorDefault, callback, &context, [root] as CFArray,
                                          FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3, flags)
        else { return }
        FSEventStreamSetDispatchQueue(s, .main)
        guard FSEventStreamStart(s) else {
            FSEventStreamInvalidate(s); FSEventStreamRelease(s)
            return
        }
        stream = s
    }

    func stop() {
        generation += 1
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        stream = nil
        environment = nil
        ignored = []
        ignoredLoaded = false
    }

    private func loadIgnored(_ env: Environment) {
        let gen = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let dirs = await self.ignoredDirectories(env), gen == self.generation else { return }
            self.ignored = dirs
            self.ignoredLoaded = true
        }
    }

    /// On the main queue (the stream's dispatch queue).
    private func received(_ paths: [String]) {
        guard let env = environment else { return }
        var matters = false
        var gitignore = false
        for path in paths {
            guard let prefix = prefixes.first(where: { path.hasPrefix($0) || path + "/" == $0 }) else { continue }
            let relative = path.count >= prefix.count ? String(path.dropFirst(prefix.count)) : ""
            if relative.hasSuffix(".gitignore") { gitignore = true }
            if worktreeEventMatters(relative, ignoredDirectories: ignored) { matters = true }
        }
        if gitignore { loadIgnored(env) }
        if matters { onChange(env) }
    }
}
