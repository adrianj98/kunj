import AppKit
import KunjWorkspaceCore

extension NSColor {
    /// A token hex string (`#rrggbb`); magenta when it does not parse, so a bad token shows.
    convenience init(token: String, alpha: CGFloat? = nil) {
        let c = parseHex(token) ?? RGBA(r: 1, g: 0, b: 1, a: 1)
        self.init(srgbRed: c.r, green: c.g, blue: c.b, alpha: alpha ?? c.a)
    }
}

/// A plain view filled with one colour.
final class FillView: NSView {
    var color: NSColor { didSet { needsDisplay = true } }
    init(_ color: NSColor) {
        self.color = color
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        // cacheDisplay (the --screenshot path) does not clip a subview's drawing to its bounds
        dirtyRect.intersection(bounds).fill(using: .sourceOver)
    }
}

/// The window: sidebar (272) | header (52) over a left column (terminals, 11fr) and a right
/// column (Changes, 9fr), status bar (28) under both, 1 px `border` hairlines between them.
/// The regions are empty until the later tasks fill them.
final class MainWindowController: NSWindowController {
    let tokens = DesignTokens.warm
    private(set) var sidebar: NSView!
    private(set) var header: NSView!
    private(set) var leftColumn: NSView!
    private(set) var rightColumn: NSView!
    private(set) var statusBar: NSView!
    private let statusRight = NSTextField(labelWithString: "")
    /// Bottom right of the sidebar, under "+ New session" (spec Layout, warm.png): `kunj 1.4.2`.
    private let sidebarVersion = NSTextField(labelWithString: "")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Kunj Workspace"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 900, height: 560)
        window.backgroundColor = NSColor(token: DesignTokens.warm.bg)
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        super.init(window: window)
        buildLayout()
    }

    required init?(coder: NSCoder) { fatalError() }

    /// The kunj version goes to the sidebar's foot (as in warm.png); a discovery error, too long
    /// for the sidebar, goes to the right of the status bar in `red` (Task 6 adds the window's
    /// error state).
    func setKunjStatus(_ text: String, isError: Bool) {
        sidebarVersion.stringValue = isError ? "" : text
        statusRight.stringValue = isError ? text : ""
        statusRight.textColor = NSColor(token: tokens.red)
    }

    private func buildLayout() {
        guard let content = window?.contentView else { return }
        let L = DesignTokens.Layout.self
        let bg = NSColor(token: tokens.bg)
        let border = NSColor(token: tokens.border)
        let root = FillView(bg)
        content.addSubview(root)
        pin(root, to: content)

        // Sidebar: vibrancy (navigation layer) tinted with `side` at 85 %
        let effect = NSVisualEffectView()
        effect.material = .sidebar
        effect.blendingMode = .behindWindow
        effect.state = .followsWindowActiveState
        effect.translatesAutoresizingMaskIntoConstraints = false
        let side = FillView(NSColor(token: tokens.side, alpha: 0.85))
        effect.addSubview(side)
        pin(side, to: effect)
        sidebar = effect

        let sidebarLine = FillView(border)
        header = FillView(bg)
        let headerLine = FillView(border)
        leftColumn = FillView(NSColor(token: tokens.term))
        let columnLine = FillView(border)
        rightColumn = FillView(bg)
        let statusLine = FillView(border)
        statusBar = FillView(bg)

        let caption = DesignTokens.TypeScale.caption
        let mono = NSFont(name: "\(DesignTokens.Fonts.mono)-Regular", size: caption)
            ?? .monospacedSystemFont(ofSize: caption, weight: .regular)
        statusRight.font = mono
        statusRight.textColor = NSColor(token: tokens.muted)
        statusRight.lineBreakMode = .byTruncatingTail
        statusRight.translatesAutoresizingMaskIntoConstraints = false
        statusBar.addSubview(statusRight)

        sidebarVersion.font = mono
        sidebarVersion.textColor = NSColor(token: tokens.muted)
        sidebarVersion.alignment = .right
        sidebarVersion.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(sidebarVersion)

        for v: NSView in [effect, sidebarLine, header!, headerLine, leftColumn!, columnLine, rightColumn!, statusLine, statusBar!] {
            root.addSubview(v)
        }
        let leftShare = L.paneSplit.0 / (L.paneSplit.0 + L.paneSplit.1)
        NSLayoutConstraint.activate([
            effect.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            effect.topAnchor.constraint(equalTo: root.topAnchor),
            effect.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            effect.widthAnchor.constraint(equalToConstant: L.sidebarWidth),

            sidebarLine.leadingAnchor.constraint(equalTo: effect.trailingAnchor),
            sidebarLine.topAnchor.constraint(equalTo: root.topAnchor),
            sidebarLine.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebarLine.widthAnchor.constraint(equalToConstant: 1),

            header.leadingAnchor.constraint(equalTo: sidebarLine.trailingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.heightAnchor.constraint(equalToConstant: L.headerHeight),

            headerLine.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            headerLine.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            headerLine.topAnchor.constraint(equalTo: header.bottomAnchor),
            headerLine.heightAnchor.constraint(equalToConstant: 1),

            statusBar.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            statusBar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            statusBar.heightAnchor.constraint(equalToConstant: L.statusbarHeight),

            statusLine.leadingAnchor.constraint(equalTo: statusBar.leadingAnchor),
            statusLine.trailingAnchor.constraint(equalTo: statusBar.trailingAnchor),
            statusLine.bottomAnchor.constraint(equalTo: statusBar.topAnchor),
            statusLine.heightAnchor.constraint(equalToConstant: 1),

            leftColumn.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            leftColumn.topAnchor.constraint(equalTo: headerLine.bottomAnchor),
            leftColumn.bottomAnchor.constraint(equalTo: statusLine.topAnchor),
            leftColumn.widthAnchor.constraint(equalTo: header.widthAnchor, multiplier: leftShare, constant: -1),

            columnLine.leadingAnchor.constraint(equalTo: leftColumn.trailingAnchor),
            columnLine.topAnchor.constraint(equalTo: leftColumn.topAnchor),
            columnLine.bottomAnchor.constraint(equalTo: leftColumn.bottomAnchor),
            columnLine.widthAnchor.constraint(equalToConstant: 1),

            rightColumn.leadingAnchor.constraint(equalTo: columnLine.trailingAnchor),
            rightColumn.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            rightColumn.topAnchor.constraint(equalTo: leftColumn.topAnchor),
            rightColumn.bottomAnchor.constraint(equalTo: leftColumn.bottomAnchor),

            statusRight.trailingAnchor.constraint(equalTo: statusBar.trailingAnchor, constant: -16),
            statusRight.centerYAnchor.constraint(equalTo: statusBar.centerYAnchor),
            statusRight.leadingAnchor.constraint(greaterThanOrEqualTo: statusBar.leadingAnchor, constant: 16),

            sidebarVersion.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -16),
            sidebarVersion.centerYAnchor.constraint(equalTo: effect.bottomAnchor, constant: -19),
        ])
    }

    private func pin(_ v: NSView, to parent: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
            v.topAnchor.constraint(equalTo: parent.topAnchor),
            v.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
        ])
    }

    // MARK: snapshots

    /// Renders the window's content into a PNG without screen-recording permission, through
    /// cacheDisplay (from spikes/native-ide Workspace.swift). Terminals and the WKWebView are
    /// composited separately once they exist (Tasks 7 and 9).
    func snapshotPNG(completion: @escaping (Data?) -> Void) {
        guard let root = window?.contentView else { completion(nil); return }
        root.layoutSubtreeIfNeeded()
        root.displayIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { completion(nil); return }
        root.cacheDisplay(in: root.bounds, to: rep)
        // cacheDisplay renders in a calibrated (generic) RGB space; convert so the PNG's pixels
        // are the sRGB token values, comparable with the mockups
        let out = rep.converting(to: .sRGB, renderingIntent: .default) ?? rep
        completion(out.representation(using: .png, properties: [:]))
    }
}
