import Foundation

/// Feeds the output of hidden terminal tabs to their emulators under a time budget per run-loop
/// turn, shared by every hidden tab, so a flood in a background environment delays that tab's
/// catch-up instead of the UI (spec Architecture, Terminals). Parsing is the cost, so batching
/// alone would not help; and nothing is ever dropped, because cutting the stream can split an
/// escape sequence and leave the terminal in the wrong mode.
///
/// Main thread only: queues are appended to from the PTY's delivery (the main queue) and turns
/// run on the main queue.
public final class HiddenFeedScheduler {
    /// The app's scheduler: 4 ms per turn for all hidden tabs together.
    public static let shared = HiddenFeedScheduler()

    private let budget: TimeInterval
    private let sliceSize: Int
    private let clock: () -> TimeInterval
    private let schedule: (@escaping () -> Void) -> Void
    private var queues: [Weak] = []
    private var turnPending = false
    private var nextIndex = 0

    private struct Weak { weak var queue: HiddenFeedQueue? }

    /// `clock` and `schedule` are test seams (monotonic seconds; the main queue).
    public init(budget: TimeInterval = 0.004, sliceSize: Int = 16 * 1024,
                clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                schedule: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) }) {
        self.budget = budget
        self.sliceSize = max(1, sliceSize)
        self.clock = clock
        self.schedule = schedule
    }

    /// A queue whose bytes reach `feed` in order, a slice at a time. The caller keeps it; a
    /// dropped queue is forgotten with whatever it still held.
    public func makeQueue(feed: @escaping (ArraySlice<UInt8>) -> Void) -> HiddenFeedQueue {
        let q = HiddenFeedQueue(scheduler: self, feed: feed)
        queues.append(Weak(queue: q))
        return q
    }

    /// The live queues (tests).
    public var queueCount: Int {
        queues.removeAll { $0.queue == nil }
        return queues.count
    }

    fileprivate func wake() {
        guard !turnPending else { return }
        turnPending = true
        schedule { [weak self] in self?.turn() }
    }

    /// One turn: a slice from each queue with bytes, round robin, until the budget is spent or
    /// nothing is left; another turn is scheduled while bytes remain.
    private func turn() {
        turnPending = false
        queues.removeAll { $0.queue == nil }
        let start = clock()
        var fedAny = true
        while fedAny {
            fedAny = false
            let count = queues.count
            for step in 0..<count {
                let i = (nextIndex + step) % count
                guard let q = queues[i].queue, q.hasPending else { continue }
                q.feedSlice(max: sliceSize)
                fedAny = true
                if clock() - start >= budget {
                    nextIndex = (i + 1) % max(1, count)
                    if queues.contains(where: { $0.queue?.hasPending == true }) { wake() }
                    return
                }
            }
        }
    }
}

/// One hidden tab's pending output.
public final class HiddenFeedQueue {
    private weak var scheduler: HiddenFeedScheduler?
    private let feed: (ArraySlice<UInt8>) -> Void
    private var buffer: [UInt8] = []
    private var offset = 0

    fileprivate init(scheduler: HiddenFeedScheduler, feed: @escaping (ArraySlice<UInt8>) -> Void) {
        self.scheduler = scheduler
        self.feed = feed
    }

    public var hasPending: Bool { offset < buffer.count }
    public var pendingCount: Int { buffer.count - offset }

    /// Queues bytes for a later turn.
    public func append<S: Sequence>(_ bytes: S) where S.Element == UInt8 {
        buffer.append(contentsOf: bytes)
        if hasPending { scheduler?.wake() }
    }

    /// Feeds everything queued now (the tab is shown).
    public func drainAll() {
        guard hasPending else { return }
        let rest = buffer[offset...]
        buffer = []
        offset = 0
        feed(rest)
    }

    fileprivate func feedSlice(max: Int) {
        let end = min(buffer.count, offset + max)
        let slice = buffer[offset..<end]
        offset = end
        if offset == buffer.count {
            buffer = []
            offset = 0
        } else if offset > 1 << 20 && offset * 2 > buffer.count {
            buffer.removeFirst(offset)
            offset = 0
        }
        feed(slice)
    }
}
