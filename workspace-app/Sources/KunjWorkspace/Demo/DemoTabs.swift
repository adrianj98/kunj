import Foundation
import KunjWorkspaceCore

extension DemoData {
    /// The mockup's tabs on the selected environment: `agent` (active, its transcript), `zsh` and
    /// `bun dev`. None runs a process. (`preview :3000` is a v2 preview tab and is left out.)
    @MainActor
    static func openTabs(in column: TerminalColumn) {
        guard let env = repos.first?.environments.first else { return }
        let r = column.registry
        let agent = r.openDemo(env: env, kind: .agent, title: "agent", text: agentTranscript)
        agent.startedAt = env.createdAt ?? now
        r.openDemo(env: env, kind: .shell, title: "zsh", text: "")
        r.openDemo(env: env, kind: .action, title: "bun dev", text: "")
        r.activate(agent)
    }

    private static let muted = "\u{1b}[90m", blue = "\u{1b}[34m", green = "\u{1b}[32m", amber = "\u{1b}[33m",
                        reset = "\u{1b}[0m"

    /// warm.html's terminal, in the theme's ANSI colours.
    static let agentTranscript = """
    \(muted)❯\(reset) add a usage rollup endpoint for llm-insights that groups bedrock spend by
    model and day

    \(blue)●\(reset) I'll look at the existing spend tables first.

    \(muted)  Read\(reset)  packages/insights/src/schema.ts
    \(muted)  Read\(reset)  packages/insights/src/routes/spend.ts
    \(muted)  Grep\(reset)  "bedrock_usage" — 6 files

    \(blue)●\(reset) There's already a daily materialized view (bedrock_usage_daily). I'll add
      GET /insights/usage/rollup on top of it instead of a new aggregation.

    \(muted)  Write\(reset) packages/insights/src/routes/usage-rollup.ts
    \(muted)  Edit\(reset)  packages/insights/src/routes/index.ts
    \(muted)  Write\(reset) packages/insights/test/usage-rollup.test.ts
    \(muted)  Bash\(reset)  bun test packages/insights
    \(green)  ✓ 18 pass\(reset)  0 fail  412ms

    \(blue)●\(reset) Done. The endpoint takes ?from, ?to and ?model, returns rows of
      { day, model, inputTokens, outputTokens, costUsd }. Want pagination on it?

    \(amber)▌\(reset) \(muted)waiting for input\(reset)\u{1b}[?25l
    """
}
