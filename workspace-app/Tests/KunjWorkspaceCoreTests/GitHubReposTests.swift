import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct GitHubReposTests {
    @Test func theListingDecodes() throws {
        let json = """
        {"repos":[{"fullName":"a/b","owner":"a","name":"b","description":null,"private":true,"fork":false,
        "archived":false,"pushedAt":"2026-10-31T18:31:56Z","url":"https://github.com/a/b","defaultBranch":"main",
        "local":"/Users/me/projects/b"}]}
        """
        let doc = try JSONDecoder().decode(GitHubReposJson.self, from: Data(json.utf8))
        #expect(doc.repos == [GitHubRepo(fullName: "a/b", owner: "a", name: "b", private: true,
                                         pushedAt: "2026-10-31T18:31:56Z", url: "https://github.com/a/b",
                                         local: "/Users/me/projects/b")])
    }

    @Test func theFilterMatchesEveryWordAndPutsClonedLast() {
        let repos = [
            GitHubRepo(fullName: "me/kunj", owner: "me", name: "kunj", description: "Branch CLI", local: "/k"),
            GitHubRepo(fullName: "org/site", owner: "org", name: "site", description: "Landing page"),
            GitHubRepo(fullName: "me/cli-tools", owner: "me", name: "cli-tools"),
        ]
        #expect(GitHubRepos.filter(repos, query: "").map(\.name) == ["site", "cli-tools", "kunj"])
        #expect(GitHubRepos.filter(repos, query: "CLI").map(\.name) == ["cli-tools", "kunj"])
        #expect(GitHubRepos.filter(repos, query: "me branch").map(\.name) == ["kunj"])
        #expect(GitHubRepos.filter(repos, query: "nothing").isEmpty)
    }

    @Test func theArgumentsNameTheRepository() {
        #expect(GitHubRepos.listArguments() == ["repos", "github"])
        #expect(GitHubRepos.cloneArguments(GitHubRepo(fullName: "a/b", owner: "a", name: "b")) == ["repos", "clone", "a/b"])
    }
}
