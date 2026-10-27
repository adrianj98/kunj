import AppKit
import KunjWorkspaceCore

// The design's controls, drawn in draw(_:) rather than with layer properties: cacheDisplay (the
// --screenshot path) renders draw(_:) but not a layer's background, border or corner radius.

/// A flipped view filling a (rounded) rect and stroking it with a 1 px border.
class BoxView: NSView {
    var fill: NSColor? { didSet { needsDisplay = true } }
    var stroke: NSColor? { didSet { needsDisplay = true } }
    var radius: CGFloat { didSet { needsDisplay = true } }

    init(fill: NSColor? = nil, stroke: NSColor? = nil, radius: CGFloat = 0) {
        self.fill = fill
        self.stroke = stroke
        self.radius = radius
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        if radius == 0 && stroke == nil {
            fill?.setFill()
            // cacheDisplay does not clip a subview's drawing to its bounds
            dirtyRect.intersection(bounds).fill(using: .sourceOver)
            return
        }
        let r = stroke == nil ? bounds : bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
        if let fill { fill.setFill(); path.fill() }
        if let stroke { stroke.setStroke(); path.lineWidth = 1; path.stroke() }
    }
}

/// A plain view filled with one colour (backgrounds, 1 px hairlines in `border`).
final class FillView: BoxView {
    var color: NSColor {
        get { fill ?? .clear }
        set { fill = newValue }
    }
    init(_ color: NSColor) { super.init(fill: color) }
    required init?(coder: NSCoder) { fatalError() }
}

/// The status dot: 7 px in the sidebar, 6 px in bars.
final class DotView: NSView {
    var color: NSColor { didSet { needsDisplay = true } }
    let size: CGFloat

    init(color: NSColor, size: CGFloat = 7) {
        self.color = color
        self.size = size
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: size, height: size) }
    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

extension Theme {
    func dotColor(_ dot: DotColor) -> NSColor {
        switch dot {
        case .green: return color(\.green)
        case .amber: return color(\.amber)
        case .idle: return color(\.idle)
        }
    }
}

/// The design's line icons, drawn from their 24-unit SVG paths.
enum Icon {
    case shell, plus, dots, search, split, close

    func draw(in rect: NSRect, color: NSColor) {
        let s = rect.width / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        let path = NSBezierPath()
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.lineWidth = 2.2 * s
        color.set()
        switch self {
        case .shell:
            path.move(to: p(5, 7)); path.line(to: p(10, 12)); path.line(to: p(5, 17))
            path.move(to: p(12, 17)); path.line(to: p(19, 17))
            path.stroke()
        case .plus:
            path.move(to: p(12, 5)); path.line(to: p(12, 19))
            path.move(to: p(5, 12)); path.line(to: p(19, 12))
            path.stroke()
        case .dots:
            for x in [5.0, 12.0, 19.0] {
                NSBezierPath(ovalIn: NSRect(x: p(x - 2, 0).x, y: p(0, 10).y, width: 4 * s, height: 4 * s)).fill()
            }
        case .search:
            path.appendOval(in: NSRect(x: p(4, 0).x, y: p(0, 4).y, width: 14 * s, height: 14 * s))
            path.move(to: p(20, 20)); path.line(to: p(16.5, 16.5))
            path.stroke()
        case .split:
            path.lineWidth = 2 * s
            path.appendRoundedRect(NSRect(x: p(3, 0).x, y: p(0, 4).y, width: 18 * s, height: 16 * s),
                                   xRadius: 2 * s, yRadius: 2 * s)
            path.move(to: p(12, 4)); path.line(to: p(12, 20))
            path.stroke()
        case .close:
            path.move(to: p(6, 6)); path.line(to: p(18, 18))
            path.move(to: p(18, 6)); path.line(to: p(6, 18))
            path.stroke()
        }
    }
}

