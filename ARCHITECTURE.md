# Kunj CLI Architecture

## Overview

Kunj CLI has been refactored into a modular, pluggable architecture that makes it easy to maintain and extend. The codebase is organized into clear modules with separation of concerns.

## Directory Structure

```
src/
├── index.ts                 # Main entry point
├── commands/               # Command implementations
│   ├── index.ts           # Command registry
│   ├── create.ts          # Create command
│   ├── switch.ts          # Switch command
│   ├── list.ts            # List command
│   └── ...                # Additional commands
├── lib/                    # Core functionality
│   ├── command.ts         # Base command class & registry
│   ├── git.ts             # Git operations
│   ├── config.ts          # Configuration management
│   ├── metadata.ts        # Branch metadata management
│   ├── stash.ts           # Stash operations
│   └── utils.ts           # Utility functions
├── types/                  # TypeScript interfaces
│   └── index.ts           # All type definitions
└── constants/             # Constants and defaults
    └── index.ts           # Default configuration
```

## Core Modules

### Command System (`lib/command.ts`)

The command system uses a base class pattern for pluggable commands:

- **BaseCommand**: Abstract class that all commands extend
- **CommandRegistry**: Manages and registers commands with Commander.js

### Git Operations (`lib/git.ts`)

Encapsulates all git operations:
- Branch management
- Repository checks
- Command execution

### Configuration (`lib/config.ts`)

Manages user configuration:
- Loading/saving config files
- Default configuration
- Config file paths

### Metadata (`lib/metadata.ts`)

Handles branch metadata:
- Branch descriptions, tags, notes
- Stash tracking
- Last switched timestamps

### Stash Operations (`lib/stash.ts`)

Manages stashing functionality:
- Creating stashes with metadata
- Restoring stashes
- Tracking stashes per branch

## Adding New Commands

To add a new command, follow these steps:

### 1. Create Command File

Create a new file in `src/commands/` (e.g., `src/commands/mycommand.ts`):

```typescript
import { BaseCommand } from '../lib/command';

export class MyCommand extends BaseCommand {
  constructor() {
    super({
      name: 'mycommand <arg>',
      description: 'Description of my command',
      options: [
        { flags: '-f, --flag', description: 'A flag option' },
        { flags: '-o, --option <value>', description: 'An option with value' }
      ]
    });
  }

  async execute(arg: string, options: any): Promise<void> {
    // Command implementation
    console.log(`Executing mycommand with ${arg}`);
  }
}
```

### 2. Register Command

Add your command to `src/commands/index.ts`:

```typescript
import { MyCommand } from './mycommand';

export function getAllCommands(): BaseCommand[] {
  return [
    // ... existing commands
    new MyCommand(),
  ];
}
```

### 3. Build and Test

```bash
npm run build
node dist/index.js mycommand test --flag
```

## Benefits of Modular Architecture

1. **Maintainability**: Each module has a single responsibility
2. **Testability**: Modules can be tested independently
3. **Extensibility**: New commands can be added without modifying core code
4. **Reusability**: Shared functionality is centralized in lib modules
5. **Type Safety**: Strong typing with centralized type definitions

## Configuration Management

Configuration is stored in `.kunj/config.json` with these preferences:

- `autoStash`: Auto-stash changes when switching branches
- `branchSort`: Sort branches by "recent" or "alphabetical"
- `showStashDetails`: Show file counts and line changes
- `showOnlyWIP`: Filter to work-in-progress branches
- `personalWIPMode`: Use personal WIP detection
- And more...

## Metadata Storage

Branch metadata is stored in `.kunj/branches.json`:

```json
{
  "branches": {
    "feature-branch": {
      "description": "Adding new feature",
      "tags": ["feature", "wip"],
      "notes": "Need to review before merging",
      "lastSwitched": "2024-01-01T12:00:00.000Z",
      "stashes": [...]
    }
  }
}
```

## Best Practices

1. **Use TypeScript**: All new code should be properly typed
2. **Error Handling**: Always handle errors gracefully
3. **User Feedback**: Provide clear, colored console output
4. **Async/Await**: Use async/await for all asynchronous operations
5. **Module Imports**: Import from specific modules, not barrel exports when possible

## Future Enhancements

- Plugin system for external commands
- Hooks for command lifecycle events
- Configurable command aliases
- Remote command execution
- Integration with CI/CD pipelines