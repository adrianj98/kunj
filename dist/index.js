#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const util_1 = require("util");
const inquirer_1 = __importDefault(require("inquirer"));
const chalk_1 = __importDefault(require("chalk"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const program = new commander_1.Command();
// Helper function to check if we're in a git repository
async function checkGitRepo() {
    try {
        await execAsync('git rev-parse --is-inside-work-tree');
        return true;
    }
    catch {
        return false;
    }
}
// Helper function to get current branch
async function getCurrentBranch() {
    try {
        const { stdout } = await execAsync('git branch --show-current');
        return stdout.trim();
    }
    catch (error) {
        throw new Error('Failed to get current branch');
    }
}
// Helper function to get all branches
async function getAllBranches() {
    try {
        const { stdout } = await execAsync('git branch -a');
        const branches = stdout
            .split('\n')
            .filter(branch => branch.trim())
            .map(branch => branch.replace(/^\*?\s+/, '').trim())
            .filter(branch => !branch.startsWith('remotes/'));
        return branches;
    }
    catch (error) {
        throw new Error('Failed to get branches');
    }
}
// Helper function to execute git commands with error handling
async function executeGitCommand(command) {
    try {
        const { stdout, stderr } = await execAsync(command);
        return {
            success: true,
            message: stdout || stderr || 'Command executed successfully'
        };
    }
    catch (error) {
        return {
            success: false,
            message: error.message || 'Command failed'
        };
    }
}
program
    .name('kunj')
    .description('A CLI tool for working with git branches')
    .version('1.0.0');
// Create command: kunj create <branch>
program
    .command('create <branch>')
    .description('Create a new branch and switch to it')
    .action(async (branchName) => {
    try {
        // Check if we're in a git repository
        const isGitRepo = await checkGitRepo();
        if (!isGitRepo) {
            console.error(chalk_1.default.red('Error: Not a git repository'));
            process.exit(1);
        }
        console.log(chalk_1.default.blue(`Creating branch '${branchName}' and switching to it...`));
        // Create and checkout the branch
        const result = await executeGitCommand(`git checkout -b ${branchName}`);
        if (result.success) {
            console.log(chalk_1.default.green(`✓ Successfully created and switched to branch '${branchName}'`));
        }
        else {
            // Check if branch already exists
            if (result.message.includes('already exists')) {
                console.error(chalk_1.default.red(`✗ Branch '${branchName}' already exists`));
                console.log(chalk_1.default.yellow(`Tip: Use 'kunj switch ${branchName}' to switch to it`));
            }
            else {
                console.error(chalk_1.default.red(`✗ Failed to create branch: ${result.message}`));
            }
            process.exit(1);
        }
    }
    catch (error) {
        console.error(chalk_1.default.red(`Error: ${error.message}`));
        process.exit(1);
    }
});
// Switch command: kunj switch [branch]
program
    .command('switch [branch]')
    .description('Switch to a branch (interactive if no branch specified)')
    .action(async (branchName) => {
    try {
        // Check if we're in a git repository
        const isGitRepo = await checkGitRepo();
        if (!isGitRepo) {
            console.error(chalk_1.default.red('Error: Not a git repository'));
            process.exit(1);
        }
        // If branch name is provided, switch directly
        if (branchName) {
            console.log(chalk_1.default.blue(`Switching to branch '${branchName}'...`));
            const result = await executeGitCommand(`git checkout ${branchName}`);
            if (result.success) {
                console.log(chalk_1.default.green(`✓ Successfully switched to branch '${branchName}'`));
            }
            else {
                if (result.message.includes('did not match any file')) {
                    console.error(chalk_1.default.red(`✗ Branch '${branchName}' does not exist`));
                    // Get available branches and suggest
                    const branches = await getAllBranches();
                    if (branches.length > 0) {
                        console.log(chalk_1.default.yellow('\nAvailable branches:'));
                        branches.forEach(branch => {
                            console.log(chalk_1.default.gray(`  - ${branch}`));
                        });
                    }
                }
                else {
                    console.error(chalk_1.default.red(`✗ Failed to switch branch: ${result.message}`));
                }
                process.exit(1);
            }
        }
        else {
            // Interactive branch selection
            const currentBranch = await getCurrentBranch();
            const branches = await getAllBranches();
            if (branches.length === 0) {
                console.log(chalk_1.default.yellow('No branches found'));
                process.exit(0);
            }
            // Sort branches with current branch first
            const sortedBranches = branches.sort((a, b) => {
                if (a === currentBranch)
                    return -1;
                if (b === currentBranch)
                    return 1;
                return a.localeCompare(b);
            });
            // Add indicators to branch names
            const branchChoices = sortedBranches.map(branch => ({
                name: branch === currentBranch ? `${chalk_1.default.green('●')} ${branch} ${chalk_1.default.gray('(current)')}` : `  ${branch}`,
                value: branch,
                short: branch
            }));
            // Prompt user to select a branch
            const { selectedBranch } = await inquirer_1.default.prompt([
                {
                    type: 'list',
                    name: 'selectedBranch',
                    message: 'Select a branch to switch to:',
                    choices: branchChoices,
                    pageSize: 15
                }
            ]);
            if (selectedBranch === currentBranch) {
                console.log(chalk_1.default.yellow('Already on this branch'));
                process.exit(0);
            }
            console.log(chalk_1.default.blue(`Switching to branch '${selectedBranch}'...`));
            const result = await executeGitCommand(`git checkout ${selectedBranch}`);
            if (result.success) {
                console.log(chalk_1.default.green(`✓ Successfully switched to branch '${selectedBranch}'`));
            }
            else {
                console.error(chalk_1.default.red(`✗ Failed to switch branch: ${result.message}`));
                process.exit(1);
            }
        }
    }
    catch (error) {
        console.error(chalk_1.default.red(`Error: ${error.message}`));
        process.exit(1);
    }
});
// List command: kunj list (bonus feature)
program
    .command('list')
    .description('List all branches')
    .action(async () => {
    try {
        // Check if we're in a git repository
        const isGitRepo = await checkGitRepo();
        if (!isGitRepo) {
            console.error(chalk_1.default.red('Error: Not a git repository'));
            process.exit(1);
        }
        const currentBranch = await getCurrentBranch();
        const branches = await getAllBranches();
        if (branches.length === 0) {
            console.log(chalk_1.default.yellow('No branches found'));
            process.exit(0);
        }
        console.log(chalk_1.default.blue('Branches:'));
        branches.forEach(branch => {
            if (branch === currentBranch) {
                console.log(chalk_1.default.green(`  ● ${branch} (current)`));
            }
            else {
                console.log(`    ${branch}`);
            }
        });
    }
    catch (error) {
        console.error(chalk_1.default.red(`Error: ${error.message}`));
        process.exit(1);
    }
});
// Delete command: kunj delete <branch> (bonus feature)
program
    .command('delete <branch>')
    .description('Delete a branch')
    .option('-f, --force', 'Force delete the branch')
    .action(async (branchName, options) => {
    try {
        // Check if we're in a git repository
        const isGitRepo = await checkGitRepo();
        if (!isGitRepo) {
            console.error(chalk_1.default.red('Error: Not a git repository'));
            process.exit(1);
        }
        const currentBranch = await getCurrentBranch();
        if (branchName === currentBranch) {
            console.error(chalk_1.default.red(`✗ Cannot delete the current branch '${branchName}'`));
            console.log(chalk_1.default.yellow('Tip: Switch to another branch first'));
            process.exit(1);
        }
        const deleteFlag = options.force ? '-D' : '-d';
        console.log(chalk_1.default.blue(`Deleting branch '${branchName}'...`));
        const result = await executeGitCommand(`git branch ${deleteFlag} ${branchName}`);
        if (result.success) {
            console.log(chalk_1.default.green(`✓ Successfully deleted branch '${branchName}'`));
        }
        else {
            if (result.message.includes('not found')) {
                console.error(chalk_1.default.red(`✗ Branch '${branchName}' does not exist`));
            }
            else if (result.message.includes('not fully merged')) {
                console.error(chalk_1.default.red(`✗ Branch '${branchName}' is not fully merged`));
                console.log(chalk_1.default.yellow('Tip: Use --force flag to force delete'));
            }
            else {
                console.error(chalk_1.default.red(`✗ Failed to delete branch: ${result.message}`));
            }
            process.exit(1);
        }
    }
    catch (error) {
        console.error(chalk_1.default.red(`Error: ${error.message}`));
        process.exit(1);
    }
});
// Parse command line arguments
program.parse();
//# sourceMappingURL=index.js.map