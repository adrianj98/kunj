// Utility functions for Kunj CLI

import chalk from 'chalk';
import { KunjConfig, BranchMetadata } from '../types';
import { getBranchMetadataItem } from './metadata';

// Check if a branch is work in progress (personal branches you're working on)
export async function isBranchWIP(
  branch: string,
  config: KunjConfig,
  currentBranch?: string
): Promise<boolean> {
  const metadata = getBranchMetadataItem(branch);

  // If personal WIP mode is enabled, use personal detection
  if (config.preferences.personalWIPMode) {
    // 1. Current branch is always considered WIP
    if (currentBranch && branch === currentBranch) {
      return true;
    }

    // 2. Check if branch was recently switched to
    if (metadata.lastSwitched) {
      const lastSwitchDate = new Date(metadata.lastSwitched);
      const daysSinceSwitch = (Date.now() - lastSwitchDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceSwitch <= config.preferences.recentDays) {
        return true;
      }
    }

    // 3. Check if branch has recent stashes (from metadata)
    if (metadata.stashes && metadata.stashes.length > 0) {
      for (const stash of metadata.stashes) {
        const stashDate = new Date(stash.timestamp);
        const daysSinceStash = (Date.now() - stashDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceStash <= config.preferences.stashAgeDays) {
          return true;
        }
      }
    }

    return false;
  } else {
    // Use tag-based detection (original logic)
    // If no tags, consider it WIP by default (active development)
    if (!metadata.tags || metadata.tags.length === 0) {
      return true;
    }

    // Check if branch has any done tags (not WIP)
    const hasDoneTags = metadata.tags.some(tag =>
      config.preferences.doneTags.some(doneTag =>
        tag.toLowerCase() === doneTag.toLowerCase()
      )
    );

    if (hasDoneTags) {
      return false;
    }

    // Check if branch has any WIP tags
    const hasWipTags = metadata.tags.some(tag =>
      config.preferences.wipTags.some(wipTag =>
        tag.toLowerCase() === wipTag.toLowerCase()
      )
    );

    return hasWipTags;
  }
}

// Format value for display in configuration
export function formatConfigValue(value: any): string {
  if (typeof value === "boolean") {
    return value ? chalk.green("✓") : chalk.red("✗");
  } else if (Array.isArray(value)) {
    return chalk.cyan(`[${value.length}]`);
  } else if (typeof value === "string") {
    return chalk.yellow(value);
  } else {
    return chalk.yellow(value.toString());
  }
}

// Format boolean value with checkmark/cross
export function formatBoolValue(val: boolean): string {
  return val ? chalk.green("✓") : chalk.red("✗");
}

// Calculate relative time from a date
export function getRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }
  if (seconds > 0) {
    return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  }

  return "just now";
}

// Parse key-value string for configuration set operations
export function parseKeyValue(input: string): { keys: string[]; value: any } | null {
  const [keyPath, rawValue] = input.split("=");
  if (!rawValue) {
    return null;
  }

  const keys = keyPath.split(".");

  // Parse the value
  let value: any = rawValue;

  // Try to parse as boolean
  if (rawValue.toLowerCase() === "true") {
    value = true;
  } else if (rawValue.toLowerCase() === "false") {
    value = false;
  }
  // Try to parse as number
  else if (!isNaN(Number(rawValue))) {
    value = Number(rawValue);
  }
  // Try to parse as array (comma-separated)
  else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    value = rawValue.slice(1, -1).split(",").map(s => s.trim());
  }

  return { keys, value };
}