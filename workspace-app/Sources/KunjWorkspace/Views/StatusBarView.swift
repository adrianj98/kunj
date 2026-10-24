import AppKit
import KunjWorkspaceCore

/// The status bar (28 px, mono 11 `muted`, `│` separators in `borderStrong`): on the left a dot and
/// the container name or worktree path, `up 2h 14m` (containers), services, forwards
/// (`3000 → 3000`); on the right the agent state and `⌘1–N switch session`. A kunj error replaces
/// the left side in `red`.
final class StatusBarView: NSView {
    var theme: Theme { didSet { render() } }
    private var environment: Environment?
    private var environmentCount = 0
    private var error: String?
    private let left = NSStackView()
    private let right = NSStackView()

    init(theme: Theme) {
        self.theme = theme
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for s in [left, right] {
            s.orientation = .horizontal
            s.spacing = 14
            s.alignment = .centerY
            s.translatesAutoresizingMaskIntoConstraints = false
            addSubview(s)
        }
        left.setClippingResistancePriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            left.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            left.centerYAnchor.constraint(equalTo: centerYAnchor),
            right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            right.centerYAnchor.constraint(equalTo: centerYAnchor),
            left.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -14),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ env: Environment?, environmentCount: Int) {
        environment = env
        self.environmentCount = environmentCount
        render()
    }

    /// A kunj error (a failed listing); nil clears it.
    func showError(_ message: String?) {
        error = message
        render()
    }

    private func label(_ s: String, _ color: NSColor? = nil) -> NSTextField {
        let l = makeLabel(s, font: Theme.mono(DesignTokens.TypeScale.caption), color: color ?? theme.color(\.muted))
        l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return l
    }

    private func dotted(_ s: String, _ dot: NSColor) -> NSView {
        let stack = NSStackView(views: [DotView(color: dot, size: 6), label(s)])
        stack.spacing = 6
        stack.alignment = .centerY
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
        return stack
    }

    private func fill(_ stack: NSStackView, _ items: [NSView]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, v) in items.enumerated() {
            if i > 0 { stack.addArrangedSubview(label("│", theme.color(\.borderStrong))) }
            stack.addArrangedSubview(v)
        }
    }

    private func render() {
        var leftItems: [NSView] = []
        var rightItems: [NSView] = []
        if let error {
            leftItems.append(label(error, theme.color(\.red)))
        } else if let env = environment {
            let dot: NSColor
            switch env.state {
            case .running, .ok: dot = theme.color(\.green)
            case .stopped: dot = theme.color(\.idle)
            case .missing: dot = theme.color(\.red)
            }
            let place = env.containerName ?? (env.path.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? env.branch)
            leftItems.append(dotted(place, dot))
            if env.kind == .container {
                if env.state == .stopped {
                    leftItems.append(label("stopped"))
                } else if let created = env.createdAt {
                    leftItems.append(label("up \(uptime(since: created))"))
                }
            }
            if !env.services.isEmpty { leftItems.append(label(env.services.map(\.name).joined(separator: " · "))) }
            let forwards = env.ports.filter { $0.kind == "forward" }
            if !forwards.isEmpty {
                leftItems.append(label(forwards.map { "\($0.host) → \($0.container)" }.joined(separator: "  ")))
            }
        }
        if let env = environment {
            switch env.agent {
            case .waiting: rightItems.append(dotted("agent waiting for input", theme.color(\.amber)))
            case .running: rightItems.append(dotted("agent running", theme.color(\.green)))
            case .none, .unknown: break
            }
        }
        if environmentCount > 0 {
            let n = min(9, environmentCount)
            rightItems.append(label(n == 1 ? "⌘1 switch session" : "⌘1–\(n) switch session"))
        }
        fill(left, leftItems)
        fill(right, rightItems)
    }
}
