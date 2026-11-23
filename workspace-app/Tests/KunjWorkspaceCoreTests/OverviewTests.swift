import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct OverviewTests {
    /// `kunj agent plan --all --json` in the shape kunj prints (src/lib/json-types.ts AgentPlanJson)
    func fixture() async throws -> AgentPlanJson {
        try await fakeKunjCLI().run(agentPlanArguments(), cwd: "/")
    }

    func step(_ id: Int, _ status: String = "pending") -> PlanStep {
        PlanStep(id: "\(id)", subject: "step \(id)", status: status)
    }

    func plan(_ session: String, steps: [PlanStep] = [], current: Int? = nil, state: String? = "running",
              parent: PlanParent? = nil, subagents: [PlanSubagent] = [], markers: [PlanMarker] = []) -> AgentPlan {
        AgentPlan(session: session, branch: session, state: state, steps: steps, current: current,
                  markers: markers, subagents: subagents, parent: parent)
    }

    // ---- decoding and arguments

    @Test func decodesTheListing() async throws {
        let json = try await fixture()
        #expect(json.plans.count == 5)
        let first = json.plans[0]
        #expect(first.title == "Agent overview window")
        #expect(first.id == nil)
        #expect(first.current == 3)
        #expect(first.steps.count == 6)
        #expect(first.steps[0].isDone)
        #expect(first.subagents[0].toStep == nil)
        #expect(first.subagents[0].steps.count == 3)
        #expect(json.plans[1].parent == PlanParent(session: first.session, step: 1))
        #expect(json.plans[2].markers.map { $0.type } == ["branch", "compact"])
        #expect(json.plans[3].id == "two")
        #expect(json.plans[3].updatedAt == nil)
        #expect(json.plans[4].running == false)
    }

    @Test func decodesAContainerPlan() async throws {
        let args = containerAgentPlanArguments(branch: "feature/x", remote: ["--remote", "local"])
        #expect(args == ["ct", "agent", "feature/x", "--plan", "--remote", "local"])
        let json: AgentPlanJson = try await fakeKunjCLI().run(args, cwd: "/")
        #expect(json.plans[0].container == "kunj-alertd-core-feature-x-1a2b3c")
        #expect(json.plans[0].isWaiting)
        #expect(planPlace(json.plans[0], isChild: false) == "feature/x · container")
    }

    @Test func listArguments() {
        #expect(agentPlanArguments() == ["agent", "plan", "--all"])
    }

    // ---- which agents, in which order

    @Test func endedSessionsAreLeftOutAndUnknownOnesKept() async throws {
        let active = activePlans(try await fixture().plans)
        #expect(active.count == 4)
        var unknown = plan("u")
        unknown.running = nil
        #expect(activePlans([unknown]).count == 1)
    }

    @Test func aChildFollowsItsParentAndAnOrphanIsARoot() async throws {
        let families = overviewFamilies(activePlans(try await fixture().plans))
        #expect(families.map { $0.lanes.count } == [2, 1, 1])
        #expect(families[0].lanes[0].parent == nil)
        #expect(families[0].lanes[1].parent == 0)
        let orphan = plan("child", parent: PlanParent(session: "gone", step: 2))
        #expect(overviewFamilies([orphan]).map { $0.lanes.map { $0.parent } } == [[nil]])
    }

    @Test func grandchildrenStayInTheFamilyAndACycleDoesNotLoseAnyone() {
        let a = plan("a")
        let b = plan("b", parent: PlanParent(session: "a", step: 0))
        let c = plan("c", parent: PlanParent(session: "b", step: 0))
        let d = plan("d", parent: PlanParent(session: "a", step: 1))
        let family = overviewFamilies([d, c, b, a])
        #expect(family.count == 1)
        #expect(family[0].lanes.map { $0.plan.session } == ["a", "d", "b", "c"])
        #expect(family[0].lanes.map { $0.parent } == [nil, 0, 0, 2])
        let x = plan("x", parent: PlanParent(session: "y", step: nil))
        let y = plan("y", parent: PlanParent(session: "x", step: nil))
        #expect(overviewFamilies([x, y]).flatMap { $0.lanes }.map { $0.plan.session }.sorted() == ["x", "y"])
        let me = plan("me", parent: PlanParent(session: "me", step: nil))
        #expect(overviewFamilies([me]).count == 1)
    }

    @Test func aFamilyIsShownWhenAnyLanePassesTheFilter() {
        let parent = plan("p", state: "running")
        let child = plan("c", state: "waiting", parent: PlanParent(session: "p", step: nil))
        let alone = plan("z", state: "running")
        let families = overviewFamilies([parent, child, alone])
        #expect(filterFamilies(families, .all).count == 2)
        #expect(filterFamilies(families, .waiting).map { $0.lanes.count } == [2])
        #expect(filterFamilies(families, .running).count == 2)
    }

    // ---- text

    @Test func statusTitleAndSummary() {
        #expect(planStatus(plan("a", state: "waiting")) == "Waiting for input")
        #expect(planStatus(plan("a")) == "Working")
        #expect(planStatus(plan("a", steps: [step(1, "completed"), step(2, "in_progress"), step(3)], current: 1)) == "Step 2 of 3")
        #expect(planStatus(plan("a", steps: [step(1, "completed")], current: nil)) == "All 1 step done")
        #expect(planTitle(plan("feat/x")) == "feat/x")
        var titled = plan("feat/x")
        titled.title = "  Do the thing "
        #expect(planTitle(titled) == "Do the thing")
        var second = plan("feat/x")
        second.id = "two"
        #expect(planPlace(second, isChild: false) == "feat/x · worktree · agent two")
        #expect(planPlace(second, isChild: true) == "handoff · feat/x · agent two")

        let repos = [OverviewRepo(name: "r", root: "/r", plans: [plan("a", state: "waiting"), plan("b")])]
        #expect(overviewSummary(repos) == "2 agents · 1 waiting for you")
        #expect(overviewSummary([OverviewRepo(name: "r", root: "/r", plans: [plan("b")])]) == "1 agent")
        #expect(overviewSummary([]) == "No agents running")
    }

    @Test func markerAndSubagentLabels() {
        #expect(markerLabel(PlanMarker(type: "branch", afterStep: 0, from: "main", to: "feat/x")) == "main → feat/x")
        #expect(markerLabel(PlanMarker(type: "worktree", afterStep: nil, from: "/r", to: "/r/.git/kunj/worktrees/b")) == "r → b")
        #expect(markerLabel(PlanMarker(type: "fork", afterStep: 1)) == "fork")
        #expect(markerLabel(PlanMarker(type: "compact", afterStep: 1)) == nil)
        #expect(markerLabel(PlanMarker(type: "something-new", afterStep: 1)) == nil)
        #expect(subagentLabel(PlanSubagent(id: "s", type: "Explore", task: nil, fromStep: 0, toStep: 1, running: false)) == "subagent · Explore · done")
        #expect(subagentLabel(PlanSubagent(id: "s", type: "Explore", task: "find callers", fromStep: 0, toStep: nil, running: true)) == "subagent · find callers")
    }

    // ---- geometry

    @Test func stopsAreEvenlySpacedAndTheLineIsDoneUpToTheCurrentStop() {
        let m = OverviewMetrics()
        let p = plan("a", steps: [step(1, "completed"), step(2, "completed"), step(3, "in_progress"), step(4)], current: 2)
        let layout = layoutFamily(OverviewFamily(lanes: [.init(plan: p, parent: nil)]), metrics: m)
        let lane = layout.lanes[0]
        #expect(lane.stops.map { $0.x } == [56, 172, 288, 404])
        #expect(lane.stops.map { $0.kind } == [.done, .done, .current, .todo])
        #expect(lane.y == 40)
        #expect(lane.lineFromX == 56)
        #expect(lane.lineToX == 404)
        #expect(lane.doneToX == 288)
        #expect(lane.height == m.laneHeight)
        #expect(layout.height == m.laneHeight)
        #expect(layout.width == m.labelWidth + 404 + m.trailing)
        #expect(!lane.labelBeside)
    }

    @Test func aFinishedLineIsDoneToItsEndAndAFreshOneNotAtAll() {
        let done = plan("a", steps: [step(1, "completed"), step(2, "completed")], current: nil)
        #expect(layoutFamily(OverviewFamily(lanes: [.init(plan: done, parent: nil)])).lanes[0].doneToX == 172)
        let fresh = plan("a", steps: [step(1, "in_progress"), step(2)], current: 0)
        #expect(layoutFamily(OverviewFamily(lanes: [.init(plan: fresh, parent: nil)])).lanes[0].doneToX == nil)
    }

    @Test func anAgentWithNoTaskListIsOneStopWithItsTextBeside() {
        let layout = layoutFamily(OverviewFamily(lanes: [.init(plan: plan("a"), parent: nil)]))
        let lane = layout.lanes[0]
        #expect(lane.stops.count == 1)
        #expect(lane.stops[0].kind == .current)
        #expect(lane.labelBeside)
        #expect(lane.lineFromX == nil)
        #expect(layout.width > OverviewMetrics().labelWidth + 56 + OverviewMetrics().trailing)
    }

    @Test func aChildStartsHalfAStopAfterTheStopItBranchedFrom() {
        let parent = plan("p", steps: [step(1, "completed"), step(2, "in_progress"), step(3)], current: 1)
        let child = plan("c", steps: [step(1, "in_progress"), step(2)], current: 0, parent: PlanParent(session: "p", step: 1))
        let layout = layoutFamily(overviewFamilies([parent, child])[0])
        let lane = layout.lanes[1]
        #expect(lane.isChild)
        #expect(lane.top == layout.lanes[0].height)
        #expect(lane.branch == ElbowLayout(fromX: 172, fromY: 40, toX: 230, toY: lane.top + 40))
        #expect(lane.stops.map { $0.x } == [230, 346])
        // a step the parent no longer has is clamped to its last stop
        let far = plan("c", steps: [step(1)], parent: PlanParent(session: "p", step: 9))
        #expect(layoutFamily(overviewFamilies([parent, far])[0]).lanes[1].branch?.fromX == 288)
    }

    @Test func aLoopSpansItsStepsIsAtLeastOneStopWideAndMakesTheLaneTaller() {
        let m = OverviewMetrics()
        let steps = [step(1, "completed"), step(2, "completed"), step(3, "in_progress"), step(4)]
        let ended = PlanSubagent(id: "s1", type: "t", task: "x", fromStep: 0, toStep: 1, running: false,
                                 steps: [step(5, "completed"), step(6, "completed")])
        let running = PlanSubagent(id: "s2", type: "t", task: "y", fromStep: 2, toStep: nil, running: true,
                                   steps: [step(7, "completed"), step(8, "in_progress"), step(9)])
        let p = plan("a", steps: steps, current: 2, subagents: [ended, running])
        let lane = layoutFamily(OverviewFamily(lanes: [.init(plan: p, parent: nil)]), metrics: m).lanes[0]
        #expect(lane.loops.count == 2)
        #expect(lane.loops[0].fromX == 56)
        #expect(lane.loops[0].toX == 172)
        #expect(lane.loops[0].y == 40 + m.loopDrop)
        #expect(lane.loops[0].doneToX == 172)
        #expect(lane.loops[0].stops.map { $0.x } == [80, 148])
        // started and still on the current step: one stop wide
        #expect(lane.loops[1].fromX == 288)
        #expect(lane.loops[1].toX == 404)
        #expect(lane.loops[1].stops.map { $0.kind } == [.done, .current, .todo])
        #expect(lane.loops[1].doneToX == lane.loops[1].stops[1].x)
        // they do not overlap, so one level
        #expect(lane.loops[1].y == lane.loops[0].y)
        #expect(lane.height > m.laneHeight)
    }

    @Test func overlappingLoopsStackAndALoopWithOneStepCentresIt() {
        #expect(loopLevels([(from: 0, to: 2), (from: 1, to: 3), (from: 2, to: 3), (from: 3, to: 4)]) == [0, 1, 0, 0])
        #expect(loopLevels([]) == [])
        let a = PlanSubagent(id: "a", type: "t", task: nil, fromStep: 0, toStep: 2, running: false, steps: [step(9, "completed")])
        let b = PlanSubagent(id: "b", type: "t", task: nil, fromStep: 1, toStep: 2, running: false)
        let p = plan("a", steps: [step(1, "completed"), step(2, "completed"), step(3, "in_progress")], current: 2, subagents: [a, b])
        let m = OverviewMetrics()
        let lane = layoutFamily(OverviewFamily(lanes: [.init(plan: p, parent: nil)]), metrics: m).lanes[0]
        #expect(lane.loops[1].y == lane.loops[0].y + m.loopSpacing)
        #expect(lane.loops[0].stops.map { $0.x } == [(56.0 + 288.0) / 2])
    }

    @Test func loopSpansAreClampedToTheLine() {
        func span(_ from: Int?, _ to: Int?, _ running: Bool, current: Int?, count: Int) -> [Int] {
            let sub = PlanSubagent(id: "s", type: "t", task: nil, fromStep: from, toStep: to, running: running)
            let s = loopSpan(sub, current: current, stepCount: count)
            return [s.from, s.to]
        }
        #expect(span(nil, nil, true, current: nil, count: 0) == [0, 1])
        #expect(span(1, 9, false, current: 2, count: 3) == [1, 2])
        #expect(span(2, 2, false, current: 2, count: 3) == [2, 3])
        #expect(span(0, nil, true, current: 2, count: 3) == [0, 2])
        #expect(span(3, 1, false, current: 0, count: 4) == [3, 4])
    }

    @Test func aMarkerSitsBetweenTwoStopsAndOnlyDrawnOnesTakeRoom() async throws {
        let m = OverviewMetrics()
        let searching = activePlans(try await fixture().plans)[2]
        let lane = layoutFamily(OverviewFamily(lanes: [.init(plan: searching, parent: nil)]), metrics: m).lanes[0]
        // the compact marker is not drawn
        #expect(lane.markers.map { $0.label } == ["main → feat/vscode-search"])
        #expect(lane.markers[0].x == 56 + m.stopSpacing / 2)
        // its label fits under the line; only loops after it need more room
        #expect(lane.height == m.laneHeight)
        var withLoop = searching
        withLoop.subagents = [PlanSubagent(id: "s", type: "t", task: nil, fromStep: 0, toStep: 1, running: false)]
        let both = layoutFamily(OverviewFamily(lanes: [.init(plan: withLoop, parent: nil)]), metrics: m).lanes[0]
        #expect(both.loops[0].y == 40 + m.markerLabelHeight + m.loopDrop)
        #expect(both.height > m.laneHeight + m.markerLabelHeight)
        let before = plan("a", steps: [step(1)], markers: [PlanMarker(type: "fork", afterStep: nil)])
        #expect(layoutFamily(OverviewFamily(lanes: [.init(plan: before, parent: nil)]), metrics: m).lanes[0].markers[0].x < 56)
        let onlyCompact = plan("a", steps: [step(1)], markers: [PlanMarker(type: "compact", afterStep: 0)])
        #expect(layoutFamily(OverviewFamily(lanes: [.init(plan: onlyCompact, parent: nil)]), metrics: m).lanes[0].height == m.laneHeight)
    }

    @Test func aClickFindsItsLane() {
        let parent = plan("p", steps: [step(1)])
        let child = plan("c", steps: [step(1)], parent: PlanParent(session: "p", step: 0))
        let layout = layoutFamily(overviewFamilies([parent, child])[0])
        #expect(laneIndex(at: 5, in: layout) == 0)
        #expect(laneIndex(at: layout.lanes[1].top + 1, in: layout) == 1)
        #expect(laneIndex(at: layout.height + 1, in: layout) == nil)
        #expect(laneIndex(at: -1, in: layout) == nil)
    }
}
