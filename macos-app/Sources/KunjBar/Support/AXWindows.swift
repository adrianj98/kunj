// Windows through the Accessibility API: which ones exist, where they are, and
// moving them. Needs the Accessibility permission (System Settings > Privacy &
// Security > Accessibility).

import AppKit
import ApplicationServices
import KunjBarCore

// Private but long-stable (AltTab, yabai and Hammerspoon use it): the window id
// behind an AXUIElement, which SkyLight and CGWindowList use.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

enum AXWindows {
    static let editorBundleIDs: Set<String> = [
        "com.microsoft.VSCode",
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.vscodium",
        "com.exafunction.windsurf",
    ]

    static func isTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // The editor and terminal apps running now, by pid
    static func candidateApps(terminalApps: [String]) -> [pid_t: WindowKind] {
        var kinds: [pid_t: WindowKind] = [:]
        for app in NSWorkspace.shared.runningApplications {
            if let bundle = app.bundleIdentifier, editorBundleIDs.contains(bundle) {
                kinds[app.processIdentifier] = .editor
            } else if let name = app.localizedName, terminalApps.contains(name) {
                kinds[app.processIdentifier] = .terminal
            }
        }
        return kinds
    }

    // Ids of every ordinary window of those apps on any desktop, from the window server.
    // Accessibility lists only the windows on each display's current desktop, so the
    // caller visits the other desktops until these are all accounted for.
    static func allWindowIDs(of apps: [pid_t: WindowKind]) -> Set<CGWindowID> {
        guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var ids: Set<CGWindowID> = []
        for info in list {
            guard let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, apps[pid] != nil,
                  let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0 else { continue }
            ids.insert(id)
        }
        return ids
    }

    // Every standard window of those apps that Accessibility lists right now.
    static func visibleWindows(of apps: [pid_t: WindowKind]) -> [(FoundWindow, AXUIElement)] {
        var found: [(FoundWindow, AXUIElement)] = []
        for (pid, kind) in apps {
            let windows: [AXUIElement] = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) ?? []
            for window in windows {
                guard let subrole: String = attribute(window, kAXSubroleAttribute), subrole == kAXStandardWindowSubrole else { continue }
                var id: CGWindowID = 0
                guard _AXUIElementGetWindow(window, &id) == .success, let frame = frame(of: window) else { continue }
                let title: String = attribute(window, kAXTitleAttribute) ?? ""
                let document: String? = (attribute(window, kAXDocumentAttribute) as String?)
                    .flatMap { URL(string: $0) }
                    .flatMap { $0.isFileURL ? $0.path : nil }
                let minimized: Bool = attribute(window, kAXMinimizedAttribute) ?? false
                found.append((FoundWindow(id: id, pid: pid, kind: kind, title: title, documentPath: document, frame: frame, minimized: minimized), window))
            }
        }
        return found
    }

    static func candidateWindows(terminalApps: [String]) -> [(FoundWindow, AXUIElement)] {
        visibleWindows(of: candidateApps(terminalApps: terminalApps))
    }

    // Cocoa coordinates
    static func frame(of window: AXUIElement) -> CGRect? {
        guard let positionValue: AXValue = attribute(window, kAXPositionAttribute),
              let sizeValue: AXValue = attribute(window, kAXSizeAttribute) else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(x: position.x, y: primaryHeight - position.y - size.height, width: size.width, height: size.height)
    }

    // Position, size, then position again: a window clamps a position that does not
    // fit its old screen, so the second move lands it once it has its new size.
    static func setFrame(_ window: AXUIElement, cocoa: CGRect) {
        var (origin, size) = axFrame(cocoa, primaryHeight: primaryHeight)
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) }
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
    }

    // Bring the window to the front; macOS switches to its desktop when it is on another one.
    static func raise(_ window: AXUIElement, pid: pid_t) {
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        NSRunningApplication(processIdentifier: pid)?.activate()
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    }

    // The primary screen (origin 0,0) sets the Accessibility coordinate space.
    static var primaryHeight: CGFloat {
        NSScreen.screens.first { $0.frame.origin == .zero }?.frame.height ?? NSScreen.screens.first?.frame.height ?? 0
    }

    private static func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value as? T
    }
}
