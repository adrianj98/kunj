// Notifications when a worktree's pull request changes between refreshes:
// checks failing or passing, an approval, a merge.

import Foundation
import UserNotifications

final class Notifier {
    // Last seen pull request per worktree path; nil until the first refresh,
    // so starting the app does not announce every existing PR
    private var previous: [String: PullRequest]?
    private var authorized = false

    // UNUserNotificationCenter needs a bundle; `swift run` has none
    private var available: Bool { Bundle.main.bundleIdentifier != nil }

    func requestAuthorization() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            self.authorized = granted
        }
    }

    func update(with worktrees: [(repo: String, worktree: Worktree)]) {
        var current: [String: PullRequest] = [:]
        for entry in worktrees {
            if let pr = entry.worktree.pullRequest { current[entry.worktree.path] = pr }
        }
        defer { previous = current }
        guard let previous, UserDefaults.standard.kunjNotifyPullRequests else { return }

        for entry in worktrees {
            guard let pr = current[entry.worktree.path], let old = previous[entry.worktree.path], old.number == pr.number else { continue }
            if let message = Self.describeChange(from: old, to: pr) {
                post(title: "\(entry.repo) · \(entry.worktree.name)", body: "#\(pr.number) \(message): \(pr.title)", url: pr.url)
            }
        }
    }

    static func describeChange(from old: PullRequest, to new: PullRequest) -> String? {
        if old.state != new.state {
            return new.state == "merged" ? "merged" : new.state == "closed" ? "closed" : "reopened"
        }
        if old.reviewDecision != new.reviewDecision {
            switch new.reviewDecision {
            case "APPROVED": return "approved"
            case "CHANGES_REQUESTED": return "changes requested"
            default: break
            }
        }
        if old.checks != new.checks {
            switch new.checks {
            case "failure": return "checks failed"
            case "success" where old.checks == "pending" || old.checks == "failure": return "checks passed"
            default: break
            }
        }
        return nil
    }

    private func post(title: String, body: String, url: String) {
        guard available, authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["url": url]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
