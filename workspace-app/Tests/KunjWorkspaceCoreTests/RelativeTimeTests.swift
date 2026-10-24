import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct RelativeTimeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func relativeTimeSteps() {
        #expect(relativeTime(now, now: now) == "now")
        #expect(relativeTime(now - 44, now: now) == "now")
        #expect(relativeTime(now - 45, now: now) == "1m")
        #expect(relativeTime(now - 120, now: now) == "2m")
        #expect(relativeTime(now - 3600, now: now) == "1h")
        #expect(relativeTime(now - 3 * 86400, now: now) == "3d")
        #expect(relativeTime(now - 14 * 86400, now: now) == "2w")
        #expect(relativeTime(now - 95 * 86400, now: now) == "3mo")
        #expect(relativeTime(now - 800 * 86400, now: now) == "2y")
    }

    @Test func futureDatesReadAsNow() {
        #expect(relativeTime(now + 600, now: now) == "now")
    }

    @Test func uptimeText() {
        #expect(uptime(since: now - (2 * 3600 + 14 * 60 + 5), now: now) == "2h 14m")
        #expect(uptime(since: now - 300, now: now) == "5m")
        #expect(uptime(since: now - 20, now: now) == "0m")
        #expect(uptime(since: now - (3 * 86400 + 3600), now: now) == "3d 1h")
    }
}
