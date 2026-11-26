import AppKit
import KunjWorkspaceCore

/// The Overview's hover card: what kunj says about the item under the pointer (a stop, a subagent's
/// loop, a marker, a handoff or a lane), shown at once, unlike a tooltip. The title in sans 12
/// semibold `text`, then kunj's `detail` lines in sans 11 `muted`, one each, cut with an ellipsis
/// at 380 px; on `raised` with a `borderStrong` hairline, radius 8, and a shadow. It never takes a
/// click: the canvas under it still opens the lane.
final class OverviewHoverCard: NSView {
    var theme: Theme { didSet { needsDisplay = true } }
    private(set) var title = ""
    private(set) var lines: [String] = []

    private static let padding: CGFloat = 10
    private static let maxWidth: CGFloat = 380
    private static let titleHeight: CGFloat = 17
    private static let lineHeight: CGFloat = 15
    private var titleFont: NSFont { Theme.sans(DesignTokens.TypeScale.small, weight: .semibold) }
    private var lineFont: NSFont { Theme.sans(DesignTokens.TypeScale.caption) }

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        wantsLayer = true
        layer?.zPosition = 10
        shadow = {
            let s = NSShadow()
            s.shadowBlurRadius = 10
            s.shadowOffset = NSSize(width: 0, height: -3)
            s.shadowColor = NSColor.black.withAlphaComponent(0.35)
            return s
        }()
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Shows `title` and `lines` next to `target` (view coordinates of the superview), below it when it
    /// fits inside `visible`, else above, kept inside `visible` across.
    func show(title: String, lines: [String], near target: NSRect, in visible: NSRect) {
        self.title = title
        self.lines = lines
        let widest = ([(title, titleFont)] + lines.map { ($0, lineFont) })
            .map { ceil(($0.0 as NSString).size(withAttributes: [.font: $0.1]).width) }.max() ?? 0
        let size = NSSize(width: min(Self.maxWidth, widest) + Self.padding * 2,
                          height: Self.padding * 2 + Self.titleHeight + CGFloat(lines.count) * Self.lineHeight + (lines.isEmpty ? 0 : 3))
        var origin = NSPoint(x: target.minX, y: target.maxY + 8)
        if origin.y + size.height > visible.maxY - 4 { origin.y = target.minY - 8 - size.height }
        origin.y = max(visible.minY + 4, origin.y)
        origin.x = min(max(visible.minX + 4, origin.x), visible.maxX - size.width - 4)
        frame = NSRect(origin: origin, size: size)
        isHidden = false
        needsDisplay = true
    }

    func hide() {
        guard !isHidden else { return }
        isHidden = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        theme.color(\.raised).setFill()
        box.fill()
        theme.color(\.borderStrong).setStroke()
        box.lineWidth = 1
        box.stroke()
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let width = bounds.width - Self.padding * 2
        NSAttributedString(string: title, attributes: [.font: titleFont, .foregroundColor: theme.color(\.text), .paragraphStyle: style])
            .draw(with: NSRect(x: Self.padding, y: Self.padding, width: width, height: Self.titleHeight),
                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        var y = Self.padding + Self.titleHeight + 3
        for line in lines {
            NSAttributedString(string: line, attributes: [.font: lineFont, .foregroundColor: theme.color(\.muted), .paragraphStyle: style])
                .draw(with: NSRect(x: Self.padding, y: y, width: width, height: Self.lineHeight),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            y += Self.lineHeight
        }
    }
}
