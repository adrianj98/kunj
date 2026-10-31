import Foundation

/// A repository the user's gh login can clone, from `kunj repos github --json` (kunj 1.x with
/// `repos github`; older ones fail with "Unknown repos action").
public struct GitHubRepo: Decodable, Equatable, Sendable {
    public var fullName: String
    public var owner: String
    public var name: String
    public var description: String?
    public var `private`: Bool
    public var fork: Bool
    public var archived: Bool
    public var pushedAt: String?
    public var url: String
    public var defaultBranch: String
    /// The root of the known repository cloned from it, nil when there is none.
    public var local: String?

    public init(fullName: String, owner: String, name: String, description: String? = nil, private: Bool = false,
                fork: Bool = false, archived: Bool = false, pushedAt: String? = nil, url: String = "",
                defaultBranch: String = "main", local: String? = nil) {
        self.fullName = fullName
        self.owner = owner
        self.name = name
        self.description = description
        self.private = `private`
        self.fork = fork
        self.archived = archived
        self.pushedAt = pushedAt
        self.url = url
        self.defaultBranch = defaultBranch
        self.local = local
    }
}

public struct GitHubReposJson: Decodable, Equatable, Sendable {
    public var repos: [GitHubRepo]
}

/// `kunj repos clone --json`: where it went (the checkout, or the bare repository and its
/// default branch's worktree).
public struct RepoCloneJson: Decodable, Equatable, Sendable {
    public var path: String
    public var bare: Bool
    public var worktree: String?
}

public enum GitHubRepos {
    public static func listArguments() -> [String] { ["repos", "github"] }

    /// `fullName` is `owner/name` from the listing; it never starts with `-` (GitHub names
    /// cannot), so it cannot read as an option.
    public static func cloneArguments(_ repo: GitHubRepo) -> [String] { ["repos", "clone", repo.fullName] }

    /// The rows matching `query`: every word must appear in the full name or the description,
    /// any case. Not cloned before cloned, each kept in the listing's (most recently pushed) order.
    public static func filter(_ repos: [GitHubRepo], query: String) -> [GitHubRepo] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let matching = repos.filter { repo in
            let text = (repo.fullName + " " + (repo.description ?? "")).lowercased()
            return words.allSatisfy { text.contains($0) }
        }
        return matching.filter { $0.local == nil } + matching.filter { $0.local != nil }
    }
}
