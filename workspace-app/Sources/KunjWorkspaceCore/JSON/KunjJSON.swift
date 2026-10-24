import Foundation

// Decodable mirrors of the CLI's published JSON contract (src/lib/json-types.ts and the types it
// imports). Optional where the TypeScript type is optional or nullable; keys the app does not use
// are left out and ignored, so a newer kunj that adds fields still decodes.

// ---- kunj repos --json

public struct ReposJson: Decodable, Equatable, Sendable {
    public var repos: [KnownRepo]
}

public struct KnownRepo: Decodable, Equatable, Sendable {
    public var root: String
    public var gitCommonDir: String
    public var name: String
    public var bare: Bool
    public var hidden: Bool?
    public var exists: Bool
    public var lastSeen: String
}

// ---- kunj worktree list --json

public struct WorktreeListJson: Decodable, Equatable, Sendable {
    public var repoRoot: String
    public var worktrees: [WorktreeJson]
}

public struct WorktreeJson: Decodable, Equatable, Sendable {
    public var path: String
    public var name: String
    public var head: String?
    public var branch: String?
    public var detached: Bool
    public var bare: Bool
    public var isMain: Bool
    public var exists: Bool
    public var isCurrent: Bool
    public var status: WorktreeStatus?
    public var pullRequest: PullRequestInfo?
    public var sessions: [WorktreeSession]
    public var agent: AgentState?
    public var openCount: Int
    public var changedFiles: Int?
}

public struct WorktreeStatus: Decodable, Equatable, Sendable {
    public var dirty: Bool
    public var changedFiles: Int
    public var ahead: Int?
    public var behind: Int?
    public var upstream: String?
}

public struct PullRequestInfo: Decodable, Equatable, Sendable {
    public var provider: String
    public var number: Int
    public var title: String
    /// `open`, `merged` or `closed`
    public var state: String
    public var url: String
    public var draft: Bool
    public var baseBranch: String?
    public var headBranch: String
    public var reviewDecision: String?
    /// `success`, `failure`, `pending` or nil
    public var checks: String?
    public var updatedAt: String?

    public init(provider: String, number: Int, title: String, state: String, url: String, draft: Bool,
                baseBranch: String?, headBranch: String, reviewDecision: String?, checks: String?,
                updatedAt: String?) {
        self.provider = provider
        self.number = number
        self.title = title
        self.state = state
        self.url = url
        self.draft = draft
        self.baseBranch = baseBranch
        self.headBranch = headBranch
        self.reviewDecision = reviewDecision
        self.checks = checks
        self.updatedAt = updatedAt
    }
}

public struct WorktreeSession: Decodable, Equatable, Sendable {
    public var id: String
    public var path: String
    public var pid: Int
    public var editor: String
    public var label: String?
}

/// The agent of a worktree (`session` set) or a container (no `session`). `running` is nil when
/// it could not be determined (no tmux); `state` is `running`, `waiting` or nil and counts only
/// while `running` is true.
public struct AgentState: Decodable, Equatable, Sendable {
    public var running: Bool?
    public var session: String?
    public var state: String?

    public init(running: Bool?, session: String?, state: String?) {
        self.running = running
        self.session = session
        self.state = state
    }
}

// ---- kunj ct list --json

public struct ContainerListJson: Decodable, Equatable, Sendable {
    public var repo: String
    public var backend: Backend
    public var containers: [ContainerJson]

    public struct Backend: Decodable, Equatable, Sendable {
        public var kind: String
        public var context: String?
    }
}

public struct ContainerJson: Decodable, Equatable, Sendable {
    public var branch: String
    public var name: String
    public var id: String
    /// Docker's state: `running`, `exited`, `created`, …
    public var state: String
    public var image: String
    public var createdAt: String
    public var firewall: String
    /// `ok`, `timeout`, `error`, `stopped` or `skipped`: how the status exec went
    public var status: String
    public var ports: [ContainerPortJson]
    public var agent: AgentState
    public var workspace: ContainerWorkspace
    public var services: [ServiceState]
    public var blueprint: Blueprint?

    public struct Blueprint: Decodable, Equatable, Sendable {
        public var hash: String
        public var stale: Bool?
    }
}

public struct ContainerPortJson: Decodable, Equatable, Sendable {
    public var container: Int
    public var host: Int
    /// `publish` or `forward`
    public var kind: String
    public var service: String?

    public init(container: Int, host: Int, kind: String, service: String?) {
        self.container = container
        self.host = host
        self.kind = kind
        self.service = service
    }
}

public struct ContainerWorkspace: Decodable, Equatable, Sendable {
    public var head: String?
    public var ahead: Int?
    public var dirty: Bool?
}

public struct ServiceState: Decodable, Equatable, Sendable {
    public var name: String
    public var state: String
    public var port: Int?

    public init(name: String, state: String, port: Int?) {
        self.name = name
        self.state = state
        self.port = port
    }
}

// ---- kunj ct file --json and plain results

public struct FileReadJson: Decodable, Equatable, Sendable {
    public var path: String
    public var content: String
}

public struct FileWriteJson: Decodable, Equatable, Sendable {
    public var success: Bool
    public var path: String
}

public struct SuccessJson: Decodable, Equatable, Sendable {
    public var success: Bool
}

// ---- errors

/// kunj's `--json` error document: `{ "error": "msg" }` or `{ "error": { code, message } }`.
public struct ErrorJson: Decodable, Equatable, Sendable {
    public var code: String?
    public var message: String

    private enum Keys: String, CodingKey { case error }
    private struct Detail: Decodable { let code: String?; let message: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let message = try? c.decode(String.self, forKey: .error) {
            code = nil
            self.message = message
        } else {
            let d = try c.decode(Detail.self, forKey: .error)
            code = d.code
            message = d.message
        }
    }
}
