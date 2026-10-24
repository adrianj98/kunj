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

    // Open in an editor window right now
    var isActive: Bool { !sessions.isEmpty }
}

// A branch container (`kunj ct`) as `kunj worktree list --containers` reports it
struct ContainerPort: Codable, Hashable {
    let container: Int
    let host: Int
    let kind: String // publish | forward
    let service: String?

    var label: String {
        "localhost:\(host) → \(service.map { "\($0):\(container)" } ?? String(container))"
    }
}

struct BranchContainer: Codable, Hashable, Identifiable {
    struct Agent: Codable, Hashable {
        let running: Bool?
        let state: String? // running | waiting
    }
    struct Workspace: Codable, Hashable {
        let head: String?
        let ahead: Int?
        let dirty: Bool?
    }
    struct Service: Codable, Hashable {
        let name: String
        let state: String
    }
    struct Blueprint: Codable, Hashable {
        let stale: Bool?
    }

    let branch: String
    let name: String
    let state: String
    let image: String
    let firewall: String?
    let dind: String?
    let ports: [ContainerPort]
    let agent: Agent
    let workspace: Workspace
    let status: String?
    let services: [Service]
    let blueprint: Blueprint?
    let pullRequest: PullRequest?

    var id: String { name }
    var isRunning: Bool { state == "running" }
    var agentWaiting: Bool { agent.running == true && agent.state == "waiting" }
}

struct ContainerListing: Codable {
    let available: Bool
    let message: String?
    let items: [BranchContainer]
}

struct WorktreeListResult: Codable {
    let repoRoot: String
    let currentPath: String?
    let pullRequestLookup: String?
    let pullRequestsFromCache: Bool?
    let worktrees: [Worktree]
    // Only with --containers
    let containers: ContainerListing?
}

struct ContainerOpenResult: Codable {
    let success: Bool
    let uri: String?
    let warning: String?
    let exec: String?
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
