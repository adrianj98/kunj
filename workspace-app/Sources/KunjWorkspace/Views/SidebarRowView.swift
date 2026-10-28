import AppKit
import KunjWorkspaceCore

/// One environment in the sidebar (DESIGN.md "Sidebar row"): padding 9 × 10 inside a 1 px border,
/// radius 6; dot · branch (sans 13/500) · relative time (mono 11, `muted`), then indented 15 px:
/// kind (mono 11) · status verb (sans 11, `amber` when waiting), and at the right the CPU and memory
/// of the worktree's kunj sessions (mono 11, `muted`, `amber` from 50 % CPU). Selected: `raised` fill and
/// `borderStrong` border; hover: `raised` at 50 %.
final class SidebarRowView: NSView {
    static let height: CGFloat = 54

    let environment: Environment
    var time: String { didSet { needsDisplay = true } }
    /// The summed usage of the worktree's host tmux sessions; nil draws nothing.
    var usage: SessionUsage? { didSet { if usage != oldValue { needsDisplay = true } } }
    var selected: Bool { didSet { needsDisplay = true; setAccessibilitySelected(selected) } }
    var theme: Theme { didSet { needsDisplay = true } }
    var onSelect: ((String) -> Void)?
    /// The row's right-click menu (the runner's `rowMenu`).
    var rowMenu: ((Environment) -> NSMenu?)?
    private var hovering = false { didSet { needsDisplay = true } }

    init(environment: Environment, time: String, selected: Bool, theme: Theme) {
        self.environment = environment
        self.time = time
        self.selected = selected
        self.theme = theme
        super.init(frame: .zero)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(environment.branch), \(environment.kind.rawValue), \(environment.statusVerb)")
        setAccessibilitySelected(selected)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { onSelect?(environment.id) }
    override func menu(for event: NSEvent) -> NSMenu? { rowMenu?(environment) }
    override func accessibilityPerformPress() -> Bool { onSelect?(environment.id); return true }

    override func draw(_ dirtyRect: NSRect) {
        let radius = DesignTokens.Radius.card
        let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        if selected {
            theme.color(\.raised).setFill(); box.fill()
            theme.color(\.borderStrong).setStroke(); box.lineWidth = 1; box.stroke()
        } else if hovering {
            theme.color(\.raised, alpha: 0.5).setFill(); box.fill()
        }

        let padH = 1 + DesignTokens.Layout.sidebarRowPaddingH
        let line1: CGFloat = 17, line2: CGFloat = 37
        theme.dotColor(environment.dot).setFill()
        NSBezierPath(ovalIn: NSRect(x: padH, y: line1 - 3.5, width: 7, height: 7)).fill()

        let textX = padH + 15
        let timeFont = Theme.mono(DesignTokens.TypeScale.caption)
        let timeWidth = draw(time, font: timeFont, color: theme.color(\.muted), rightEdge: bounds.maxX - padH, midY: line1)
        draw(environment.branch, font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium),
             color: theme.color(selected ? \.text : \.text2),
             in: textX, width: bounds.maxX - padH - timeWidth - 8 - textX, midY: line1)

        let lineColor = theme.color(selected ? \.text2 : \.muted)
        let caption = DesignTokens.TypeScale.caption
        var right = bounds.maxX - padH
        if let usage {
            let color = usage.cpu >= 50 ? theme.color(\.amber) : theme.color(\.muted)
            right -= draw(formatUsageShort(usage), font: Theme.mono(caption), color: color, rightEdge: right, midY: line2) + 8
        }
        var x = textX
        x += draw(environment.kind.rawValue, font: Theme.mono(caption), color: lineColor,
                  in: x, width: right - x, midY: line2) + 6
        x += draw("·", font: Theme.sans(caption), color: theme.color(\.faintest),
                  in: x, width: right - x, midY: line2) + 6
        let verbColor = environment.agent == .waiting ? theme.color(\.amber) : lineColor
        draw(environment.statusVerb, font: Theme.sans(caption), color: verbColor,
             in: x, width: right - x, midY: line2)
    }

    /// Draws one line truncated to `width`; returns the width used.
    @discardableResult
    private func draw(_ s: String, font: NSFont, color: NSColor, in x: CGFloat, width: CGFloat, midY: CGFloat) -> CGFloat {
        guard width > 0 else { return 0 }
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
        let size = (s as NSString).size(withAttributes: attrs)
        let w = min(ceil(size.width), width)
        (s as NSString).draw(with: NSRect(x: x, y: (midY - size.height / 2).rounded(), width: w, height: ceil(size.height)),
                             options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
        return w
    }

    private func draw(_ s: String, font: NSFont, color: NSColor, rightEdge: CGFloat, midY: CGFloat) -> CGFloat {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let size = (s as NSString).size(withAttributes: attrs)
        (s as NSString).draw(at: NSPoint(x: rightEdge - ceil(size.width), y: (midY - size.height / 2).rounded()),
                             withAttributes: attrs)
        return ceil(size.width)
    }
}
