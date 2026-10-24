import Testing
@testable import KunjWorkspaceCore

@Suite struct EmptyStateTests {
    /// While the app finds kunj and lists the repositories, the window says so instead of
    /// "No repositories yet"
    @Test func loadingShowsTheStepWithASpinner() {
        let finding = emptyStateText(discoveryError: nil, discoveryDetail: nil, loading: .findingKunj, hasRepos: false)
        #expect(finding == EmptyStateText(title: "Loading sessions…", detail: "Finding kunj", tone: .muted, spinner: true))
        let listing = emptyStateText(discoveryError: nil, discoveryDetail: nil, loading: .listing, hasRepos: false)
        #expect(listing.detail == "Listing worktrees and containers")
        #expect(listing.spinner)
    }

    @Test func anErrorWinsOverLoading() {
        let text = emptyStateText(discoveryError: "kunj not found on your PATH", discoveryDetail: "PATH: /usr/bin",
                                  loading: .findingKunj, hasRepos: false)
        #expect(text == EmptyStateText(title: "kunj not found on your PATH", detail: "PATH: /usr/bin", tone: .error, spinner: false))
        let tooOld = emptyStateText(discoveryError: "kunj 1.2.0 is older than 1.3.0: npm install -g kunj",
                                    discoveryDetail: nil, loading: nil, hasRepos: false)
        #expect(tooOld.detail == nil)
        let missing = emptyStateText(discoveryError: "kunj failed", discoveryDetail: nil, loading: nil, hasRepos: false)
        #expect(missing.detail == "Install or update it with npm install -g kunj")
    }

    @Test func loadedStates() {
        #expect(emptyStateText(discoveryError: nil, discoveryDetail: nil, loading: nil, hasRepos: false)
                == EmptyStateText(title: "No repositories yet", detail: "Run kunj in a repository to add it", tone: .muted, spinner: false))
        #expect(emptyStateText(discoveryError: nil, discoveryDetail: nil, loading: nil, hasRepos: true)
                == EmptyStateText(title: "Select an environment", detail: nil, tone: .muted, spinner: false))
    }
}
