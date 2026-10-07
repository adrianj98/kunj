// Codable mirrors of the kunj CLI's JSON output. Keep in step with
// vscode-extension/src/kunjCli.ts: both read the same contract. Enum-like
// fields are plain strings so a new value from a newer CLI does not break
// decoding.

import Foundation

struct KnownRepo: Codable, Hashable, Identifiable {
    let root: String
    let gitCommonDir: String
    let name: String
    let bare: Bool
    let hidden: Bool?
    let lastSeen: String
    let exists: Bool

    var id: String { root }
}

struct ReposResult: Codable {
    let repos: [KnownRepo]
}

struct WorktreeSession: Codable, Hashable, Identifiable {
    let id: String
    let path: String
    let pid: Int
    let host: String
    let editor: String
    let label: String?

    var displayName: String {
        let editorName = editor == "vscode" ? "VS Code" : editor
        if let label, !label.isEmpty { return "\(editorName) “\(label)”" }
        return editorName
    }
}

struct WorktreeStatus: Codable, Hashable {
    let dirty: Bool
    let changedFiles: Int
    let ahead: Int?
    let behind: Int?
    let upstream: String?
}

struct PullRequest: Codable, Hashable {
    let provider: String
    let number: Int
    let title: String
    let state: String // open | merged | closed
    let url: String
    let draft: Bool
    let baseBranch: String?
    let headBranch: String
    let reviewDecision: String?
    let checks: String? // success | failure | pending
    let updatedAt: String?

    var displayState: String { state == "open" && draft ? "draft" : state }

    // Compact badge, e.g. "#42 ✓", "#42 ✗", "#42 merged"
    var badge: String {
        guard state == "open" else { return "#\(number) \(state)" }
        let check: String
        switch checks {
        case "success": check = " ✓"
        case "failure": check = " ✗"
        case "pending": check = " …"
        default: check = ""
        }
        return "#\(number)\(draft ? " draft" : "")\(check)"
    }
}

struct Worktree: Codable, Hashable, Identifiable {
    let path: String
    let name: String
    let head: String?
    let branch: String?
    let detached: Bool
    let bare: Bool
    let locked: Bool
    let lockedReason: String?
    let prunable: Bool
    let prunableReason: String?
    let isMain: Bool
    let exists: Bool
    let sessions: [WorktreeSession]
    let status: WorktreeStatus?
    let pullRequest: PullRequest?

    var id: String { path }
}

struct WorktreeListResult: Codable {
    let repoRoot: String
    let currentPath: String?
    let pullRequestLookup: String?
    let pullRequestsFromCache: Bool?
    let worktrees: [Worktree]
}

struct BranchListResult: Codable {
    struct Branch: Codable, Hashable {
        let name: String
        let current: Bool
        let lastActivity: String?
        let description: String?
    }
    let branches: [Branch]
}

struct AddWorktreeResult: Codable {
    // The CLI falls back to just { path, branch } when it cannot re-list
    struct Created: Codable {
        let path: String
        let branch: String?
    }
    let success: Bool
    let worktree: Created
    let createdBranch: Bool?
}

struct PullRequestLookupResult: Codable {
    let branch: String
    let path: String
    let pullRequest: PullRequest?
}

struct PruneResult: Codable {
    let success: Bool
    let output: String
}

// Results we only check for success
struct SuccessResult: Codable {
    let success: Bool
}
