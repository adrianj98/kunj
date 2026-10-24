import AppKit
import KunjWorkspaceCore

/// One pill in the tab bar.
struct TabBarItem: Equatable {
    var id: String
    var title: String
    var dot: DotColor?
    var active: Bool
    var toolTip: String?
    /// An editor tab with unsaved changes: a `text2` dot (status colours stay for agent states).
    var dirty = false
}

/// The left column's tab bar (40 px, padding 0 × 12): segmented 26 px pills, 2 px apart, then on
/// the right `tmux <session> · <uptime>` (mono 11 in `faint`) when the environment has an agent
/// tab, the split button (disabled until v2) and `+` (a new shell).
final class TabBarView: NSView {
    var theme: Theme { didSet { apply() } }
    var onSelect: (String) -> Void = { _ in }
    var onClose: (String) -> Void = { _ in }
    var onNewTab: () -> Void = {}
    /// The Changes pill was pressed (open or close the Changes column).
    var onToggleChanges: () -> Void = {}
    /// The Files pill was pressed (open or close the Files column).
    var onToggleFiles: () -> Void = {}

    private let pills = NSStackView()
    private let tmuxLabel = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.caption), color: .clear)
    private let split = BarIconButton(.split, label: "Split pane")
    private let plus = BarIconButton(.plus, label: "New tab")
    /// `Changes N` at the far right: `raised` while the column is open, N the environment's changed
    /// files (hidden when 0).
    private let changes: PillView
    /// `Files` after it, `raised` while the Files column is open.
    private let files: PillView
    private var items: [TabBarItem] = []

    init(theme: Theme) {
        self.theme = theme
        changes = PillView("Changes", theme: theme)
        files = PillView("Files", theme: theme)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        changes.toolTip = "Show or hide the Changes column (⌘⇧C)"
        changes.onPress = { [weak self] in self?.onToggleChanges() }
        files.toolTip = "Show or hide the Files column (⌘⇧E)"
        files.onPress = { [weak self] in self?.onToggleFiles() }
        pills.orientation = .horizontal
        pills.spacing = 2
        pills.translatesAutoresizingMaskIntoConstraints = false
        pills.setClippingResistancePriority(.defaultLow, for: .horizontal)
        pills.setHuggingPriority(.defaultLow, for: .horizontal)
        split.isEnabled = false
        split.toolTip = "Split panes come in a later version"
        plus.toolTip = "New shell (⌘T)"
        plus.onPress = { [weak self] in self?.onNewTab() }
        // in a narrow bar (the Files column open) the tmux text gives way before the tabs, and the
        // tabs clip at their edge rather than run under it
        tmuxLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(100), for: .horizontal)
        pills.wantsLayer = true
        pills.layer?.masksToBounds = true
        let right = NSStackView(views: [tmuxLabel, split, plus, changes, files])
        right.orientation = .horizontal
        right.spacing = 4
        right.setCustomSpacing(8, after: tmuxLabel)
        right.setCustomSpacing(8, after: plus)
        right.translatesAutoresizingMaskIntoConstraints = false
        for v in [pills, right] as [NSView] { addSubview(v) }
        NSLayoutConstraint.activate([
            pills.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            pills.centerYAnchor.constraint(equalTo: centerYAnchor),
            pills.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -12),
            right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            right.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    /// Shows `items`; `tmux` is the right-hand text (nil hides it).
    func show(_ items: [TabBarItem], tmux: String?) {
        tmuxLabel.stringValue = tmux ?? ""
        tmuxLabel.isHidden = tmux == nil
        guard items != self.items else { return }
        self.items = items
        pills.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for item in items {
            let dot = item.dot.map { theme.dotColor($0) } ?? (item.dirty ? theme.color(\.text2) : nil)
            let pill = PillView(item.title, dot: dot, active: item.active, theme: theme)
            pill.toolTip = item.toolTip
            pill.onPress = { [weak self] in self?.onSelect(item.id) }
            pill.menu = closeMenu(for: item.id)
            pills.addArrangedSubview(pill)
        }
    }

    /// The Changes pill: open (active) or not, and the changed-file count (0: no count).
    func showChanges(count: Int, open: Bool) {
        changes.active = open
        changes.count = count > 0 ? "\(count)" : nil
        changes.setAccessibilityLabel(count > 0 ? "Changes, \(count) files" : "Changes")
    }

    func showFiles(open: Bool) {
        files.active = open
    }

    private func closeMenu(for id: String) -> NSMenu {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Close Tab", action: #selector(closeFromMenu(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = id
        menu.addItem(item)
        return menu
    }

    @objc private func closeFromMenu(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { onClose(id) }
    }

    private func apply() {
        tmuxLabel.textColor = theme.color(\.faint)
        for b in [split, plus] { b.color = theme.color(\.muted); b.hoverFill = theme.color(\.raised) }
        changes.theme = theme
        files.theme = theme
        let current = items
        items = []
        show(current, tmux: tmuxLabel.isHidden ? nil : tmuxLabel.stringValue)
    }
}

/// A 26 × 26 borderless icon button (split, new tab): a 14 px icon in `muted`, `raised` on hover.
final class BarIconButton: NSButton {
    let icon: Icon
    var color: NSColor = .gray { didSet { needsDisplay = true } }
    var hoverFill: NSColor = .clear { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }

    init(_ icon: Icon, label: String) {
        self.icon = icon
        super.init(frame: .zero)
        title = ""
        isBordered = false
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(label)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 26), heightAnchor.constraint(equalToConstant: 26),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func pressed() { onPress?() }
    override var isFlipped: Bool { true }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        if isEnabled && (hovering || isHighlighted) {
            hoverFill.setFill()
            let r = DesignTokens.Radius.control
            NSBezierPath(roundedRect: bounds, xRadius: r, yRadius: r).fill()
        }
        icon.draw(in: NSRect(x: bounds.midX - 7, y: bounds.midY - 7, width: 14, height: 14),
                  color: color)
    }
}
