import AppKit
import KunjWorkspaceCore

/// The Overview window's drawing: repositories as headings, under each its agents as lanes, a lane's
/// plan as a line of stops. Every position and every text comes from `kunj agent overview --json`
/// (`AgentOverviewJson`); this only strokes them, and holds no layout logic of its own.
/// The scroll view's document view: it sizes itself to what it draws. A click on a lane calls `onOpen`.
final class OverviewCanvas: NSView {
    /// A click on an agent's lane: the lane and its repository.
    var onOpen: ((OverviewLane, AgentOverviewJson.Repo) -> Void)?

    private(set) var repos: [AgentOverviewJson] = []
    private(set) var filter: OverviewFilter = .all
    private var theme = ThemeManager.shared.current

    private enum Row {
        case heading(name: String, count: Int, top: CGFloat)
        case family(repo: Int, family: OverviewFamily, top: CGFloat)
        case message(String, top: CGFloat)
    }
    private var rows: [Row] = []
    /// Tooltip owners are not retained by the view.
    private var tipOwners: [NSString] = []

    private static let headingHeight: CGFloat = 34
    private static let messageHeight: CGFloat = 120
    private static let stopLabelSize: CGFloat = 10.5

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ repos: [AgentOverviewJson], filter: OverviewFilter) {
        self.repos = repos
        self.filter = filter
        rebuild()
    }

    func apply(_ t: Theme) {
        theme = t
        needsDisplay = true
    }

    /// Lays the rows out again and resizes to them (also called when the window's width changes).
    func rebuild() {
        rows = []
        var y: CGFloat = 0
        var width: CGFloat = 0
        for (index, repo) in repos.enumerated() {
            let families = filterFamilies(repo.families, filter)
            if families.isEmpty { continue }
            rows.append(.heading(name: repo.repo.name, count: families.reduce(0) { $0 + $1.lanes.count }, top: y))
            y += Self.headingHeight
            for family in families {
                rows.append(.family(repo: index, family: family, top: y))
                y += CGFloat(family.height)
                width = max(width, CGFloat(family.width))
            }
        }
        if rows.isEmpty {
            let text = repos.allSatisfy({ $0.families.isEmpty })
                ? "No agents are running.\nStart one with the Agent button of a session; its plan appears here as it works."
                : "No agent matches this filter."
            rows = [.message(text, top: 0)]
            y = Self.messageHeight
        }
        let visible = enclosingScrollView?.contentSize ?? .zero
        setFrameSize(NSSize(width: max(width, visible.width), height: max(y, visible.height)))
        rebuildToolTips()
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
    }

    // MARK: hit testing

    private func lane(at point: NSPoint) -> (OverviewLane, AgentOverviewJson.Repo)? {
        for row in rows {
            guard case .family(let repo, let family, let top) = row else { continue }
            guard point.y >= top, point.y < top + CGFloat(family.height) else { continue }
            guard let index = laneIndex(at: Double(point.y - top), in: family), repo < repos.count else { return nil }
            return (family.lanes[index], repos[repo].repo)
        }
        return nil
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let (lane, repo) = lane(at: point) { onOpen?(lane, repo) }
    }

    override func resetCursorRects() {
        for row in rows {
            if case .family(_, let family, let top) = row {
                addCursorRect(NSRect(x: 0, y: top, width: bounds.width, height: CGFloat(family.height)), cursor: .pointingHand)
            }
        }
    }

    private func rebuildToolTips() {
        removeAllToolTips()
        tipOwners = []
        func tip(_ stop: OverviewStop, gx: CGFloat, top: CGFloat, radius: CGFloat) {
            let owner = stop.label as NSString
            tipOwners.append(owner)
            addToolTip(NSRect(x: gx + CGFloat(stop.x) - radius, y: top + CGFloat(stop.y) - radius, width: radius * 2, height: radius * 2),
                       owner: owner, userData: nil)
        }
        for row in rows {
            guard case .family(let repo, let family, let top) = row, repo < repos.count else { continue }
            let gx = CGFloat(repos[repo].metrics.labelWidth)
            for lane in family.lanes {
                for stop in lane.stops where !lane.labelBeside { tip(stop, gx: gx, top: top, radius: 9) }
                for loop in lane.loops { for stop in loop.stops { tip(stop, gx: gx, top: top, radius: 7) } }
            }
        }
    }

    // MARK: drawing

    private var lineColor: NSColor { theme.color(\.text2, alpha: 0.75) }

    override func draw(_ dirtyRect: NSRect) {
        theme.color(\.bg).setFill()
        dirtyRect.intersection(bounds).fill(using: .sourceOver)
        for row in rows {
            switch row {
            case .heading(let name, let count, let top):
                guard dirtyRect.intersects(NSRect(x: 0, y: top, width: bounds.width, height: Self.headingHeight)) else { continue }
                drawText(name, in: NSRect(x: 20, y: top + 12, width: bounds.width - 80, height: 18),
                         font: Theme.sans(DesignTokens.TypeScale.small), color: theme.color(\.muted))
                drawText("\(count)", in: NSRect(x: bounds.width - 60, y: top + 13, width: 40, height: 16),
                         font: Theme.mono(DesignTokens.TypeScale.caption), color: theme.color(\.faint), alignment: .right)
            case .family(let repo, let family, let top):
                let rect = NSRect(x: 0, y: top, width: bounds.width, height: CGFloat(family.height))
                guard dirtyRect.intersects(rect), repo < repos.count else { continue }
                draw(family: family, metrics: repos[repo].metrics, top: top)
                theme.color(\.border).setFill()
                NSRect(x: 0, y: rect.maxY - 1, width: bounds.width, height: 1).fill()
            case .message(let text, let top):
                drawText(text, in: NSRect(x: 40, y: top + 44, width: bounds.width - 80, height: 60),
                         font: Theme.sans(DesignTokens.TypeScale.body), color: theme.color(\.muted), alignment: .center, lines: 3)
            }
        }
    }

    private func draw(family: OverviewFamily, metrics: AgentOverviewJson.Metrics, top: CGFloat) {
        let gx = CGFloat(metrics.labelWidth)
        func p(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: gx + CGFloat(x), y: top + CGFloat(y)) }

        for lane in family.lanes {
            let state = lane.waiting ? theme.color(\.amber) : theme.color(\.green)

            // the elbow from the parent's stop
            if let b = lane.elbow {
                let path = NSBezierPath()
                path.move(to: p(b.fromX, b.fromY))
                path.line(to: p(b.fromX, b.toY - 12))
                path.curve(to: p(b.fromX + 12, b.toY), controlPoint1: p(b.fromX, b.toY - 5), controlPoint2: p(b.fromX + 5, b.toY))
                path.line(to: p(b.toX, b.toY))
                stroke(path, lineColor, width: 3)
            }

            // the line: all of it as "to come", then the done part over it
            if let line = lane.line {
                let from = line.fromX
                let whole = NSBezierPath()
                whole.move(to: p(from, lane.y))
                whole.line(to: p(line.toX, lane.y))
                stroke(whole, theme.color(\.idle), width: 3)
                if let done = line.doneToX, done > from {
                    let part = NSBezierPath()
                    part.move(to: p(from, lane.y))
                    part.line(to: p(done, lane.y))
                    stroke(part, lineColor, width: 3)
                }
            }

            for loop in lane.loops { draw(loop: loop, origin: p) }

            for marker in lane.markers {
                let c = p(marker.x, marker.y)
                let diamond = NSBezierPath()
                diamond.move(to: NSPoint(x: c.x, y: c.y - 6))
                diamond.line(to: NSPoint(x: c.x + 6, y: c.y))
                diamond.line(to: NSPoint(x: c.x, y: c.y + 6))
                diamond.line(to: NSPoint(x: c.x - 6, y: c.y))
                diamond.close()
                theme.color(\.bg).setFill()
                diamond.fill()
                stroke(diamond, lineColor, width: 2)
                let font = Theme.mono(10)
                let size = (marker.label as NSString).size(withAttributes: [.font: font])
                let pill = NSRect(x: c.x - size.width / 2 - 8, y: top + CGFloat(marker.labelY), width: size.width + 16, height: 17)
                let box = NSBezierPath(roundedRect: pill.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
                theme.color(\.raised).setFill()
                box.fill()
                stroke(box, theme.color(\.borderStrong), width: 1)
                drawText(marker.label, in: pill.insetBy(dx: 4, dy: 2), font: font, color: theme.color(\.text2), alignment: .center)
            }

            for stop in lane.stops {
                draw(stop: stop, at: p(stop.x, stop.y), state: state, small: false)
                if lane.labelBeside {
                    drawText(stop.label, in: NSRect(x: gx + CGFloat(stop.x) + 14, y: top + CGFloat(stop.y) - 8, width: 400, height: 16),
                             font: Theme.sans(Self.stopLabelSize, weight: .semibold), color: theme.color(\.text))
                } else {
                    let w = CGFloat(metrics.stopSpacing) - 8
                    let current = stop.stopKind == .current
                    drawText(stop.label, in: NSRect(x: gx + CGFloat(stop.x) - w / 2, y: top + CGFloat(stop.y) - 29, width: w, height: 15),
                             font: Theme.sans(Self.stopLabelSize, weight: current ? .semibold : .regular),
                             color: current ? theme.color(\.text) : theme.color(\.faint), alignment: .center)
                }
            }

            drawLabel(lane: lane, width: gx, top: top, state: state)
        }
    }

    /// A subagent's loop under the line, with its own small stops and its task under it.
    private func draw(loop: OverviewLoop, origin p: (Double, Double) -> NSPoint) {
        func path(to endX: Double?) -> NSBezierPath {
            let path = NSBezierPath()
            path.move(to: p(loop.fromX, loop.lineY))
            path.line(to: p(loop.fromX, loop.y - 8))
            path.curve(to: p(loop.fromX + 8, loop.y), controlPoint1: p(loop.fromX, loop.y - 3), controlPoint2: p(loop.fromX + 3, loop.y))
            if let endX {
                path.line(to: p(max(endX, loop.fromX + 8), loop.y))
                return path
            }
            path.line(to: p(loop.toX - 8, loop.y))
            path.curve(to: p(loop.toX, loop.y - 8), controlPoint1: p(loop.toX - 3, loop.y), controlPoint2: p(loop.toX, loop.y - 3))
            path.line(to: p(loop.toX, loop.lineY))
            return path
        }
        if loop.running {
            stroke(path(to: nil), theme.color(\.idle), width: 2)
            if loop.doneToX > loop.fromX { stroke(path(to: loop.doneToX), lineColor, width: 2) }
        } else {
            stroke(path(to: nil), lineColor, width: 2)
        }
        for stop in loop.stops { draw(stop: stop, at: p(stop.x, stop.y), state: theme.color(\.green), small: true) }
        let font = Theme.mono(10)
        let width = max(CGFloat(loop.toX - loop.fromX), (loop.label as NSString).size(withAttributes: [.font: font]).width + 8)
        let mid = p((loop.fromX + loop.toX) / 2, loop.y)
        drawText(loop.label, in: NSRect(x: mid.x - width / 2, y: mid.y + 8, width: width, height: 14),
                 font: font, color: theme.color(\.muted), alignment: .center)
    }

    private func draw(stop: OverviewStop, at c: NSPoint, state: NSColor, small: Bool) {
        func circle(_ r: CGFloat) -> NSBezierPath {
            NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
        }
        switch stop.stopKind {
        case .done:
            // opaque, so the dot is not darker where it lies over the line
            theme.color(\.bg).setFill()
            circle(small ? 3.5 : 5).fill()
            lineColor.setFill()
            circle(small ? 3.5 : 5).fill()
        case .todo:
            let dot = circle(small ? 3 : 4.5)
            theme.color(\.bg).setFill()
            dot.fill()
            stroke(dot, theme.color(\.idle), width: 2)
        case .current:
            let ring = circle(small ? 5 : 7)
            theme.color(\.bg).setFill()
            ring.fill()
            stroke(ring, state, width: small ? 2 : 3)
            state.setFill()
            circle(small ? 1.6 : 2.6).fill()
        }
    }

    /// The label column: status dot and the three lines kunj wrote (title, place, status).
    private func drawLabel(lane: OverviewLane, width labelWidth: CGFloat, top: CGFloat, state: NSColor) {
        let x: CGFloat = lane.child ? 38 : 20
        let y = top + CGFloat(lane.y) - 21
        let width = labelWidth - x - 28
        state.setFill()
        NSBezierPath(ovalIn: NSRect(x: x, y: y + 5, width: 8, height: 8)).fill()
        drawText(lane.title, in: NSRect(x: x + 16, y: y, width: width, height: 18),
                 font: Theme.sans(DesignTokens.TypeScale.body, weight: .semibold), color: theme.color(\.text))
        drawText(lane.place, in: NSRect(x: x + 16, y: y + 19, width: width, height: 15),
                 font: Theme.mono(DesignTokens.TypeScale.caption), color: theme.color(\.muted), truncation: .byTruncatingMiddle)
        drawText(lane.status, in: NSRect(x: x + 16, y: y + 35, width: width, height: 15),
                 font: Theme.sans(DesignTokens.TypeScale.caption), color: lane.waiting ? theme.color(\.amber) : theme.color(\.muted))
    }

    private func stroke(_ path: NSBezierPath, _ color: NSColor, width: CGFloat) {
        color.setStroke()
        path.lineWidth = width
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.stroke()
    }

    private func drawText(_ text: String, in rect: NSRect, font: NSFont, color: NSColor, alignment: NSTextAlignment = .left,
                          truncation: NSLineBreakMode = .byTruncatingTail, lines: Int = 1) {
        let style = NSMutableParagraphStyle()
        style.alignment = alignment
        style.lineBreakMode = lines == 1 ? truncation : .byWordWrapping
        let attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
        attributed.draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}
