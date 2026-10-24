import Foundation
import Testing
@testable import KunjWorkspaceCore

/// A scheduler whose turns run only when the test calls `turn()`, with a clock the feeds advance.
private final class Harness {
    var now: TimeInterval = 0
    var scheduled: [() -> Void] = []
    lazy var scheduler = HiddenFeedScheduler(
        budget: 0.004, sliceSize: 4, clock: { [unowned self] in self.now },
        schedule: { [unowned self] f in self.scheduled.append(f) })

    /// Runs the pending turn; false when none was scheduled.
    @discardableResult
    func turn() -> Bool {
        guard !scheduled.isEmpty else { return false }
        let f = scheduled.removeFirst()
        f()
        return true
    }
}

@Suite struct HiddenFeedSchedulerTests {
    @Test func feedsEveryByteInOrder() {
        let h = Harness()
        var out: [UInt8] = []
        let q = h.scheduler.makeQueue { out.append(contentsOf: $0) }
        let input = (0..<200).map { UInt8($0 % 251) }
        q.append(input[0..<120])
        q.append(input[120...])
        while h.turn() {}
        #expect(out == input)
        #expect(!q.hasPending)
    }

    @Test func aTurnStopsAtTheBudget() {
        let h = Harness()
        var fed = 0
        // every slice costs 1 ms: a 4 ms budget feeds four slices per turn
        let q = h.scheduler.makeQueue { fed += $0.count; h.now += 0.001 }
        q.append(ArraySlice(repeating: 1, count: 40))
        #expect(h.scheduled.count == 1)
        h.turn()
        #expect(fed == 16)
        #expect(h.scheduled.count == 1)
        while h.turn() {}
        #expect(fed == 40)
    }

    @Test func theBudgetIsSharedAcrossQueuesRoundRobin() {
        let h = Harness()
        var a = 0, b = 0
        let qa = h.scheduler.makeQueue { a += $0.count; h.now += 0.001 }
        let qb = h.scheduler.makeQueue { b += $0.count; h.now += 0.001 }
        qa.append(ArraySlice(repeating: 1, count: 100))
        qb.append(ArraySlice(repeating: 2, count: 100))
        h.turn()
        #expect(a + b == 16)
        #expect(a == 8 && b == 8)
        while h.turn() {}
        #expect(a == 100 && b == 100)
    }

    @Test func drainAllFeedsAtOnceAndLeavesNothingQueued() {
        let h = Harness()
        var out: [UInt8] = []
        let q = h.scheduler.makeQueue { out.append(contentsOf: $0) }
        q.append(ArraySlice(Array(repeating: 7, count: 50)))
        q.drainAll()
        #expect(out.count == 50)
        #expect(!q.hasPending)
        // a stale turn finds nothing to do and schedules no other
        while h.turn() {}
        #expect(out.count == 50)
    }

    @Test func oneTurnIsScheduledAtATime() {
        let h = Harness()
        let q = h.scheduler.makeQueue { _ in }
        q.append([1, 2, 3])
        q.append([4, 5, 6])
        #expect(h.scheduled.count == 1)
    }

    @Test func aDroppedQueueIsForgotten() {
        let h = Harness()
        var fed = 0
        var q: HiddenFeedQueue? = h.scheduler.makeQueue { fed += $0.count }
        q?.append([1, 2, 3, 4, 5])
        q = nil
        while h.turn() {}
        #expect(fed == 0)
        #expect(h.scheduler.queueCount == 0)
    }
}
