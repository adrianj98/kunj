// Settings window and log window.

import KunjBarCore
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @AppStorage(Pref.cliPath) private var cliPath = "kunj"
    @AppStorage(Pref.refreshInterval) private var refreshInterval = 60.0
    @AppStorage(Pref.showStatus) private var showStatus = true
    @AppStorage(Pref.showPullRequests) private var showPullRequests = true
    @AppStorage(Pref.showPath) private var showPath = false
    @AppStorage(Pref.terminalApp) private var terminalApp = "Terminal"
    @AppStorage(Pref.notifyPullRequests) private var notifyPullRequests = true
    @AppStorage(Pref.badgeFailingChecks) private var badgeFailingChecks = true
    @AppStorage(Pref.organizeScreen) private var organizeScreen = ""
    @AppStorage(Pref.organizeLayout) private var organizeLayout = Layout.editorLeft.rawValue
    @AppStorage(Pref.organizeEditor) private var organizeEditor = true
    @AppStorage(Pref.organizeTerminal) private var organizeTerminal = true
    @AppStorage(Pref.switcherEnabled) private var switcherEnabled = true
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Section("kunj CLI") {
                TextField("Command", text: $cliPath, prompt: Text("kunj"))
                Text("Path to kunj, or e.g. `node /path/to/kunj/dist/index.js`. Looked up on your login shell's PATH.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Worktrees") {
                Picker("Refresh every", selection: $refreshInterval) {
                    Text("30 seconds").tag(30.0)
                    Text("1 minute").tag(60.0)
                    Text("5 minutes").tag(300.0)
                    Text("Never").tag(0.0)
                }
                Toggle("Show uncommitted changes and ahead/behind", isOn: $showStatus)
                Toggle("Show pull requests (gh / glab)", isOn: $showPullRequests)
                Toggle("Show worktree paths", isOn: $showPath)
                Picker("Terminal", selection: $terminalApp) {
                    ForEach(Launcher.terminalApps, id: \.self) { Text($0).tag($0) }
                }
                Text("Worktrees open in the editor set by `kunj config` (worktree.editorCommand).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Open worktree switcher") {
                Toggle("Global shortcut", isOn: $switcherEnabled)
                if switcherEnabled {
                    LabeledContent("Shortcut") { ShortcutRecorder() }
                }
                Text("Shows the worktrees open in an editor in the middle of the screen. ↑/↓ pick one, ↩ or a click brings it to the front.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Organize") {
                Picker("Screen", selection: $organizeScreen) {
                    Text("Main screen").tag("")
                    ForEach(NSScreen.screens, id: \.localizedName) { screen in
                        Text(screen.localizedName).tag(screen.localizedName)
                    }
                }
                Picker("Layout", selection: $organizeLayout) {
                    Text("Editor left, terminal right").tag(Layout.editorLeft.rawValue)
                    Text("Terminal left, editor right").tag(Layout.editorRight.rawValue)
                    Text("Editor above terminal").tag(Layout.editorAbove.rawValue)
                }
                Toggle("Editor windows", isOn: $organizeEditor)
                Toggle("Terminal windows", isOn: $organizeTerminal)
                Text("Organize Windows (⚙ menu) gives each worktree a desktop on this screen and tiles its windows. Needs Accessibility access.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Pull requests") {
                Toggle("Notify when checks fail or pass, or a PR is approved or merged", isOn: $notifyPullRequests)
                Toggle("Show failing checks count in the menu bar", isOn: $badgeFailingChecks)
            }

            Section("General") {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
                if let loginError {
                    Text(loginError).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginError = nil
        } catch {
            loginError = error.localizedDescription
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}

// Click, then press the new shortcut (⎋ cancels). Needs ⌘, ⌥ or ⌃.
struct ShortcutRecorder: View {
    @State private var shortcut = UserDefaults.standard.kunjSwitcherShortcut
    @State private var recording = false
    @State private var monitor: Any?

    var body: some View {
        HStack {
            Button(recording ? "Press a shortcut…" : shortcut.display) {
                recording ? stop() : start()
            }
            .frame(minWidth: 120)
            if !recording && shortcut != .defaultSwitcher {
                Button("Reset") { save(.defaultSwitcher) }
                    .buttonStyle(.link)
            }
        }
        .onDisappear { stop() }
    }

    private func start() {
        recording = true
        Switcher.shared.suspended = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { // escape
                stop()
                return nil
            }
            let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
            guard !modifiers.intersection([.command, .option, .control]).isEmpty else { return nil }
            save(Shortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers))
            stop()
            return nil
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if recording { Switcher.shared.suspended = false }
        recording = false
    }

    private func save(_ new: Shortcut) {
        shortcut = new
        UserDefaults.standard.kunjSwitcherShortcut = new
    }
}

struct LogView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(store.logLines.enumerated()), id: \.offset) { index, line in
                        Text(line)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(index)
                    }
                }
                .padding(8)
            }
            .onChange(of: store.logLines.count) { _, count in
                proxy.scrollTo(count - 1, anchor: .bottom)
            }
        }
        .frame(minWidth: 600, minHeight: 300)
    }
}
