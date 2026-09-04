// Fast path: commands that editors and shell prompts call many times a minute.
//
// `getAllCommands()` pulls in every command module, and with it the AWS,
// LangChain, Jira and inquirer dependencies, which costs close to a second of
// startup. Commands listed here are loaded on their own when they are the
// first CLI argument, so `kunj worktree list --json` starts in a fraction of
// that time. Anything else (including --help) still goes through the full
// registry.

import { BaseCommand } from '../lib/command';

const FAST_COMMANDS: Record<string, () => Promise<BaseCommand>> = {
  worktree: async () => new (await import('./worktree')).WorktreeCommand(),
  'prompt-info': async () => new (await import('./prompt-info')).PromptInfoCommand(),
};

export function isFastCommand(name: string | undefined): boolean {
  return !!name && Object.prototype.hasOwnProperty.call(FAST_COMMANDS, name);
}

export async function loadFastCommand(name: string | undefined): Promise<BaseCommand | null> {
  if (!isFastCommand(name)) return null;
  return FAST_COMMANDS[name as string]();
}
