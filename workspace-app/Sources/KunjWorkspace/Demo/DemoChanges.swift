import Foundation
import KunjWorkspaceCore

/// The mockup's Changes column for `--demo` (warm.png): 14 files, +199 −12, `usage-rollup.ts`
/// first and selected, its diff a new file. The eight files the mockup folds into "8 more…" are
/// test fixtures and a moved `index.ts` with no line changes, so the totals match the header.
final class DemoChanges: ChangesSource {
    static let files: [ChangedFile] = [
        ChangedFile(path: "packages/insights/src/routes/usage-rollup.ts", oldPath: nil, status: .added, added: 84, deleted: 0),
        ChangedFile(path: "packages/insights/src/routes/index.ts", oldPath: nil, status: .modified, added: 2, deleted: 0),
        ChangedFile(path: "packages/insights/test/usage-rollup.test.ts", oldPath: nil, status: .added, added: 61, deleted: 0),
        ChangedFile(path: "packages/insights/src/schema.ts", oldPath: nil, status: .modified, added: 11, deleted: 3),
        ChangedFile(path: "packages/insights/src/routes/spend.ts", oldPath: nil, status: .modified, added: 4, deleted: 9),
        ChangedFile(path: "packages/insights/insights.openapi.yaml", oldPath: nil, status: .modified, added: 37, deleted: 0),
        ChangedFile(path: "packages/insights/src/index.ts", oldPath: nil, status: .modified, added: 0, deleted: 0),
    ] + (1...7).map {
        ChangedFile(path: "packages/insights/test/fixtures/usage-\($0).parquet", oldPath: nil, status: .added, added: 0, deleted: 0)
    }

    func summary(env: Environment, scope: DiffScope) async throws -> (DiffSummary, baseLabel: String) {
        (DiffSummary(files: Self.files), scope.label(base: "origin/main"))
    }

    func contents(env: Environment, scope: DiffScope, file: ChangedFile) async throws -> (original: String, modified: String) {
        if file.path.hasSuffix("usage-rollup.ts") { return ("", Self.usageRollup) }
        if file.path.hasSuffix("routes/index.ts") { return (Self.indexBefore, Self.indexAfter) }
        return ("", "")
    }

    static let usageRollup = """
    import { Hono } from "hono";
    import { z } from "zod";
    import { db } from "../db";

    const query = z.object({
      from: z.string().date(),
      to: z.string().date(),
      model: z.string().optional(),
    });

    export const usageRollup = new Hono().get("/", async (c) => {
      const q = query.parse(c.req.query());
      const rows = await db
        .selectFrom("bedrock_usage_daily")
        .select(["day", "model", "input_tokens", "output_tokens", "cost_usd"])
        .where("day", ">=", q.from)
        .where("day", "<=", q.to)
        .$if(!!q.model, (qb) => qb.where("model", "=", q.model!))
        .orderBy("day")
        .execute();
      return c.json({ rows });
    });

    """

    static let indexBefore = """
    import { Hono } from "hono";
    import { spend } from "./spend";

    export const app = new Hono();

    app.route("/insights/spend", spend);

    """

    static let indexAfter = """
    import { Hono } from "hono";
    import { spend } from "./spend";
    import { usageRollup } from "./usage-rollup";

    export const app = new Hono();

    app.route("/insights/spend", spend);
    app.route("/insights/usage/rollup", usageRollup);

    """
}
