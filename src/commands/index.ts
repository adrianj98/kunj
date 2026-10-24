// Central export for all commands

export { CreateCommand } from './create';
export { SwitchCommand } from './switch';
export { ListCommand } from './list';
export { CommitCommand } from './commit';
export { PrCommand } from './pr';
export { DeleteCommand } from './delete';
export { ConfigCommand } from './config';
export { SetupCommand } from './setup';
export { LogCommand } from './log';
export { GraphCommand } from './graph';
export { DiffCommand } from './diff';
export { StashCommand } from './stash';
export { FlowCommand } from './flow';
export { JiraCommand } from './jira';
export { BranchNoteCommand, BranchTagCommand, BranchDescCommand } from './branch-metadata';
export { CompletionCommand } from './completion';
export { PromptInfoCommand } from './prompt-info';
export { IssueCommand } from './issue';
export { TeamCommand } from './team';
export { WorktreeCommand } from './worktree';
export { ContainerCommand } from './container';
export { AgentCommand } from './agent';
export { HooksCommand } from './hooks';
export { ReposCommand } from './repos';
export { EventsCommand } from './events';
export { SecretCommand } from './secret';
export { RunCommand } from './run';
export { ServeCommand } from './serve';
export { RemoteCommand } from './remote';
export { InstallCommand } from './install';
export { UICommand } from '../ui';

// Import all command classes here as they are created
// This makes it easy to import all commands from a single location

import { BaseCommand } from '../lib/command';
import { CreateCommand } from './create';
import { SwitchCommand } from './switch';
import { ListCommand } from './list';
import { CommitCommand } from './commit';
import { PrCommand } from './pr';
import { DeleteCommand } from './delete';
import { ConfigCommand } from './config';
import { SetupCommand } from './setup';
import { LogCommand } from './log';
import { GraphCommand } from './graph';
import { DiffCommand } from './diff';
import { StashCommand } from './stash';
import { FlowCommand } from './flow';
import { JiraCommand } from './jira';
import { BranchNoteCommand, BranchTagCommand, BranchDescCommand } from './branch-metadata';
import { CompletionCommand } from './completion';
import { PromptInfoCommand } from './prompt-info';
import { IssueCommand } from './issue';
import { TeamCommand } from './team';
import { WorktreeCommand } from './worktree';
import { ContainerCommand } from './container';
import { AgentCommand } from './agent';
import { HooksCommand } from './hooks';
import { ReposCommand } from './repos';
import { EventsCommand } from './events';
import { SecretCommand } from './secret';
import { RunCommand } from './run';
import { ServeCommand } from './serve';
import { RemoteCommand } from './remote';
import { InstallCommand } from './install';
import { UICommand } from '../ui';

// Export a function that returns all command instances
export function getAllCommands(): BaseCommand[] {
  return [
    new CreateCommand(),
    new SwitchCommand(),
    new ListCommand(),
    new CommitCommand(),
    new PrCommand(),
    new DeleteCommand(),
    new ConfigCommand(),
    new SetupCommand(),
    new LogCommand(),
    new GraphCommand(),
    new DiffCommand(),
    new StashCommand(),
    new FlowCommand(),
    new JiraCommand(),
    new BranchNoteCommand(),
    new BranchTagCommand(),
    new BranchDescCommand(),
    new CompletionCommand(),
    new PromptInfoCommand(),
    new IssueCommand(),
    new TeamCommand(),
    new WorktreeCommand(),
    new ContainerCommand(),
    new AgentCommand(),
    new HooksCommand(),
    new ReposCommand(),
    new EventsCommand(),
    new SecretCommand(),
    new RunCommand(),
    new ServeCommand(),
    new RemoteCommand(),
    new InstallCommand(),
    new UICommand(),
  ];
}