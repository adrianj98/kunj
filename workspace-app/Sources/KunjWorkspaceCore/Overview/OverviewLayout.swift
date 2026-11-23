import Foundation

// Where everything of a family goes in the Overview window: each agent is a lane, its plan a
// horizontal line of stops; a subagent is a loop under the line, a handed-off agent a lane that
// branches off its parent's stop. Pure numbers (Double, origin top left, y down), so it is unit
// tested without a view; OverviewCanvas only strokes what this returns.
// Mockup: docs/workspace-app/design/mockups/overview.html (the same constants).

public struct OverviewMetrics: Equatable, Sendable {
    /// The label column on the left (name, branch, status)
    public var labelWidth: Double = 248
    /// x of a root lane's first stop, from the right edge of the label column
    public var firstStop: Double = 56
    /// Distance between two stops
    public var stopSpacing: Double = 116
    /// A lane's height without loops
    public var laneHeight: Double = 74
    /// The line's y inside its lane
    public var lineOffset: Double = 40
    /// A loop's bottom under the line, for the first level; each further level adds `loopSpacing`
    public var loopDrop: Double = 30
    public var loopSpacing: Double = 38
    /// Room a loop takes under its bottom (its label)
    public var loopLabelHeight: Double = 24
    /// A lane with a marker label gives it this much before its loops
    public var markerLabelHeight: Double = 22
    /// Space right of the last stop
    public var trailing: Double = 150
    /// A character's width in the label of a lane with no steps, to make room for it
    public var loneLabelCharWidth: Double = 6.4

    public init() {}
}

public enum StopKind: Equatable, Sendable {
    case done, current, todo
}

public struct StopLayout: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var kind: StopKind
    public var label: String
    public init(x: Double, y: Double, kind: StopKind, label: String) {
        self.x = x; self.y = y; self.kind = kind; self.label = label
    }
}

/// A subagent's loop: down from `fromX` on the line, along `y`, back up at `toX`.
public struct LoopLayout: Equatable, Sendable {
    public var fromX: Double
    public var toX: Double
    public var lineY: Double
    public var y: Double
    public var running: Bool
    /// How far the loop is drawn as done (from `fromX` along the bottom); `toX` and up once it ended
    public var doneToX: Double
    public var stops: [StopLayout]
    public var label: String
}

public struct MarkerLayout: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var labelY: Double
    public var label: String
}

/// The elbow from a parent's stop down to a child's line.
public struct BranchLayout: Equatable, Sendable {
    public var fromX: Double
    public var fromY: Double
    public var toX: Double
    public var toY: Double
}

public struct LaneLayout: Equatable, Sendable {
    /// Index of the lane in its family
    public var index: Int
    public var top: Double
    public var height: Double
    /// The line's y
    public var y: Double
    public var isChild: Bool
    public var stops: [StopLayout]
    /// The line from the first stop to the last; nil for a lane with one stop or none
    public var lineFromX: Double?
    public var lineToX: Double?
    /// The line is drawn as done up to here (the current stop, or the last one when all are done)
    public var doneToX: Double?
    public var loops: [LoopLayout]
    public var markers: [MarkerLayout]
    public var branch: BranchLayout?
    /// A lane with no steps: its one stop's text goes right of it, not above
    public var labelBeside: Bool
}

public struct FamilyLayout: Equatable, Sendable {
    public var width: Double
    public var height: Double
    public var lanes: [LaneLayout]
}

/// A loop's span in stop indexes: from the step it started on to the step it ended on, at least one
/// stop wide so it can be seen. A running one reaches the current step.
func loopSpan(_ sub: PlanSubagent, current: Int?, stepCount: Int) -> (from: Int, to: Int) {
    let last = max(0, stepCount - 1)
    let from = min(max(0, sub.fromStep ?? 0), last)
    var to = sub.toStep ?? (sub.running ? (current ?? from) : from)
    to = min(max(to, from), max(last, from))
    if to == from { to = from + 1 }
    return (from, to)
}

/// Levels for loops so two that overlap are not drawn on each other: each takes the first level
/// whose last loop ended at or before its start.
func loopLevels(_ spans: [(from: Int, to: Int)]) -> [Int] {
    var ends: [Int] = []
    var levels: [Int] = []
    for s in spans {
        if let level = ends.firstIndex(where: { $0 <= s.from }) {
            ends[level] = s.to
            levels.append(level)
        } else {
            ends.append(s.to)
            levels.append(ends.count - 1)
        }
    }
    return levels
}

public func stopKind(_ step: PlanStep, isCurrent: Bool) -> StopKind {
    if step.isDone { return .done }
    return isCurrent ? .current : .todo
}

