import AppKit
import KunjWorkspaceCore

/// A small text button in a header row (the diff header's `Edit`): sans 11.5 in `muted`, `text`
/// on a `raised` fill on hover, 22 px high, `faint` when disabled.
final class HeaderTextButton: NSButton {
    var theme: Theme? { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private let label: String
    private let labelFont = Theme.sans(11.5)
    private var hovering = false { didSet { needsDisplay = true } }
    override var isEnabled: Bool { didSet { needsDisplay = true } }

    init(_ label: String) {
        self.label = label
        super.init(frame: .zero)
        title = ""
        isBordered = false
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(label)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func pressed() { onPress?() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override var intrinsicContentSize: NSSize {
        NSSize(width: ceil((label as NSString).size(withAttributes: [.font: labelFont]).width) + 16, height: 22)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let theme else { return }
        let hot = isEnabled && (hovering || isHighlighted)
        if hot {
            theme.color(\.raised).setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: bounds, xRadius: r, yRadius: r).fill()
        }
        let color = theme.color(!isEnabled ? \.faint : hot ? \.text : \.muted)
        let attrs: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: color]
        let size = (label as NSString).size(withAttributes: attrs)
        (label as NSString).draw(at: NSPoint(x: 8, y: (bounds.midY - size.height / 2).rounded()), withAttributes: attrs)
    }
}