final class IconView: NSView {
    let icon: Icon
    var color: NSColor { didSet { needsDisplay = true } }
    init(_ icon: Icon, size: CGFloat, color: NSColor) {
        self.icon = icon
        self.color = color
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { icon.draw(in: bounds, color: color) }
}

/// A one-line label that truncates with an ellipsis.
func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = font
    l.textColor = color
    l.lineBreakMode = .byTruncatingTail
    l.maximumNumberOfLines = 1
    l.translatesAutoresizingMaskIntoConstraints = false
    return l
}

/// A label that runs `onClick` and shows the pointing hand (the header's PR and port links).
final class LinkLabel: NSTextField {
    var onClick: (() -> Void)?
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { onClick?() }
    override func accessibilityRole() -> NSAccessibility.Role? { .link }
}

private func textWidth(_ s: String, _ font: NSFont) -> CGFloat {
    ceil((s as NSString).size(withAttributes: [.font: font]).width)
}

/// Draws `s` vertically centred on `midY` starting at `x`; returns the x after it.
@discardableResult
private func drawText(_ s: String, font: NSFont, color: NSColor, x: CGFloat, midY: CGFloat) -> CGFloat {
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let size = (s as NSString).size(withAttributes: attrs)
    (s as NSString).draw(at: NSPoint(x: x, y: (midY - size.height / 2).rounded()), withAttributes: attrs)
    return x + ceil(size.width)
}

/// The header and sidebar buttons: 30 px tall, radius 6, a label in sans 12.5/500 and a shortcut
/// hint in mono 10.5. `outlined` (borderStrong, transparent) or `filled` (primaryBg, the one
/// tinted action); `iconOnly` is the 30×30 overflow button; `wide` fills its width with the hint
/// at the right edge (+ New session).
class ActionButton: NSButton {
    enum Style { case outlined, filled, iconOnly, wide }

    let style: Style
    let label: String
    let hint: String?
    let icon: Icon?
    var theme: Theme { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }

    private var labelFont: NSFont { Theme.sans(12.5, weight: .medium) }
    private var hintFont: NSFont { Theme.mono(DesignTokens.TypeScale.hint) }
    private var padding: CGFloat { style == .filled || style == .wide ? 12 : 11 }
    private var iconSize: CGFloat { style == .outlined ? 13 : 14 }

    init(_ label: String, hint: String? = nil, icon: Icon? = nil, style: Style, theme: Theme) {
        self.style = style
        self.label = label
        self.hint = hint
        self.icon = icon
        self.theme = theme
        super.init(frame: .zero)
        title = ""
        isBordered = false
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(hint.map { "\(label) (\($0))" } ?? label)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }

