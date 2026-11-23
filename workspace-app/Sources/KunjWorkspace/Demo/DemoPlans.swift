import Foundation
import KunjWorkspaceCore

/// The Overview mockup's agents (docs/workspace-app/design/mockups/overview.html) for
/// `--demo --overview`: the same lines, so a screenshot can be held against the mockup.
enum DemoPlans {
    /// `d` done, `c` current, anything else to come
    private static func steps(_ items: [(String, String)]) -> [PlanStep] {
        items.enumerated().map { i, item in
            PlanStep(id: "\(i + 1)", subject: item.1, status: item.0 == "d" ? "completed" : item.0 == "c" ? "in_progress" : "pending")
        }
    }

    private static func plan(_ session: String, _ title: String?, branch: String, container: String? = nil, id: String? = nil,
                             waiting: Bool = false, _ items: [(String, String)], markers: [PlanMarker] = [],
                             subagents: [PlanSubagent] = [], parent: PlanParent? = nil) -> AgentPlan {
        let list = steps(items)
        return AgentPlan(session: session, id: id, branch: branch, worktree: "/Users/demo/src/\(branch)", container: container,
                         title: title, running: true, state: waiting ? "waiting" : "running", steps: list,
                         current: list.firstIndex { $0.status == "in_progress" }, markers: markers, subagents: subagents,
                         parent: parent)
    }

    static let repos: [OverviewRepo] = [
        OverviewRepo(name: DemoData.kunj.name, root: DemoData.kunj.root, plans: [
            plan("kunj-kunj-feat-agent-overview", "Agent overview window", branch: "feat/agent-overview",
                 [("d", "Probe the hooks"), ("d", "Capture in hooks"), ("d", "Plan reducer"), ("c", "agent plan --json"),
                  ("t", "Events action"), ("t", "Docs and okf")],
                 subagents: [PlanSubagent(id: "s1", type: "general-purpose", task: "write reducer tests", fromStep: 2, toStep: nil,
                                          running: true, steps: steps([("d", "Record fixtures"), ("c", "Unit tests"), ("t", "Edge cases")]))]),
            plan("kunj-kunj-feat-agent-overview-app", "Overview window (app)", branch: "feat/agent-overview-app",
                 [("d", "Layout maths"), ("c", "Line view"), ("t", "Row list"), ("t", "Demo data"), ("t", "Screenshot check")],
                 parent: PlanParent(session: "kunj-kunj-feat-agent-overview", step: 1)),
            plan("kunj-kunj-feat-vscode-search", "Search in VS Code", branch: "feat/vscode-search", waiting: true,
                 [("d", "Quick pick"), ("d", "Run kunj search"), ("c", "Open the result"), ("t", "Tests")],
                 markers: [PlanMarker(type: "branch", afterStep: 0, from: "main", to: "feat/vscode-search")]),
            plan("agent", "Remote terminal hangup", branch: "fix/remote-pty", container: "kunj-kunj-fix-remote-pty", []),
        ]),
        OverviewRepo(name: DemoData.alertd.name, root: DemoData.alertd.root, plans: [
            plan("agent", "Usage rollup endpoint", branch: "feat/llm-insights", container: "alertd-core-feat-llm-insights", waiting: true,
                 [("d", "Read spend tables"), ("d", "Add the route"), ("d", "Tests"), ("d", "OpenAPI"), ("c", "Pagination")]),
            plan("agent-two", "Try cursor pagination", branch: "feat/llm-insights", container: "alertd-core-feat-llm-insights", id: "two",
                 [("d", "Cursor param"), ("c", "Tests")], parent: PlanParent(session: "agent", step: 3)),
            plan("kunj-alertd-core-fix-alert-dedupe", "Dedupe alert fan-out", branch: "fix/alert-dedupe",
                 [("d", "Reproduce"), ("d", "Failing test"), ("c", "Fix the fan-out"), ("t", "Run the suite"), ("t", "Open the PR")],
                 subagents: [PlanSubagent(id: "s2", type: "Explore", task: "find fan-out callers", fromStep: 0, toStep: 1, running: false,
                                          steps: steps([("d", "Grep callers"), ("d", "Read queue code")]))]),
        ]),
    ]
}
