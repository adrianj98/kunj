// Windows through the Accessibility API: which ones exist, where they are, and
// moving them. Needs the Accessibility permission (System Settings > Privacy &
// Security > Accessibility).

import AppKit
import ApplicationServices
import KunjBarCore

// Private but long-stable: the window id behind an AXUIElement, which SkyLight
// and CGWindowList use.
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

    // Every standard window of the editor apps and of the terminal apps given by name.
    static func candidateWindows(terminalApps: [String]) -> [(FoundWindow, AXUIElement)] {
        var found: [(FoundWindow, AXUIElement)] = []
        for app in NSWorkspace.shared.runningApplications {
            let kind: WindowKind
            if let bundle = app.bundleIdentifier, editorBundleIDs.contains(bundle) {
                kind = .editor
            } else if let name = app.localizedName, terminalApps.contains(name) {
                kind = .terminal
            } else {
                continue
            }
            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            guard let windows: [AXUIElement] = attribute(appElement, kAXWindowsAttribute) else { continue }
            for window in windows {
                guard let subrole: String = attribute(window, kAXSubroleAttribute), subrole == kAXStandardWindowSubrole else { continue }
                var id: CGWindowID = 0
                guard _AXUIElementGetWindow(window, &id) == .success, let frame = frame(of: window) else { continue }
                let title: String = attribute(window, kAXTitleAttribute) ?? ""
                let document: String? = (attribute(window, kAXDocumentAttribute) as String?)
                    .flatMap { URL(string: $0) }
                    .flatMap { $0.isFileURL ? $0.path : nil }
                let minimized: Bool = attribute(window, kAXMinimizedAttribute) ?? false
                found.append((FoundWindow(id: id, pid: app.processIdentifier, kind: kind, title: title,
                                          documentPath: document, frame: frame, minimized: minimized), window))
            }
        }
        return found
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
