import AppKit
import KunjWorkspaceCore

/// The left column under the header: the tab bar (40 px, a `border` hairline under it) over the
/// terminal area in `term`. A placeholder until Task 7 adds the tab bar and the terminals; the
/// window only calls `show(_:)` and `theme`, so Task 7 can replace the inside of this file alone.
final class TerminalColumn: NSView {
    var theme: Theme { didSet { apply() } }
    private(set) var environment: Environment?
    private let bar = FillView(.clear)
    private let barLine = FillView(.clear)
    private let body = FillView(.clear)

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for v in [bar, barLine, body] { addSubview(v) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: topAnchor),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: DesignTokens.Layout.tabbarHeight),
            barLine.topAnchor.constraint(equalTo: bar.bottomAnchor),
            barLine.leadingAnchor.constraint(equalTo: leadingAnchor),
            barLine.trailingAnchor.constraint(equalTo: trailingAnchor),
            barLine.heightAnchor.constraint(equalToConstant: 1),
            body.topAnchor.constraint(equalTo: barLine.bottomAnchor),
            body.leadingAnchor.constraint(equalTo: leadingAnchor),
            body.trailingAnchor.constraint(equalTo: trailingAnchor),
            body.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        apply()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    /// The selected environment (nil: nothing selected).
    func show(_ env: Environment?) {
        environment = env
    }

    private func apply() {
        bar.color = theme.color(\.bg)
        barLine.color = theme.color(\.border)
        body.color = theme.color(\.term)
    }
}
