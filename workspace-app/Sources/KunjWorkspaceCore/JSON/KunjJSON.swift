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
    /// Since 1.3.0; see `kunjDirName`
    public var kunjName: String?

    /// The directory kunj keeps the repository's files in (`~/.kunj/<this>`). An older kunj does
    /// not send it: then the folder without `.git`, kunj's own fallback without an origin.
    public var kunjDirName: String { kunjName ?? folderDirName(name) }
}

func folderDirName(_ name: String) -> String {
    name.hasSuffix(".git") ? String(name.dropLast(4)) : name
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
    /// Every running agent session (absent from kunj before 1.3 and when tmux could not be asked)
    public var sessions: [AgentSessionInfo]?

    public init(running: Bool?, session: String?, state: String?, sessions: [AgentSessionInfo]? = nil) {
        self.running = running
        self.session = session
        self.state = state
        self.sessions = sessions
    }
}

/// One running agent session: `id` is the `--session <id>` it was started with, nil for the
/// default session.
public struct AgentSessionInfo: Decodable, Equatable, Sendable {
    public var session: String
    public var id: String?
    public var state: String?

    public init(session: String, id: String?, state: String? = nil) {
        self.session = session
        self.id = id
        self.state = state
    }
}

// ---- kunj ct list --json

public struct ContainerListJson: Decodable, Equatable, Sendable {
    public var repo: String
    public var backend: Backend
    public var containers: [ContainerJson]
    /// Every backend the listing asked (this Mac's Docker, then each `kunj remote`); nil from a kunj
    /// that lists one backend only
    public var backends: [BackendInfo]?
    /// Cloud machines with no container row: asleep, not answering, or without a container yet
    /// (nil from a kunj that does not list machines)
    public var machines: [MachineRow]?

    /// One cloud machine as its coordinator lists it; `remote` is the coordinator.
    public struct MachineRow: Decodable, Equatable, Sendable {
        public var name: String
        /// `running`, `suspended`, `stopped`, `provisioning`, …
        public var state: String
        public var branch: String
        public var size: String
        public var remote: String
        public var provider: String?
    }

    public struct Backend: Decodable, Equatable, Sendable {
        public var kind: String
        public var context: String?
        /// The default backend's remote name (`container.remote`); nil for this Mac
        public var remote: String?
    }

    /// One backend of the fleet: `available` false when it did not answer (its containers are then
    /// missing from the listing, not gone).
    public struct BackendInfo: Decodable, Equatable, Sendable {
        public var kind: String
        public var remote: String?
        public var available: Bool
        public var message: String?

        public init(kind: String, remote: String?, available: Bool, message: String? = nil) {
            self.kind = kind
            self.remote = remote
            self.available = available
            self.message = message
        }
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
    /// The `kunj serve` remote the container is on; nil on this Mac's Docker
    public var remote: String?
    /// The cloud machine the container runs on, when its remote coordinates machines
    public var machine: MachineInfo?

    public struct Blueprint: Decodable, Equatable, Sendable {
        public var hash: String
        public var stale: Bool?
    }
}

/// The cloud machine behind a container row: its name, the cloud's state for it and its size.
public struct MachineInfo: Decodable, Equatable, Sendable {
    public var name: String
    public var state: String
    public var size: String

    public init(name: String, state: String, size: String) {
        self.name = name
        self.state = state
        self.size = size
    }

    /// Asleep: its disk (and memory, when suspended) is kept, and starting the branch wakes it.
    public var asleep: Bool { state == "suspended" || state == "stopped" || state == "suspending" || state == "stopping" }
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