public func layoutFamily(_ family: OverviewFamily, metrics m: OverviewMetrics = OverviewMetrics()) -> FamilyLayout {
    var lanes: [LaneLayout] = []
    var firstX: [Double] = []
    var top = 0.0
    var right = 0.0

    for (index, lane) in family.lanes.enumerated() {
        let plan = lane.plan
        let n = plan.steps.count
        let y = top + m.lineOffset

        // Where the lane starts: a child half a stop after the stop it branched from
        var x0 = m.firstStop
        var branch: BranchLayout?
        if let p = lane.parent, p < lanes.count {
            let parentPlan = family.lanes[p].plan
            let at = min(max(0, plan.parent?.step ?? 0), max(0, parentPlan.steps.count - 1))
            let fromX = firstX[p] + Double(at) * m.stopSpacing
            x0 = fromX + m.stopSpacing / 2
            branch = BranchLayout(fromX: fromX, fromY: lanes[p].y, toX: x0, toY: y)
        }
        firstX.append(x0)
        let x: (Int) -> Double = { x0 + Double($0) * m.stopSpacing }

        var stops: [StopLayout] = []
        var labelBeside = false
        var lastX = x0
        if n == 0 {
            // still on the map: one stop with what it is doing
            labelBeside = true
            let label = "No task list yet"
            stops = [StopLayout(x: x0, y: y, kind: .current, label: label)]
            lastX = x0 + Double(label.count) * m.loneLabelCharWidth
        } else {
            for (i, step) in plan.steps.enumerated() {
                stops.append(StopLayout(x: x(i), y: y, kind: stopKind(step, isCurrent: plan.current == i), label: step.subject))
            }
            lastX = x(n - 1)
        }

        // done up to the current stop; with none left, the whole line
        var doneTo: Double?
        if n > 1 {
            if let c = plan.current, c < n { doneTo = c > 0 ? x(c) : nil } else { doneTo = x(n - 1) }
        }

        let drawn = plan.markers.compactMap { marker -> (PlanMarker, String)? in
            markerLabel(marker).map { (marker, $0) }
        }
        let markerRoom = drawn.isEmpty ? 0 : m.markerLabelHeight
        let markers = drawn.map { pair -> MarkerLayout in
            let (marker, label) = pair
            let after = marker.afterStep.map { min(max(0, $0), max(0, n - 1)) }
            let mx = after.map { x($0) + m.stopSpacing / 2 } ?? (x0 - m.stopSpacing / 4)
            return MarkerLayout(x: mx, y: y, labelY: y + 13, label: label)
        }
        if let far = markers.map({ $0.x }).max() { lastX = max(lastX, far) }

        let spans = plan.subagents.map { loopSpan($0, current: plan.current, stepCount: n) }
        let levels = loopLevels(spans)
        var loops: [LoopLayout] = []
        for (k, sub) in plan.subagents.enumerated() {
            let a = x(spans[k].from)
            let b = x(spans[k].to)
            let ly = y + markerRoom + m.loopDrop + Double(levels[k]) * m.loopSpacing
            let count = sub.steps.count
            let inner = b - a - 48
            let sx: (Int) -> Double = { count <= 1 ? (a + b) / 2 : a + 24 + Double($0) * inner / Double(count - 1) }
            let currentSub = sub.running ? sub.steps.firstIndex(where: { $0.status == "in_progress" }) : nil
            var subStops: [StopLayout] = []
            for (i, step) in sub.steps.enumerated() {
                subStops.append(StopLayout(x: sx(i), y: ly, kind: stopKind(step, isCurrent: currentSub == i), label: step.subject))
            }
            var doneToX = b
            if sub.running {
                // as far as its last finished or current step; a loop with no steps is all "to come"
                let reached = currentSub ?? sub.steps.lastIndex(where: { $0.isDone })
                doneToX = reached.map { sx($0) } ?? a
            }
            loops.append(LoopLayout(fromX: a, toX: b, lineY: y, y: ly, running: sub.running, doneToX: doneToX,
                                    stops: subStops, label: subagentLabel(sub)))
            lastX = max(lastX, b)
        }

        let levelCount = (levels.max() ?? -1) + 1
        let loopRoom = levelCount == 0 ? 0 : m.loopDrop + Double(levelCount - 1) * m.loopSpacing + m.loopLabelHeight - (m.laneHeight - m.lineOffset) + 12
        let height = m.laneHeight + markerRoom + max(0, loopRoom)
        lanes.append(LaneLayout(index: index, top: top, height: height, y: y, isChild: lane.parent != nil, stops: stops,
                                lineFromX: n > 1 ? x(0) : nil, lineToX: n > 1 ? x(n - 1) : nil, doneToX: doneTo,
                                loops: loops, markers: markers, branch: branch, labelBeside: labelBeside))
        top += height
        right = max(right, lastX)
    }
    return FamilyLayout(width: m.labelWidth + right + m.trailing, height: top, lanes: lanes)
}

/// The lane at `y` (from the family's top), for a click.
public func laneIndex(at y: Double, in layout: FamilyLayout) -> Int? {
    layout.lanes.first { y >= $0.top && y < $0.top + $0.height }?.index
}
