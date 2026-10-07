// UserDefaults keys and defaults. Mirrors the VS Code extension's settings
// where they make sense outside an editor.

import Foundation

enum Pref {
    static let cliPath = "cliPath"
    static let refreshInterval = "refreshInterval"
    static let showStatus = "showStatus"
    static let showPullRequests = "showPullRequests"
    static let showPath = "showPath"
    static let terminalApp = "terminalApp"
    static let notifyPullRequests = "notifyPullRequests"
    static let badgeFailingChecks = "badgeFailingChecks"
    static let collapsedRepos = "collapsedRepos"
    static let onlyOpenWorktrees = "onlyOpenWorktrees"

    static func register() {
        UserDefaults.standard.register(defaults: [
            cliPath: "kunj",
            refreshInterval: 60.0,
            showStatus: true,
            showPullRequests: true,
            showPath: false,
            terminalApp: "Terminal",
            notifyPullRequests: true,
            badgeFailingChecks: true,
        ])
    }
}

extension UserDefaults {
    var kunjCliPath: String { string(forKey: Pref.cliPath) ?? "kunj" }
    var kunjRefreshInterval: TimeInterval { double(forKey: Pref.refreshInterval) }
    var kunjShowStatus: Bool { bool(forKey: Pref.showStatus) }
    var kunjShowPullRequests: Bool { bool(forKey: Pref.showPullRequests) }
    var kunjTerminalApp: String { string(forKey: Pref.terminalApp) ?? "Terminal" }
    var kunjNotifyPullRequests: Bool { bool(forKey: Pref.notifyPullRequests) }
}
