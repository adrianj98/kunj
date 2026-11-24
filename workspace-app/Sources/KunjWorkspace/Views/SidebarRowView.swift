import AppKit
import KunjWorkspaceCore

/// One environment in the sidebar (DESIGN.md "Sidebar row"): padding 9 × 10 inside a 1 px border,
/// radius 6; dot · branch (sans 13/500) · relative time (mono 11, `muted`), then indented 15 px:
/// a merged-PR mark (purple, 12 px) before the time when the branch's pull request is merged; then
/// the kind icon (11 px, a branch or a box), a worktree's folder when it is not named like the branch
/// (mono 11; the full path in the tooltip) · status verb
/// (sans 11, `amber` when waiting), and at the right, while the mouse is over the sidebar, the CPU and
/// memory of the worktree's kunj sessions (mono 11, `muted`, `amber` from 50 % CPU) when the whole line fits. Selected: `raised` fill and
/// `borderStrong` border; hover: `raised` at 50 %.
final class SidebarRowView: NSView {
    static let height: CGFloat = 54

    /// Replaced in place when the listing changes (the sidebar reuses rows by environment id).
    var environment: Environment {
        didSet {
            guard environment != oldValue else { return }
            describe()
            needsDisplay = true
        }
    }
    var time: String { didSet { if time != oldValue { needsDisplay = true } } }
    /// The summed usage of the worktree's host tmux sessions; nil draws nothing.
    var usage: SessionUsage? { didSet { if usage != oldValue { needsDisplay = true } } }
    /// The mouse is over the sidebar: the usage is drawn only then.
    var showUsage = false { didSet { if showUsage != oldValue { needsDisplay = true } } }
    /// The session is suspended: the status reads "Suspended" (unless the worktree is missing or the container stopped).
    var suspended = false { didSet { if suspended != oldValue { needsDisplay = true } } }
    private var statusVerb: String {
        suspended && environment.state != .missing && environment.state != .stopped ? "Suspended" : environment.statusVerb
    }
    var selected: Bool {
        didSet { if selected != oldValue { needsDisplay = true; setAccessibilitySelected(selected) } }
    }
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
        describe()
        setAccessibilitySelected(selected)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func describe() {
        setAccessibilityLabel([environment.branch, [environment.kind.rawValue, sidebarFolder(environment)].compactMap { $0 }
            .joined(separator: " "), environment.statusVerb].joined(separator: ", "))
        toolTip = environment.path
    }

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

        // CGFloat, not the token's Double: mixed arithmetic is ambiguous to older Swift compilers
        let padH: CGFloat = 1 + DesignTokens.Layout.sidebarRowPaddingH
        let line1: CGFloat = 17, line2: CGFloat = 37
        theme.dotColor(environment.dot).setFill()
        NSBezierPath(ovalIn: NSRect(x: padH, y: line1 - 3.5, width: 7, height: 7)).fill()

        let textX: CGFloat = padH + 15
        let timeFont = Theme.mono(DesignTokens.TypeScale.caption)
        var timeWidth: CGFloat = draw(time, font: timeFont, color: theme.color(\.muted), rightEdge: bounds.maxX - padH, midY: line1)
        if environment.pullRequest?.state == "merged" {
            let size: CGFloat = 12
            // A typed constant: older Swift compilers find `- (… ? 6 : 0) -` ambiguous
            let gap: CGFloat = timeWidth > 0 ? 6 : 0
            let x = bounds.maxX - padH - timeWidth - gap - size
            Icon.merged.draw(in: NSRect(x: x, y: line1 - size / 2, width: size, height: size), color: Self.mergedColor)
            timeWidth += size + gap
        }
        let branchRight: CGFloat = bounds.maxX - padH - timeWidth
        let branchWidth: CGFloat = branchRight - 8 - textX
        draw(environment.branch, font: Theme.sans(DesignTokens.TypeScale.body, weight: .medium),
             color: theme.color(selected ? \.text : \.text2),
             in: textX, width: branchWidth, midY: line1)

        let lineColor = theme.color(selected ? \.text2 : \.muted)
        let caption = DesignTokens.TypeScale.caption
        var right = bounds.maxX - padH
        let folder = sidebarFolder(environment)
        let iconSize: CGFloat = 11
        // the usage only where icon, folder · verb still fit whole: the verb is the waiting signal
        if showUsage, let usage {
            let text = formatUsageShort(usage)
            let place = folder.map { width($0, Theme.mono(caption)) + 6 + width("·", Theme.sans(caption)) + 6 } ?? 0
            let status = iconSize + 6 + place + width(statusVerb, Theme.sans(caption))
            if textX + status + 8 + width(text, Theme.mono(caption)) <= right {
                let color = usage.cpu >= 50 ? theme.color(\.amber) : theme.color(\.muted)
                right -= draw(text, font: Theme.mono(caption), color: color, rightEdge: right, midY: line2) + 8
            }
        }
        var x = textX
        (environment.kind == .container ? Icon.container : Icon.worktree)
            .draw(in: NSRect(x: x, y: line2 - iconSize / 2, width: iconSize, height: iconSize), color: lineColor)
        x += iconSize + 6
        if let folder {
            x += draw(folder, font: Theme.mono(caption), color: lineColor, in: x, width: right - x, midY: line2) + 6
            x += draw("·", font: Theme.sans(caption), color: theme.color(\.faintest),
                      in: x, width: right - x, midY: line2) + 6
        }
        let verbColor = environment.agent == .waiting ? theme.color(\.amber) : lineColor
        draw(statusVerb, font: Theme.sans(caption), color: verbColor,
             in: x, width: right - x, midY: line2)
    }

    /// GitHub's merged purple, readable on the dark and light themes.
    static let mergedColor = NSColor(srgbRed: 0.537, green: 0.341, blue: 0.898, alpha: 1)

    private func width(_ s: String, _ font: NSFont) -> CGFloat {
        ceil((s as NSString).size(withAttributes: [.font: font]).width)
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
