import Foundation

/// Something changed in a repository that the Changes and Files columns may show: a `git` event
/// (`container` nil: the host repository, any of its worktrees, since the event names only the
/// repository) or a branch container's `status` event (its container and branch named).
public struct RepoChange: Equatable, Sendable {
    public var root: String
    /// The branch container whose status changed; nil for a change on the host.
    public var container: String?
    public var branch: String?

    public init(root: String, container: String? = nil, branch: String? = nil) {
        self.root = root
        self.container = container
        self.branch = branch
    }

    /// A change of `env` itself (a file saved in one of its tabs).
    public init(env: Environment) {
        self.init(root: env.repo.root,
                  container: env.kind == .container ? (env.containerName ?? env.branch) : nil,
                  branch: env.kind == .container ? env.branch : nil)
    }

    /// Whether `env` may show something else after this change. A host change concerns every
    /// worktree of the repository (a git event does not say which one) and no container, whose
    /// clone is its own; a container's change concerns only that container.
    public func concerns(_ env: Environment) -> Bool {
        guard env.repo.root == root else { return false }
        guard container != nil || branch != nil else { return env.kind == .worktree }
        guard env.kind == .container else { return false }
        // the container's name when both know it (it is the container), else the branch
        if let container, let name = env.containerName { return name == container }
        return branch == env.branch
    }
}

/// Runs a reload at most once at a time: a request while one runs queues one more run after it
/// (any number of requests make one), and a request while hidden is remembered and run once when
/// shown again. Requests and runs are on the main actor.
@MainActor
public final class SerialReloader {
    private let work: @MainActor () async -> Void
    public private(set) var isRunning = false
    private var queued = false
    /// A request came while hidden.
    private var missed = false
    /// False while the window is not on screen: requests wait for it to come back.
    public var isVisible = true {
        didSet {
            guard isVisible != oldValue, isVisible, missed else { return }
            missed = false
            request()
        }
    }

    public init(_ work: @escaping @MainActor () async -> Void) {
        self.work = work
    }

    public func request() {
        guard isVisible else { missed = true; return }
        if isRunning { queued = true; return }
        isRunning = true
        Task { @MainActor in
            repeat {
                queued = false
                await work()
            } while queued && isVisible
            if queued { queued = false; missed = true }
            isRunning = false
        }
    }

    /// Forgets a queued or missed run (the column was closed); a running one finishes.
    public func cancelPending() {
        queued = false
        missed = false
    }
}
