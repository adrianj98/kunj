// Constants and default values for Kunj CLI

import { KunjConfig } from '../types';

export const defaultConfig: KunjConfig = {
  preferences: {
    autoStash: true,
    branchSort: "recent",
    showStashDetails: true,
    pageSize: 15,
    showOnlyWIP: false,
    wipTags: ["wip", "in-progress", "working", "draft"],
    doneTags: ["done", "completed", "merged", "ready"],
    personalWIPMode: true,
    recentDays: 7,
    stashAgeDays: 30,
    showOnlyConfigured: false
  },
  aliases: {}
};

export const KUNJ_DIR = ".kunj";
export const CONFIG_FILE = "config.json";
export const BRANCHES_FILE = "branches.json";