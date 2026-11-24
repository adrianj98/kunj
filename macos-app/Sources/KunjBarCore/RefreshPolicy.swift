// How hard the app works while its panel is closed. Closed is nearly always, and then the only
// consumer of a listing is the pull request notifier: a slow timer, no `--containers` (a fleet
// listing of every remote), no `kunj events` stream and no refresh on events. Opening the panel
// lists everything and starts the stream; it is stopped a little after the panel closes, so
// flicking the panel open and shut does not restart it each time.

import Foundation

public enum RefreshPolicy {
    /// The slowest the closed panel refreshes: enough for pull request notifications
    public static let closedInterval: TimeInterval = 300
    /// The fastest any refresh timer runs
    public static let minimumInterval: TimeInterval = 10
    /// How long the events stream outlives a closed panel
    public static let streamLinger: TimeInterval = 30

    /// The timer interval for the "Refresh every" setting (0 is never), or nil for no timer
    public static func timerInterval(setting: TimeInterval, panelOpen: Bool) -> TimeInterval? {
        guard setting > 0 else { return nil }
        let open = max(setting, minimumInterval)
        return panelOpen ? open : max(open, closedInterval)
    }

    /// Whether a listing asks for branch containers
    public static func includeContainers(setting: Bool, panelOpen: Bool) -> Bool {
        setting && panelOpen
    }

    /// Whether `kunj events` changes trigger a refresh
    public static func reactsToEvents(panelOpen: Bool) -> Bool {
        panelOpen
    }
}

/// The repositories `kunj events` is asked to watch: the visible ones that exist, which is also
/// what it watches without `--repo`. The stream is restarted only when this set changes.
public func watchedRoots(_ repos: [(root: String, hidden: Bool, exists: Bool)]) -> Set<String> {
    Set(repos.filter { $0.exists && !$0.hidden }.map(\.root))
}

/// `kunj events` arguments for a set of repository roots (none: every known visible repository)
public func eventStreamArguments(roots: Set<String>) -> [String] {
    let base = ["events", "--json"]
    return roots.isEmpty ? base : base + ["--repo"] + roots.sorted()
}
