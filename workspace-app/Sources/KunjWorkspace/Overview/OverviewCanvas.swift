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
        // a layer of its own, for the pulse's ring layers
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: the pulse
    //
    // A ring that grows and fades around the current stop of an agent that is working (not one that
    // waits: amber is still), as in the mockup. Core Animation runs it: one small layer per stop and
    // no redraw of the view, so it costs next to nothing. It starts just outside the stop's own ring,
    // which it never covers. Off while the window cannot be seen and when Reduce motion is on.

    private static let pulsePeriod: CFTimeInterval = 1.8
    private static let pulseRadius: (from: CGFloat, to: CGFloat) = (9, 17)
    private var pulseOn = false
    private var pulseLayers: [CAShapeLayer] = []
    /// Where the pulsing stops are, in view coordinates
    private var pulsing: [NSPoint] = []
    private var pulsingShown: [NSPoint] = []

    /// Starts or stops the pulse: on while the window is visible, there is a working agent to pulse,
    /// and Reduce motion is off.
    func setPulsing(_ on: Bool) {
        let wanted = on && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if wanted == pulseOn && pulsing == pulsingShown && !(wanted && pulseLayers.isEmpty && !pulsing.isEmpty) { return }
        pulseOn = wanted
        pulseLayers.forEach { $0.removeFromSuperlayer() }
        pulseLayers = []
        pulsingShown = pulsing
        guard wanted, let host = layer else { return }
        let r = Self.pulseRadius.to
        for c in pulsing {
            let ring = CAShapeLayer()
            ring.bounds = CGRect(x: 0, y: 0, width: r * 2 + 4, height: r * 2 + 4)
            ring.position = c
            ring.path = CGPath(ellipseIn: CGRect(x: 2, y: 2, width: r * 2, height: r * 2), transform: nil)
            ring.fillColor = nil
            ring.strokeColor = theme.color(\.green).cgColor
            ring.lineWidth = 1.5
            ring.opacity = 0
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = Self.pulseRadius.from / r
            grow.toValue = 1
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.55
            fade.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [grow, fade]
            group.duration = Self.pulsePeriod
            group.repeatCount = .infinity
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ring.add(group, forKey: "pulse")
            host.addSublayer(ring)
            pulseLayers.append(ring)
        }
        if !pulseLayers.isEmpty { log("overview: pulsing \(pulseLayers.count) stop\(pulseLayers.count == 1 ? "" : "s")") }
    }

    func show(_ repos: [AgentOverviewJson], filter: OverviewFilter) {
        self.repos = repos
        self.filter = filter
        aligned = nil
        rebuild()
    }

    // MARK: beside the sidebar's rows
    //
    // The main window's Overview: the sidebar spans the window and this view lies right of its rows,
    // inside the sidebar's list (so it scrolls with it). The rows say branch, place and state, so the
    // lanes have no label column and there are no headings; `alignOverview` (Core) says which row each
    // lane is beside, and the sidebar gives the rows' frames.

    /// A lane beside its row: its own coordinates plus `dy` (and `gx` across) are this view's.
    private struct Placed {
        var repo: Int
        var family: Int
        var lane: OverviewLane
        var dy: CGFloat
        var frame: NSRect
    }
    /// Set: the lanes are beside the sidebar's rows (nil: the standalone window's rows and headings).
    private var aligned: [Placed]?
    private static let alignedGx: CGFloat = 8

    /// Places the lanes beside the rows: `rowTops` are the rows' tops in this view, by environment id.
    func showAligned(_ repos: [AgentOverviewJson], filter: OverviewFilter, lanes: [AlignedLane], rowTops: [String: CGFloat]) {
        self.repos = repos
        self.filter = filter
        rows = []
        aligned = lanes.compactMap { a in
            guard let top = rowTops[a.environmentId] else { return nil }
            let slot = top + CGFloat(a.offset)
            return Placed(repo: a.repo, family: a.family, lane: a.lane, dy: top + CGFloat(a.dy),
                          frame: NSRect(x: 0, y: slot, width: bounds.width, height: CGFloat(a.height)))
        }
        pulsing = (aligned ?? []).flatMap { p -> [NSPoint] in
            guard !p.lane.waiting, !p.lane.isEnded else { return [] }
            return p.lane.stops.filter { $0.stopKind == .current }.map { NSPoint(x: Self.alignedGx + CGFloat($0.x), y: p.dy + CGFloat($0.y)) }
        }
        rebuildToolTips()
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
    }

    /// The line's y of the lane a child branched from, when it is shown: where its elbow starts.
    private func parentLineY(of p: Placed) -> CGFloat? {
        guard let b = p.lane.elbow else { return nil }
        return aligned?.first { $0.repo == p.repo && $0.family == p.family && $0.lane.y == b.fromY }.map { $0.dy + CGFloat($0.lane.y) }
    }

    func apply(_ t: Theme) {
        theme = t
        needsDisplay = true
        // the rings take the theme's green
        for ring in pulseLayers { ring.strokeColor = t.color(\.green).cgColor }
    }

    /// The height everything takes, for sizing the window to it (the screenshot).
    var contentHeight: CGFloat {
        rows.reduce(0) { total, row in
            switch row {
            case .heading: return total + Self.headingHeight
            case .family(_, let family, _): return total + CGFloat(family.height)
            case .message: return total + Self.messageHeight
            }
        }
    }

    /// Lays the rows out again and resizes to them (also called when the window's width changes).
    func rebuild() {
        guard aligned == nil else { return }
        rows = []
        pulsing = []
        var y: CGFloat = 0
        var width: CGFloat = 0
        for (index, repo) in repos.enumerated() {
            let families = filterFamilies(repo.families, filter)
            if families.isEmpty { continue }
            rows.append(.heading(name: repo.repo.name, count: families.reduce(0) { $0 + $1.lanes.count }, top: y))
            y += Self.headingHeight
            for family in families {
                rows.append(.family(repo: index, family: family, top: y))
                let gx = CGFloat(repo.metrics.labelWidth)
                for lane in family.lanes where !lane.waiting && !lane.isEnded {
                    for stop in lane.stops where stop.stopKind == .current {
                        pulsing.append(NSPoint(x: gx + CGFloat(stop.x), y: y + CGFloat(stop.y)))
                    }
                }
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

    // MARK: lanes as things to choose (keyboard, VoiceOver)

    private struct LaneRef {
        var lane: OverviewLane
        var repo: AgentOverviewJson.Repo
        /// In view coordinates
        var frame: NSRect
    }

    /// Every lane shown, top to bottom
    private var laneRefs: [LaneRef] {
        if let aligned {
            return aligned.compactMap { p in
                p.repo < repos.count ? LaneRef(lane: p.lane, repo: repos[p.repo].repo, frame: p.frame) : nil
            }
        }
        return rows.flatMap { row -> [LaneRef] in
            guard case .family(let repo, let family, let top) = row, repo < repos.count else { return [] }
            return family.lanes.map {
                LaneRef(lane: $0, repo: repos[repo].repo,
                        frame: NSRect(x: 0, y: top + CGFloat($0.top), width: bounds.width, height: CGFloat($0.height)))
            }
        }
    }

    /// The chosen lane, by session and repository (an index would move when the list changes)
    private var selected: (session: String, root: String)?

    private var selectedIndex: Int? {
        guard let selected else { return nil }
        return laneRefs.firstIndex { $0.lane.session == selected.session && $0.repo.root == selected.root }
    }

    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return true }

    /// Chooses the lane at `index` (top to bottom), as ↓ would; `-overviewSelect <n>` uses it for a screenshot.
    func selectLane(at index: Int) { select(index) }

    private func select(_ index: Int) {
        let refs = laneRefs
        guard refs.indices.contains(index) else { return }
        selected = (refs[index].lane.session, refs[index].repo.root)
        scrollToVisible(refs[index].frame.insetBy(dx: 0, dy: -8))
        needsDisplay = true
        NSAccessibility.post(element: self, notification: .focusedUIElementChanged)
    }

    /// ↑ ↓ move between agents (Home and End to the ends), Return or Space opens the chosen one's tab.
    override func keyDown(with event: NSEvent) {
        let count = laneRefs.count
        guard count > 0 else { return super.keyDown(with: event) }
        let current = selectedIndex
        switch event.keyCode {
        case 125: select(current.map { min($0 + 1, count - 1) } ?? 0)       // down
        case 126: select(current.map { max($0 - 1, 0) } ?? count - 1)      // up
        case 115: select(0)                                                // home
        case 119: select(count - 1)                                        // end
        case 36, 76, 49:                                                   // return, enter, space
            if let i = current { open(laneRefs[i]) } else { select(0) }
        default: super.keyDown(with: event)
        }
    }

    private func open(_ ref: LaneRef) {
        onOpen?(ref.lane, ref.repo)
    }

    // VoiceOver: each lane is a button named after its agent and where it is
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? {
        laneRefs.map { ref in
            let element = NSAccessibilityElement()
            element.setAccessibilityRole(.button)
            element.setAccessibilityParent(self)
            element.setAccessibilityLabel(laneDescription(ref.lane))
            element.setAccessibilityFrameInParentSpace(ref.frame)
            return element
        }
    }

    /// "Agent overview window, feat/x · worktree, Step 4 of 6: agent plan --json"
    private func laneDescription(_ lane: OverviewLane) -> String {
        let current = lane.stops.first { $0.stopKind == .current && !lane.labelBeside }?.label
        return "\(lane.title), \(lane.place), \(lane.status)\(current.map { ": \($0)" } ?? "")"
    }

    private func lane(at point: NSPoint) -> (OverviewLane, AgentOverviewJson.Repo)? {
        if aligned != nil {
            return laneRefs.first { point.y >= $0.frame.minY && point.y < $0.frame.maxY }.map { ($0.lane, $0.repo) }
        }
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
        window?.makeFirstResponder(self)
        guard let (lane, repo) = lane(at: point) else { return }
        selected = (lane.session, repo.root)
        needsDisplay = true
        onOpen?(lane, repo)
    }

    override func resetCursorRects() {
        if aligned != nil {
            for ref in laneRefs { addCursorRect(NSRect(x: 0, y: ref.frame.minY, width: bounds.width, height: ref.frame.height), cursor: .pointingHand) }
            return
        }
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
        if let aligned {
            for p in aligned {
                // the lane's own text, which the row beside it does not say, over the lane's empty start
                let owner = "\(p.lane.title) · \(p.lane.status)" as NSString
                tipOwners.append(owner)
                addToolTip(NSRect(x: 0, y: p.frame.minY, width: Self.alignedGx + 40, height: p.frame.height), owner: owner, userData: nil)
                for stop in p.lane.stops where !p.lane.labelBeside {
                    tip(stop, gx: Self.alignedGx, top: p.dy, radius: 9)
                }
                for loop in p.lane.loops { for stop in loop.stops { tip(stop, gx: Self.alignedGx, top: p.dy, radius: 7) } }
            }
            return
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
        if let aligned {
            // over the sidebar's own background, as its rows are
            for p in aligned where p.repo < repos.count && dirtyRect.intersects(p.frame.insetBy(dx: 0, dy: -60)) {
                if let selected, selected.root == repos[p.repo].repo.root, selected.session == p.lane.session {
                    let box = NSRect(x: 0, y: p.frame.minY + 2, width: bounds.width - 8, height: p.frame.height - 4)
                    let path = NSBezierPath(roundedRect: box, xRadius: CGFloat(DesignTokens.Radius.card), yRadius: CGFloat(DesignTokens.Radius.card))
                    theme.color(\.raised, alpha: 0.6).setFill()
                    path.fill()
                    if window?.firstResponder === self {
                        theme.color(\.borderStrong).setStroke()
                        path.lineWidth = 1
                        path.stroke()
                    }
                }
                draw(lane: p.lane, gx: Self.alignedGx, dy: p.dy, stopSpacing: CGFloat(repos[p.repo].metrics.stopSpacing),
                     elbowFromY: parentLineY(of: p), label: false)
            }
            return
        }
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
                // the chosen lane: the sidebar's selected-row fill, its border only while keys come here
                if let selected, selected.root == repos[repo].repo.root,
                   let lane = family.lanes.first(where: { $0.session == selected.session }) {
                    let box = NSRect(x: 6, y: top + CGFloat(lane.top) + 3, width: bounds.width - 12, height: CGFloat(lane.height) - 6)
                    let path = NSBezierPath(roundedRect: box, xRadius: CGFloat(DesignTokens.Radius.card), yRadius: CGFloat(DesignTokens.Radius.card))
                    theme.color(\.raised, alpha: 0.6).setFill()
                    path.fill()
                    if window?.firstResponder === self {
                        theme.color(\.borderStrong).setStroke()
                        path.lineWidth = 1
                        path.stroke()
                    }
                }
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
        for lane in family.lanes {
            draw(lane: lane, gx: CGFloat(metrics.labelWidth), dy: top, stopSpacing: CGFloat(metrics.stopSpacing),
                 elbowFromY: lane.elbow.map { top + CGFloat($0.fromY) }, label: true)
        }
    }

    /// One lane, its coordinates shifted by `gx` across and `dy` down; `elbowFromY` is where the line it
    /// branched from is (in this view), nil when that is not shown.
    private func draw(lane: OverviewLane, gx: CGFloat, dy top: CGFloat, stopSpacing: CGFloat, elbowFromY: CGFloat?, label: Bool) {
        func p(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: gx + CGFloat(x), y: top + CGFloat(y)) }
        // an ended agent's last plan: the same drawing, faded, its current stop grey
        let context = NSGraphicsContext.current?.cgContext
        if lane.isEnded { context?.saveGState(); context?.setAlpha(0.4) }
        defer { if lane.isEnded { context?.restoreGState() } }
        do {
            let state = lane.isEnded ? theme.color(\.idle) : lane.waiting ? theme.color(\.amber) : theme.color(\.green)

            // the elbow from the parent's stop (down to it, or up when the child's row is above)
            if let b = lane.elbow, let fromY = elbowFromY {
                let from = NSPoint(x: gx + CGFloat(b.fromX), y: fromY)
                let to = p(b.toX, b.toY)
                let s: CGFloat = to.y >= from.y ? 1 : -1
                let path = NSBezierPath()
                path.move(to: from)
                if abs(to.y - from.y) < 12 {
                    path.line(to: NSPoint(x: from.x, y: to.y))
                } else {
                    path.line(to: NSPoint(x: from.x, y: to.y - 12 * s))
                    path.curve(to: NSPoint(x: from.x + 12, y: to.y), controlPoint1: NSPoint(x: from.x, y: to.y - 5 * s),
                               controlPoint2: NSPoint(x: from.x + 5, y: to.y))
                }
                path.line(to: to)
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
                    let w = stopSpacing - 8
                    let current = stop.stopKind == .current
                    drawText(stop.label, in: NSRect(x: gx + CGFloat(stop.x) - w / 2, y: top + CGFloat(stop.y) - 29, width: w, height: 15),
                             font: Theme.sans(Self.stopLabelSize, weight: current ? .semibold : .regular),
                             color: current ? theme.color(\.text) : theme.color(\.faint), alignment: .center)
                }
            }

            if label { drawLabel(lane: lane, width: gx, top: top, state: state) }
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
                 font: Theme.mono(DesignTokens.TypeScale.caption), color: theme.color(\.muted))
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
