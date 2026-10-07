// Watches ~/.kunj for changes to worktree-sessions.json (an editor opened or
// closed a worktree) and repos.json (a repository was added). The CLI writes
// both atomically with a rename, so the directory is watched rather than the
// files, and a change is detected by comparing modification times.
//
// Our own `kunj worktree list` calls write files in this directory too (the
// PR cache, pruned sessions), so the store snapshots the times after each
// refresh and only a change since then triggers another one.

import Foundation

final class KunjDirWatcher {
    static let watchedFiles = ["worktree-sessions.json", "repos.json"]

    private let directory: URL
    private var source: DispatchSourceFileSystemObject?
    private var debounce: DispatchWorkItem?
    private var snapshot: [String: Date] = [:]
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".kunj")
        self.onChange = onChange
    }

    func start() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in self?.scheduleCheck() }
        source.setCancelHandler { close(fd) }
        source.resume()
        self.source = source
        markSeen()
    }

    // Remember the current modification times; later events compare against these
    func markSeen() {
        snapshot = currentTimes()
    }

    private func currentTimes() -> [String: Date] {
        var times: [String: Date] = [:]
        for name in Self.watchedFiles {
            let path = directory.appendingPathComponent(name).path
            if let date = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date {
                times[name] = date
            }
        }
        return times
    }

    private func scheduleCheck() {
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let now = self.currentTimes()
            if now != self.snapshot {
                self.snapshot = now
                self.onChange()
            }
        }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    deinit {
        source?.cancel()
    }
}
