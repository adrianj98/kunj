import AppKit
import KunjWorkspaceCore

/// One row of the Changes file list (28 px, as warm.html's buttons): the status letter in mono 10
/// (`green` A, `amber` M and R, `red` D, 10 px wide), the name in sans 12 (`text` when selected,
/// else `text2`) truncated with an ellipsis, and the counts in mono 10 at the right (`+N` / `−N`;
/// `muted`, or `green`/`red` on the selected row). The selected row is filled with `raised`, radius 5,
/// inset 6 px on both sides (the list's padding). Drawn in draw(_:) so cacheDisplay renders it.
final class ChangedFileRowView: NSTableCellView {
    var file: ChangedFile? { didSet { update() } }
    var displayName = "" { didSet { update() } }
    var selected = false { didSet { needsDisplay = true } }
    var theme: Theme { didSet { needsDisplay = true } }

    static let height: CGFloat = 28
    static let inset: CGFloat = 6

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    private func update() {
        needsDisplay = true
        toolTip = file.map { f in f.oldPath.map { "\($0) → \(f.path)" } ?? f.path }
        setAccessibilityLabel(file.map { "\(statusWord($0.status)) \(displayName), \(countsText($0))" })
    }

    private func statusWord(_ s: FileStatus) -> String {
        switch s {
        case .added: return "Added"
        case .modified: return "Modified"
        case .deleted: return "Deleted"
        case .renamed: return "Renamed"
        }
    }

    private func countsText(_ f: ChangedFile) -> String {
        var parts: [String] = []
        if f.added > 0 { parts.append("+\(f.added)") }
        if f.deleted > 0 { parts.append("−\(f.deleted)") }
        return parts.joined(separator: " ")
    }

    override func accessibilityRole() -> NSAccessibility.Role? { .row }
    override func accessibilityValue() -> Any? { selected ? "selected" : nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let file else { return }
        let box = bounds.insetBy(dx: Self.inset, dy: 0)
        if selected {
            theme.color(\.raised).setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: box, xRadius: r, yRadius: r).fill()
        }
        let midY = bounds.midY
        let letterFont = Theme.mono(10)
        let letterColor: NSColor
        switch file.status {
        case .added: letterColor = theme.color(\.green)
        case .modified, .renamed: letterColor = theme.color(\.amber)
        case .deleted: letterColor = theme.color(\.red)
        }
        var x = box.minX + 8
        draw(file.status.rawValue, font: letterFont, color: letterColor, x: x, midY: midY)
        x += 10 + 8

        // Counts, right-aligned 8 px in
        let countFont = Theme.mono(10)
        var right = box.maxX - 8
        let segments: [(String, NSColor)] = {
            var s: [(String, NSColor)] = []
            if file.added > 0 { s.append(("+\(file.added)", selected ? theme.color(\.green) : theme.color(\.muted))) }
            if file.deleted > 0 { s.append(("−\(file.deleted)", selected ? theme.color(\.red) : theme.color(\.muted))) }
            return s
        }()
        for (i, seg) in segments.enumerated().reversed() {
            let w = width(seg.0, countFont)
            right -= w
            draw(seg.0, font: countFont, color: seg.1, x: right, midY: midY)
            if i > 0 { right -= width(" ", countFont) }
        }
        if !segments.isEmpty { right -= 8 }

        // Name, truncated to what is left
        let nameFont = Theme.sans(DesignTokens.TypeScale.small)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [
            .font: nameFont, .foregroundColor: theme.color(selected ? \.text : \.text2), .paragraphStyle: style,
        ]
        let h = ceil((displayName as NSString).size(withAttributes: attrs).height)
        (displayName as NSString).draw(
            with: NSRect(x: x, y: (midY - h / 2).rounded(), width: max(0, right - x), height: h),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
    }

    private func width(_ s: String, _ font: NSFont) -> CGFloat {
        ceil((s as NSString).size(withAttributes: [.font: font]).width)
    }

    private func draw(_ s: String, font: NSFont, color: NSColor, x: CGFloat, midY: CGFloat) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let size = (s as NSString).size(withAttributes: attrs)
        (s as NSString).draw(at: NSPoint(x: x, y: (midY - size.height / 2).rounded()), withAttributes: attrs)
    }
}