    @objc private func pressed() { onPress?() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override var intrinsicContentSize: NSSize {
        let height: CGFloat = style == .wide ? 34 : 30
        if style == .iconOnly { return NSSize(width: 30, height: 30) }
        var w = padding * 2 + textWidth(label, labelFont)
        if icon != nil { w += iconSize + (style == .wide ? 8 : 7) }
        if let hint { w += 7 + textWidth(hint, hintFont) }
        return NSSize(width: w, height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        let pressedDown = isHighlighted
        let radius = DesignTokens.Radius.card
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        let fill: NSColor?
        let stroke: NSColor
        let labelColor: NSColor
        let hintColor: NSColor
        switch style {
        case .filled:
            // disabled: the same fill, faded (Create PR on a container without a host worktree)
            fill = theme.color(\.primaryBg, alpha: !isEnabled ? 0.4 : (pressedDown ? 0.85 : (hovering ? 0.93 : 1)))
            stroke = theme.color(\.primaryBg, alpha: isEnabled ? 1 : 0)
            labelColor = theme.color(\.primaryFg)
            hintColor = theme.color(\.primaryHint)
        case .wide:
            fill = pressedDown || hovering ? theme.color(\.raised) : theme.color(\.side)
            stroke = theme.color(\.borderStrong)
            labelColor = theme.color(\.text)
            hintColor = theme.color(\.muted)
        case .outlined, .iconOnly:
            fill = pressedDown ? theme.color(\.raised) : (hovering ? theme.color(\.raised, alpha: 0.5) : nil)
            stroke = theme.color(\.borderStrong)
            labelColor = isEnabled ? theme.color(\.text2) : theme.color(\.faint)
            hintColor = theme.color(\.muted)
        }
        if let fill { fill.setFill(); path.fill() }
        stroke.setStroke()
        path.lineWidth = 1
        path.stroke()

        let midY = bounds.midY
        if style == .iconOnly, let icon {
            icon.draw(in: NSRect(x: bounds.midX - 7, y: midY - 7, width: 14, height: 14), color: labelColor)
            return
        }
        var x = padding
        if let icon {
            icon.draw(in: NSRect(x: x, y: midY - iconSize / 2, width: iconSize, height: iconSize), color: labelColor)
            x += iconSize + (style == .wide ? 8 : 7)
        }
        x = drawText(label, font: labelFont, color: labelColor, x: x, midY: midY)
        if let hint {
            let hx = style == .wide ? bounds.maxX - padding - textWidth(hint, hintFont) : x + 7
            drawText(hint, font: hintFont, color: hintColor, x: hx, midY: midY)
        }
    }
}

final class OutlinedButton: ActionButton {
    init(_ label: String, hint: String? = nil, icon: Icon? = nil, theme: Theme) {
        super.init(label, hint: hint, icon: icon, style: .outlined, theme: theme)
    }
    required init?(coder: NSCoder) { fatalError() }
}

final class FilledButton: ActionButton {
    init(_ label: String, hint: String? = nil, theme: Theme) {
        super.init(label, hint: hint, icon: nil, style: .filled, theme: theme)
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// A segmented tab pill: 26 px, radius 5, `raised` when active, an optional 6 px status dot.
final class PillView: NSButton {
    var label: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var dot: NSColor? { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var active: Bool { didSet { needsDisplay = true } }
    var theme: Theme { didSet { needsDisplay = true } }
    /// A count after the label in mono 11 `muted` (the Changes pill's file count); nil: none.
    var count: String? { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var onPress: (() -> Void)?
    /// Set (a tab's pill): an × after the label that calls it instead of `onPress`.
    var onClose: (() -> Void)? { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    private var hoveringClose = false { didSet { needsDisplay = true } }
    private var countFont: NSFont { Theme.mono(DesignTokens.TypeScale.caption) }
    private var labelFont: NSFont { Theme.sans(DesignTokens.TypeScale.small, weight: active ? .medium : .regular) }

    init(_ label: String, dot: NSColor? = nil, active: Bool = false, theme: Theme) {
        self.label = label
        self.dot = dot
        self.active = active
        self.theme = theme
        super.init(frame: .zero)
        title = ""
        isBordered = false
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(label)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func pressed() {
        // only a click lands on the ×: Space on a focused pill selects it wherever the pointer is
        if let onClose, let event = NSApp.currentEvent, [.leftMouseUp, .leftMouseDown].contains(event.type),
           closeRect.contains(convert(event.locationInWindow, from: nil)) {
            onClose()
        } else {
            onPress?()
        }
    }
    override var isFlipped: Bool { true }
    override func accessibilityValue() -> Any? { active ? "selected" : nil }
    override func mouseMoved(with event: NSEvent) {
        hoveringClose = onClose != nil && closeRect.contains(convert(event.locationInWindow, from: nil))
    }
    override func mouseExited(with event: NSEvent) { hoveringClose = false }

    /// The × at the right edge: 16 × 16, 5 px in.
    private var closeRect: NSRect {
        NSRect(x: bounds.maxX - 21, y: bounds.midY - 8, width: 16, height: 16)
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 20 + textWidth(label, Theme.sans(12, weight: .medium)) + (dot == nil ? 0 : 13)
                   + (count.map { 6 + textWidth($0, countFont) } ?? 0) + (onClose == nil ? 0 : 16), height: 26)
    }

    override func draw(_ dirtyRect: NSRect) {
        if active || isHighlighted {
            theme.color(\.raised).setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: bounds, xRadius: r, yRadius: r).fill()
        }
        var x: CGFloat = 10
        if let dot {
            dot.setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: bounds.midY - 3, width: 6, height: 6)).fill()
            x += 13
        }
        x = drawText(label, font: labelFont, color: theme.color(active ? \.text : \.text2), x: x, midY: bounds.midY)
        if let count { drawText(count, font: countFont, color: theme.color(\.muted), x: x + 6, midY: bounds.midY) }
        if onClose != nil {
            let r = closeRect
            if hoveringClose {
                theme.color(\.raised2).setFill()
                NSBezierPath(roundedRect: r, xRadius: 3, yRadius: 3).fill()
            }
            Icon.close.draw(in: r.insetBy(dx: 3, dy: 3),
                            color: theme.color(hoveringClose ? \.text : (active ? \.muted : \.faint)))
        }
    }
}

/// The ⌘K search box: 30 px, `side` fill, `border` stroke, radius 6, a search icon, the field
/// (sans 12.5) and a `⌘K` badge.
final class SearchField: BoxView, NSTextFieldDelegate {
    let field = NSTextField()
    private let icon: IconView
    private let badge: BadgeView
    private let placeholder: String
    var onChange: ((String) -> Void)?
    var theme: Theme { didSet { apply() } }

    init(placeholder: String, badge shortcut: String = "⌘K", theme: Theme) {
        self.theme = theme
        self.placeholder = placeholder
        icon = IconView(.search, size: 13, color: theme.color(\.muted))
        badge = BadgeView(text: shortcut, theme: theme)
        super.init(radius: DesignTokens.Radius.card)
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = Theme.sans(12.5)
        field.delegate = self
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.translatesAutoresizingMaskIntoConstraints = false
        field.setAccessibilityLabel(placeholder)
        for v in [icon, field, badge] as [NSView] { addSubview(v) }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 30),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.trailingAnchor.constraint(equalTo: badge.leadingAnchor, constant: -8),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func apply() {
        fill = theme.color(\.side)
        stroke = theme.color(\.border)
        icon.color = theme.color(\.muted)
        badge.theme = theme
        field.textColor = theme.color(\.text)
        field.placeholderAttributedString = NSAttributedString(
            string: placeholder,
            attributes: [.font: Theme.sans(12.5), .foregroundColor: theme.color(\.muted)])
    }

    /// Esc pressed in the field (after it was cleared): the app gives the terminal the keyboard back.
    var onEscape: (() -> Void)?

    func controlTextDidChange(_ obj: Notification) { onChange?(field.stringValue) }
    func focus() { window?.makeFirstResponder(field) }

    /// Empties the field (and the filter).
    func clear() {
        guard !field.stringValue.isEmpty else { return }
        field.stringValue = ""
        onChange?("")
    }

    /// Return pressed in the field (the Search panel searches at once).
    var onSubmit: (() -> Void)?

    /// Esc clears the search; a second Esc on an empty field leaves it. Return goes to `onSubmit`.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)), let onSubmit {
            onSubmit()
            return true
        }
        guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        if field.stringValue.isEmpty { onEscape?() } else { clear() }
        return true
    }
}

/// A shortcut badge: mono 10.5 in `muted`, 1 px `borderStrong`, radius 4, padding 1 × 5.
final class BadgeView: NSView {
    let text: String
    var theme: Theme { didSet { needsDisplay = true } }
    private let font = Theme.mono(DesignTokens.TypeScale.hint)
    init(text: String, theme: Theme) {
        self.text = text
        self.theme = theme
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: textWidth(text, font) + 12, height: 16) }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
        theme.color(\.borderStrong).setStroke()
        path.lineWidth = 1
        path.stroke()
        drawText(text, font: font, color: theme.color(\.muted), x: 6, midY: bounds.midY)
    }
}
