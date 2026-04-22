// Express app factory with all routes
// Calls src/lib/*.ts directly via data.ts — no subprocess spawning

import express from "express";
import { getAllCommands } from "../commands";
import { CommandConfig } from "../lib/command";
import { htmlLayout, buildSidebar } from "./templates/layout";
import { renderDashboard, renderWidgetContent } from "./templates/dashboard";
import { renderCommandPage } from "./templates/command-page";
import { renderCommitPage } from "./templates/commit-page";
import { renderTeamPage, renderProjectDetailPage } from "./templates/team-page";
import { escapeHtml } from "./templates/partials";
import { APP_JS, STYLES_CSS } from "./assets";
import * as data from "./data";

// Map command names to data fetcher functions
const dataFetchers: Record<string, () => Promise<any>> = {
  list: data.getBranchList,
  pr: data.getOpenPRs,
  diff: data.getFileChanges,
  graph: data.getCommitGraph,
  stash: data.getStashList,
  log: data.getWorkLogs,
  config: async () => data.getConfiguration(),
  team: async () => data.getTeamData(),
};

export function createServer(): express.Application {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Discover commands
  const commands = getAllCommands();
  const commandConfigs: CommandConfig[] = commands.map((cmd) => cmd.getConfig());
  const commandMap = new Map<string, CommandConfig>();
  for (const config of commandConfigs) {
    const name = config.name.split(" ")[0];
    commandMap.set(name, config);
  }
  const sidebar = buildSidebar(commandConfigs);

  // --- Static assets ---
  app.get("/assets/app.js", (_req, res) => {
    res.type("application/javascript").send(APP_JS);
  });
  app.get("/assets/styles.css", (_req, res) => {
    res.type("text/css").send(STYLES_CSS);
  });

  // --- Dashboard ---
  app.get("/", async (_req, res) => {
    const dashboardCommands = commandConfigs.filter(
      (c) => c.ui?.category === "dashboard"
    );
    dashboardCommands.sort(
      (a, b) => (a.ui?.order ?? 99) - (b.ui?.order ?? 99)
    );

    // Fetch data for each dashboard widget in parallel
    const widgets = await Promise.all(
      dashboardCommands.map(async (cmd) => {
        const name = cmd.name.split(" ")[0];
        const fetcher = dataFetchers[name];
        try {
          const widgetData = fetcher ? await fetcher() : null;
          return { command: cmd, data: widgetData };
        } catch (err: any) {
          return { command: cmd, data: null, error: err.message };
        }
      })
    );

    const content = renderDashboard(widgets);
    res.send(htmlLayout("Dashboard", content, sidebar, "dashboard"));
  });

  // --- Team page (custom UI) ---
  app.get("/command/team", async (_req, res) => {
    try {
      // Try cached analysis first (fast), fall back to basic data
      const analysis = data.getCachedTeamAnalysis() || {
        teamSummary: [],
        projects: [],
        jiraByStatus: data.getTeamData().jiraByStatus,
        prCount: data.getTeamData().prCount,
        lastFetch: data.getTeamData().lastFetch,
      };
      const content = renderTeamPage(analysis);
      res.send(htmlLayout("Team Report", content, sidebar, "team"));
    } catch (err: any) {
      res.status(500).send(
        htmlLayout("Team Report", `<div class="text-red-400 p-4">${escapeHtml(err.message)}</div>`, sidebar, "team")
      );
    }
  });

  // --- Project detail page ---
  app.get("/command/team/project/:name", async (req, res) => {
    try {
      const projectName = decodeURIComponent(req.params.name);
      const analysis = data.getCachedTeamAnalysis() || {
        teamSummary: [],
        projects: [],
        jiraByStatus: data.getTeamData().jiraByStatus,
        slackMessages: [],
        prCount: data.getTeamData().prCount,
        lastFetch: data.getTeamData().lastFetch,
      };

      const project = analysis.projects.find(
        (p: any) => p.name === projectName
      );

      if (!project) {
        res.status(404).send(
          htmlLayout("Project Not Found", `
            <div class="p-8 text-center">
              <p class="text-gray-400 mb-3">Project "${escapeHtml(projectName)}" not found</p>
              <a href="/command/team" class="text-blue-400 hover:text-blue-300 text-sm">Back to Team Report</a>
            </div>`, sidebar, "team")
        );
        return;
      }

      // Resolve links from config and git remote
      const config = data.getConfiguration().merged;
      let repoUrl: string | undefined;
      try {
        const { execSync } = require("child_process");
        const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
        // Convert SSH to HTTPS
        repoUrl = remote
          .replace(/^git@github\.com:/, "https://github.com/")
          .replace(/\.git$/, "");
      } catch {}
      const jiraBaseUrl = config.jira?.baseUrl?.replace(/\/$/, "") || undefined;

      const projectReport = data.getCachedProjectReport(projectName);
      const content = renderProjectDetailPage(project, analysis, { repoUrl, jiraBaseUrl }, projectReport);
      res.send(htmlLayout(`${projectName} — Team`, content, sidebar, "team"));
    } catch (err: any) {
      res.status(500).send(
        htmlLayout("Error", `<div class="text-red-400 p-4">${escapeHtml(err.message)}</div>`, sidebar, "team")
      );
    }
  });

  // --- SSE: Generate project detail report ---
  app.get("/api/team/project/:name/analyze", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, msg: string) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(msg)}\n\n`);
    };

    try {
      const projectName = decodeURIComponent(req.params.name);
      send("progress", "Loading project data and diffs...");
      await new Promise((r) => setTimeout(r, 100));

      send("progress", "Analyzing code changes with AI...");
      const report = await data.generateProjectDetailReport(projectName);

      send("progress", `Report generated: ${report.keyChanges.length} key changes, ${report.prReports.length} PR analyses`);
      send("done", "Report ready");
    } catch (err: any) {
      send("error", err.message);
    }
    res.end();
  });

  // --- SSE: Run AI team analysis with streaming progress ---
  app.get("/api/team/analyze", async (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, msg: string) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(msg)}\n\n`);
    };

    try {
      send("progress", "Reading cached data...");
      // Small delay so the browser can render
      await new Promise((r) => setTimeout(r, 100));

      send("progress", "Analyzing PRs and Jira issues with AI...");
      const analysis = await data.generateTeamAnalysis();

      send("progress", `Found ${analysis.projects.length} projects across ${analysis.prCount} PRs`);
      send("done", `${analysis.projects.length} projects`);
    } catch (err: any) {
      send("error", err.message);
    }
    res.end();
  });

  // --- Commit page (custom UI) ---
  app.get("/command/commit", async (_req, res) => {
    try {
      const { files } = await data.getFileChanges();
      const branch = (await import("../lib/git")).getCurrentBranch;
      const branchName = await (await import("../lib/git")).getCurrentBranch();
      const { messages, aiAvailable } = await data.getRecentCommits();
      const content = renderCommitPage(files, branchName, messages, aiAvailable);
      res.send(htmlLayout("Commit", content, sidebar, "commit"));
    } catch (err: any) {
      res.status(500).send(
        htmlLayout("Commit", `<div class="text-red-400 p-4">${escapeHtml(err.message)}</div>`, sidebar, "commit")
      );
    }
  });

  // --- Command detail page ---
  app.get("/command/:name", async (req, res) => {
    const name = req.params.name;
    const config = commandMap.get(name);

    if (!config) {
      res.status(404).send(
        htmlLayout(
          "Not Found",
          `<h1 class="text-xl text-red-400">Command '${escapeHtml(name)}' not found</h1>`,
          sidebar
        )
      );
      return;
    }

    // Fetch current data if there's a fetcher
    let pageData = null;
    let error: string | undefined;
    const fetcher = dataFetchers[name];
    if (fetcher && config.ui?.widget !== "form-only") {
      try {
        pageData = await fetcher();
      } catch (err: any) {
        error = err.message;
      }
    }

    const content = renderCommandPage(config, pageData, error);
    res.send(htmlLayout(config.ui?.label || name, content, sidebar, name));
  });

  // --- API: Project identicon ---
  app.get("/api/icon/:name", (req, res) => {
    const svg = data.projectIcon(req.params.name, 40);
    res.type("image/svg+xml").send(svg);
  });

  // --- API: List commands ---
  app.get("/api/commands", (_req, res) => {
    const result = commandConfigs
      .filter((c) => !c.ui || c.ui.category !== "hidden")
      .map((c) => ({
        name: c.name.split(" ")[0],
        description: c.description,
        arguments: c.arguments || null,
        options: c.options || [],
        ui: c.ui || null,
      }));
    res.json(result);
  });

  // --- API: Get data for a command ---
  app.get("/api/data/:name", async (req, res) => {
    const fetcher = dataFetchers[req.params.name];
    if (!fetcher) {
      res.status(404).json({ error: "No data source for this command" });
      return;
    }
    try {
      res.json(await fetcher());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- API: Actions (call data layer directly) ---
  app.post("/api/stage", async (req, res) => {
    try {
      const result = await data.doStageFiles(req.body.files || []);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/commit", async (req, res) => {
    try {
      const result = await data.doCommit(req.body.message || "");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-message", async (_req, res) => {
    try {
      const result = await data.doGenerateAIMessage();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/diff", async (req, res) => {
    try {
      const filePath = req.query.file as string;
      const withMain = req.query.withMain === "true";
      if (!filePath) {
        res.status(400).json({ error: "file parameter required" });
        return;
      }
      res.json(await data.doGetDiff(filePath, withMain));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/revert", async (req, res) => {
    try {
      res.json(await data.doRevertFile(req.body.file));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/delete-file", async (req, res) => {
    try {
      res.json(await data.doDeleteFile(req.body.file));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/recent-commits", async (_req, res) => {
    try {
      res.json(await data.getRecentCommits());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/push", async (_req, res) => {
    try {
      const result = await data.doPush();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- HTMX: Widget refresh ---
  app.get("/htmx/widget/:name", async (req, res) => {
    const name = req.params.name;
    const config = commandMap.get(name);
    if (!config?.ui) {
      res
        .status(404)
        .send(`<div class="text-red-400 text-sm">Widget not found</div>`);
      return;
    }
    const fetcher = dataFetchers[name];
    if (!fetcher) {
      res.send(
        `<div class="text-gray-400 text-sm p-4">No data source</div>`
      );
      return;
    }
    try {
      const widgetData = await fetcher();
      res.send(renderWidgetContent(config.ui, widgetData));
    } catch (err: any) {
      res.send(
        `<div class="text-red-400 text-sm p-4">${escapeHtml(err.message)}</div>`
      );
    }
  });

  return app;
}
