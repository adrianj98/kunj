// Work log management - tracks daily development activity

import * as fs from "fs";
import * as path from "path";
import { getKunjDir } from "./config";
import chalk from "chalk";

const WORK_LOG_DIR = "work-logs";

// Get the work logs directory path
export function getWorkLogDir(): string {
  return path.join(getKunjDir(), WORK_LOG_DIR);
}

// Ensure work logs directory exists
export function initWorkLogDirectory(): void {
  const workLogDir = getWorkLogDir();
  if (!fs.existsSync(workLogDir)) {
    fs.mkdirSync(workLogDir, { recursive: true });
  }
}

// Get today's date in YYYY-MM-DD format
export function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Get today's log file  path
export function getTodayLogPath(): string {
  const date = getTodayDate();
  return path.join(getWorkLogDir(), `${date}.md`);
}

// Get current time in HH:MM format
export function getCurrentTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// Format date for display
export function formatDateHeader(dateStr: string): string {
  const date = new Date(dateStr);
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
}

// Append an entry to today's work log
export function appendToWorkLog(entry: string): void {
  try {
    initWorkLogDirectory();
    const logPath = getTodayLogPath();
    const time = getCurrentTime();
    const date = getTodayDate();

    let content = "";

    // If file doesn't exist, create with header
    if (!fs.existsSync(logPath)) {
      content += `# Work Log - ${formatDateHeader(date)}\n\n`;
    }

    // Append the entry with timestamp
    content += `## ${time}\n\n${entry}\n\n`;

    fs.appendFileSync(logPath, content, "utf8");

    // Debug: verify file was written
    if (!fs.existsSync(logPath)) {
      throw new Error(`Failed to create work log file at ${logPath}`);
    }
  } catch (error: any) {
    console.error(chalk.red("Failed to write to work log:"), error.message);
    throw error; // Re-throw so caller knows it failed
  }
}

// Read today's work log
export function readTodayWorkLog(): string | null {
  try {
    const logPath = getTodayLogPath();
    if (fs.existsSync(logPath)) {
      return fs.readFileSync(logPath, "utf8");
    }
    return null;
  } catch (error) {
    console.error(chalk.red("Failed to read work log:"), error);
    return null;
  }
}

// Get all work log files
export function getAllWorkLogs(): string[] {
  try {
    initWorkLogDirectory();
    const workLogDir = getWorkLogDir();
    const files = fs.readdirSync(workLogDir);

    // Filter for markdown files and sort by date (newest first)
    return files
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(".md", ""))
      .sort()
      .reverse();
  } catch (error) {
    return [];
  }
}

// Read a specific work log by date (YYYY-MM-DD)
export function readWorkLog(date: string): string | null {
  try {
    const logPath = path.join(getWorkLogDir(), `${date}.md`);
    if (fs.existsSync(logPath)) {
      return fs.readFileSync(logPath, "utf8");
    }
    return null;
  } catch (error) {
    console.error(chalk.red("Failed to read work log:"), error);
    return null;
  }
}

// Get yesterday's date
export function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const year = yesterday.getFullYear();
  const month = String(yesterday.getMonth() + 1).padStart(2, "0");
  const day = String(yesterday.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Parse work log entries from content
export interface WorkLogEntry {
  time: string;
  content: string;
}

export function parseWorkLogEntries(logContent: string): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];

  // Split by ## headers (time markers)
  const sections = logContent.split(/^## /m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split('\n');
    if (lines.length === 0) continue;

    // First line should be the time
    const time = lines[0].trim();

    // Rest is the content
    const content = lines.slice(1).join('\n').trim();

    if (time && content) {
      entries.push({ time, content });
    }
  }

  return entries;
}

// Convert work log entries to standup format (one-liners)
export function formatAsStandupBullets(entries: WorkLogEntry[]): string[] {
  return entries.map(entry => {
    // Take the first sentence or up to 100 chars
    let summary = entry.content;

    // If there are multiple sentences, take the first one
    const firstSentence = summary.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      summary = firstSentence[0];
    }

    // Truncate if too long
    if (summary.length > 120) {
      summary = summary.substring(0, 117) + '...';
    }

    return summary.trim();
  });
}
