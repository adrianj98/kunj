// Type definitions for Kunj CLI

export interface KunjConfig {
  preferences: {
    autoStash: boolean;
    branchSort: "recent" | "alphabetical";
    showStashDetails: boolean;
    pageSize: number;
    showOnlyWIP: boolean;
    wipTags: string[];
    doneTags: string[];
    personalWIPMode: boolean;
    recentDays: number;
    stashAgeDays: number;
    showOnlyConfigured: boolean;
  };
  aliases: Record<string, string>;
}

export interface BranchStash {
  ref: string;  // git stash reference like stash@{0}
  message: string;
  timestamp: string;
  files?: number;
  additions?: number;
  deletions?: number;
}

export interface BranchMetadata {
  description?: string;
  tags?: string[];
  notes?: string;
  relatedIssues?: string[];
  lastSwitched?: string;
  stashes?: BranchStash[];
}

export interface BranchesMetadata {
  branches: Record<string, BranchMetadata>;
}

export interface GitCommandResult {
  success: boolean;
  message: string;
}

export interface BranchInfo {
  name: string;
  lastActivity?: string;
}

export interface CommandOptions {
  stash?: boolean;
  force?: boolean;
  remote?: boolean;
  all?: boolean;
  wip?: boolean;
  configured?: boolean;
  set?: string;
  get?: string;
  list?: boolean;
  interactive?: boolean;
  reset?: boolean;
  clear?: boolean;
  desc?: string;
  tag?: string[];
  verbose?: boolean;
}