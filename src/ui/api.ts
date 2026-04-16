// API helpers for executing commands and fetching data

import { execFile } from "child_process";
import * as path from "path";
import { CommandConfig } from "../lib/command";

export async function executeCommandForJSON(
  commandName: string,
  args: string[] = []
): Promise<any> {
  // Use the same entry point that's currently running
  const kunjBin = path.resolve(__dirname, "..", "index.js");

  return new Promise<any>((resolve, reject) => {
    execFile(
      process.execPath,
      [kunjBin, commandName, ...args, "--json"],
      {
        cwd: process.cwd(),
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        if (err) {
          // Try to parse JSON error from stdout
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) {
              reject(new Error(parsed.error));
              return;
            }
          } catch {
            // not JSON
          }
          reject(new Error(stderr || err.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`Invalid JSON output from ${commandName}`));
        }
      }
    );
  });
}

export function parseFormToArgs(
  config: CommandConfig,
  body: Record<string, string>
): string[] {
  const args: string[] = [];

  for (const option of config.options || []) {
    const longMatch = option.flags.match(/--([a-z-]+)/);
    if (!longMatch) continue;
    const name = longMatch[1];
    const hasValue = option.flags.includes("<");
    const isNegation = option.flags.startsWith("--no-");

    if (isNegation) {
      const posName = name.replace("no-", "");
      if (!body[posName]) {
        args.push(`--${name}`);
      }
    } else if (hasValue) {
      const val = body[name];
      if (val && val.trim()) {
        args.push(`--${name}`, val.trim());
      }
    } else {
      // Boolean flag
      if (body[name] === "on" || body[name] === "true") {
        args.push(`--${name}`);
      }
    }
  }

  return args;
}
