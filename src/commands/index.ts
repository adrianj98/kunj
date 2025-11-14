// Central export for all commands

export { CreateCommand } from './create';
export { SwitchCommand } from './switch';
export { ListCommand } from './list';
export { CommitCommand } from './commit';
export { DeleteCommand } from './delete';
export { ConfigCommand } from './config';
export { BranchNoteCommand, BranchTagCommand, BranchDescCommand } from './branch-metadata';

// Import all command classes here as they are created
// This makes it easy to import all commands from a single location

import { BaseCommand } from '../lib/command';
import { CreateCommand } from './create';
import { SwitchCommand } from './switch';
import { ListCommand } from './list';
import { CommitCommand } from './commit';
import { DeleteCommand } from './delete';
import { ConfigCommand } from './config';
import { BranchNoteCommand, BranchTagCommand, BranchDescCommand } from './branch-metadata';

// Export a function that returns all command instances
export function getAllCommands(): BaseCommand[] {
  return [
    new CreateCommand(),
    new SwitchCommand(),
    new ListCommand(),
    new CommitCommand(),
    new DeleteCommand(),
    new ConfigCommand(),
    new BranchNoteCommand(),
    new BranchTagCommand(),
    new BranchDescCommand(),
  ];
}