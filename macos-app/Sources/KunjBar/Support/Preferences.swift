// UserDefaults keys and defaults. Mirrors the VS Code extension's settings
// where they make sense outside an editor.

import AppKit
import KunjBarCore

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
    // Organize Windows
    static let organizeScreen = "organizeScreen"       // display name, "" = main screen
    static let organizeLayout = "organizeLayout"       // Layout raw value
    static let organizeEditor = "organizeEditor"
    static let organizeTerminal = "organizeTerminal"
    static let organizeDesktops = "organizeDesktops"   // worktree path -> SpaceID as a decimal string
    // Global shortcut for the open worktree switcher
    static let switcherEnabled = "switcherEnabled"
    static let switcherKeyCode = "switcherKeyCode"     // virtual key code
    static let switcherModifiers = "switcherModifiers" // NSEvent.ModifierFlags raw value

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
            organizeScreen: "",
            organizeLayout: Layout.editorLeft.rawValue,
            organizeEditor: true,
            organizeTerminal: true,
            switcherEnabled: true,
            switcherKeyCode: Int(Shortcut.defaultSwitcher.keyCode),
            switcherModifiers: Int(Shortcut.defaultSwitcher.modifiers.rawValue),
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
    var kunjOrganizeScreen: String { string(forKey: Pref.organizeScreen) ?? "" }
    var kunjOrganizeLayout: Layout { Layout(rawValue: string(forKey: Pref.organizeLayout) ?? "") ?? .editorLeft }
    var kunjOrganizeKinds: Set<WindowKind> {
        var kinds: Set<WindowKind> = []
        if bool(forKey: Pref.organizeEditor) { kinds.insert(.editor) }
        if bool(forKey: Pref.organizeTerminal) { kinds.insert(.terminal) }
        return kinds
    }
    var kunjSwitcherEnabled: Bool { bool(forKey: Pref.switcherEnabled) }
    var kunjSwitcherShortcut: Shortcut {
        get {
            Shortcut(keyCode: UInt32(integer(forKey: Pref.switcherKeyCode)),
                     modifiers: NSEvent.ModifierFlags(rawValue: UInt(integer(forKey: Pref.switcherModifiers))))
        }
        set {
            set(Int(newValue.keyCode), forKey: Pref.switcherKeyCode)
            set(Int(newValue.modifiers.rawValue), forKey: Pref.switcherModifiers)
        }
    }
    var kunjOrganizeDesktops: [String: SpaceID] {
        get {
            (dictionary(forKey: Pref.organizeDesktops) as? [String: String] ?? [:])
                .compactMapValues { SpaceID($0) }
        }
        set { set(newValue.mapValues { String($0) }, forKey: Pref.organizeDesktops) }
    }
}
