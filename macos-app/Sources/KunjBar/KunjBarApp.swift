// Kunj menu bar app: git worktrees across every repository kunj knows
// about, which ones are open in an editor, and their pull requests.
// Everything is delegated to the kunj CLI (`kunj repos`, `kunj worktree`).

import AppKit
import SwiftUI
import UserNotifications

@main
struct KunjBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = AppStore()
    @AppStorage(Pref.badgeFailingChecks) private var badgeFailingChecks = true

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environment(store)
        } label: {
            // The label is rendered as soon as the app launches, so start here
            let failing = store.failingChecksCount
            HStack(spacing: 2) {
                Image(systemName: "arrow.triangle.branch")
                if badgeFailingChecks && failing > 0 {
                    Text("\(failing)")
                }
            }
            .task { store.start() }
        }
        .menuBarExtraStyle(.window)

        WindowGroup("New Worktree", id: "new-worktree", for: String.self) { $root in
            if let root {
                NewWorktreeView(repoRoot: root)
                    .environment(store)
            }
        }
        .windowResizability(.contentSize)

        Window("Kunj Settings", id: "settings") {
            SettingsView()
        }
        .windowResizability(.contentSize)

        Window("Kunj Log", id: "log") {
            LogView()
                .environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { Snapshot.runIfRequested() }
        // Menu bar only: no Dock icon (also set by LSUIElement in the bundle)
        NSApp.setActivationPolicy(.accessory)
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().delegate = self
        }
    }

    // Clicking a PR notification opens the pull request
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let url = response.notification.request.content.userInfo["url"] as? String {
            Launcher.openURL(url)
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
