// Keeps the menu bar panel attached to the menu bar when its content
// changes height. AppKit keeps a window's bottom-left origin when it
// resizes, so a shorter list (e.g. turning on "Open only") would leave the
// panel hanging below the menu bar; this moves its top edge back up.

import AppKit
import SwiftUI

struct MenuBarAnchor: NSViewRepresentable {
    // The panel's window, so actions can close it after a click
    @MainActor private static weak var panel: NSWindow?

    @MainActor static func closePanel() {
        panel?.close()
    }

    func makeNSView(context: Context) -> AnchorView { AnchorView() }
    func updateNSView(_ nsView: AnchorView, context: Context) {}

    final class AnchorView: NSView {
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { return }
            MenuBarAnchor.panel = window
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak window] _ in
                guard let window else { return }
                MainActor.assumeIsolated { Self.pinToMenuBar(window) }
            }
        }

        @MainActor
        static func pinToMenuBar(_ window: NSWindow) {
            guard let screen = window.screen ?? NSScreen.main else { return }
            // visibleFrame excludes the menu bar, so its top is the menu bar's bottom edge
            let top = screen.visibleFrame.maxY
            if abs(window.frame.maxY - top) > 0.5 {
                window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: top))
            }
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
