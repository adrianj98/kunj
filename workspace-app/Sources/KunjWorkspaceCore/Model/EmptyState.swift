/// What the app is doing before the sidebar has anything to show: finding kunj (the login-shell
/// PATH and `kunj -V`, seconds when the shell is slow), then the first full listing.
public enum LoadingStep: Equatable, Sendable {
    case findingKunj
    case listing

    public var detail: String {
        switch self {
        case .findingKunj: return "Finding kunj"
        case .listing: return "Listing worktrees and containers"
        }
    }
}

/// The message in place of the columns when no environment is shown.
public struct EmptyStateText: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case muted, error }

    public var title: String
    public var detail: String?
    public var tone: Tone
    public var spinner: Bool

    public init(title: String, detail: String?, tone: Tone, spinner: Bool) {
        self.title = title
        self.detail = detail
        self.tone = tone
        self.spinner = spinner
    }
}

/// A discovery error wins (kunj missing or too old), then loading, then the empty list.
public func emptyStateText(discoveryError: String?, discoveryDetail: String?, loading: LoadingStep?,
                           hasRepos: Bool) -> EmptyStateText {
    if let discoveryError {
        // "too old" already says how to update
        let detail = discoveryDetail
            ?? (discoveryError.contains("npm install") ? nil : "Install or update it with npm install -g kunj")
        return EmptyStateText(title: discoveryError, detail: detail, tone: .error, spinner: false)
    }
    if let loading {
        return EmptyStateText(title: "Loading sessions…", detail: loading.detail, tone: .muted, spinner: true)
    }
    if !hasRepos {
        return EmptyStateText(title: "No repositories yet", detail: "Run kunj in a repository to add it",
                              tone: .muted, spinner: false)
    }
    return EmptyStateText(title: "Select an environment", detail: nil, tone: .muted, spinner: false)
}
