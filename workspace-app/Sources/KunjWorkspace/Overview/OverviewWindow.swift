import AppKit
import KunjWorkspaceCore

/// The Overview in a window of its own, only for `--overview --screenshot` (the app shows it in the
/// main window's middle panel, `OverviewPanel`). It grows to show every row.
@MainActor
final class OverviewWindow: NSWindowController, NSWindowDelegate {
    let panel = OverviewPanel()

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 640),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: true)
        window.title = "Overview"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.contentView = panel
        window.delegate = self
        window.backgroundColor = ThemeManager.shared.current.color(\.bg)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        panel.isShown = true
    }

    func windowWillClose(_ notification: Notification) { panel.isShown = false }

    var isSettled: Bool { panel.isSettled }

    func snapshotPNG() -> Data? {
        guard let window, let root = window.contentView else { return nil }
        let canvas = panel.canvas, scroll = panel.scroll
        root.layoutSubtreeIfNeeded()
        canvas.rebuild()
        // -overviewSelect <n>: the screenshot shows lane n chosen, with the keys on it
        if UserDefaults.standard.object(forKey: "overviewSelect") != nil {
            window.makeFirstResponder(canvas)
            canvas.selectLane(at: UserDefaults.standard.integer(forKey: "overviewSelect"))
        }
        let chrome = root.bounds.height - scroll.frame.height
        let wanted = min(canvas.contentHeight + chrome + 8, (window.screen?.visibleFrame.height ?? 1200) - 40)
        if wanted > root.bounds.height {
            var frame = window.frame
            frame.size.height += wanted - root.bounds.height
            window.setFrame(frame, display: false)
            root.layoutSubtreeIfNeeded()
            canvas.rebuild()
        }
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
        root.cacheDisplay(in: root.bounds, to: rep)
        return (rep.converting(to: .sRGB, renderingIntent: .default) ?? rep).representation(using: .png, properties: [:])
    }
}
