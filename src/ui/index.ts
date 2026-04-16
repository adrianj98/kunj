// UI command - Start web dashboard for kunj

import { exec } from "child_process";
import { BaseCommand } from "../lib/command";

interface UIOptions {
  port?: string;
  open?: boolean;
}

export class UICommand extends BaseCommand {
  constructor() {
    super({
      name: "ui",
      description: "Start web dashboard",
      options: [
        {
          flags: "-p, --port <port>",
          description: "Port number (default: 3333)",
          defaultValue: "3333",
        },
        {
          flags: "--no-open",
          description: "Do not open browser automatically",
        },
      ],
      ui: { category: "hidden", widget: "form-only" },
    });
  }

  async execute(options: UIOptions = {}): Promise<void> {
    const { createServer } = await import("./server");
    const port = parseInt(options.port || "3333", 10);
    const app = createServer();

    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`\n  kunj dashboard running at ${url}\n`);

      if (options.open !== false) {
        const openCmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${openCmd} ${url}`);
      }
    });

    // Keep process alive until killed
    process.on("SIGINT", () => {
      server.close();
      process.exit(0);
    });

    await new Promise(() => {});
  }
}
