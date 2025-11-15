# Gitflow Workflow Guide

## Branch Structure

This project follows the Gitflow branching model with the following branch types:

### Protected Branches
- **`main`** - Production-ready code. All releases are tagged from this branch.
- **`develop`** - Integration branch for features. Latest development state.

### Supporting Branches
- **`feature/*`** - New features and enhancements
- **`release/*`** - Prepare for production release
- **`hotfix/*`** - Quick fixes for production issues
- **`bugfix/*`** - Bug fixes for develop branch
- **`docs/*`** - Documentation updates
- **`test/*`** - Testing improvements
- **`refactor/*`** - Code refactoring
- **`chore/*`** - Maintenance tasks

## Workflow Rules

### Feature Development
1. Create feature branches from `develop`
2. Name format: `feature/descriptive-name`
3. Merge back to `develop` via PR
4. Delete feature branch after merge

### Release Process
1. Create release branch from `develop`
2. Name format: `release/X.Y.Z`
3. Only bug fixes allowed on release branch
4. Merge to both `main` and `develop`
5. Tag the merge commit on `main` with version

### Hotfix Process
1. Create hotfix branch from `main`
2. Name format: `hotfix/X.Y.Z`
3. Fix the critical issue
4. Merge to both `main` and `develop`
5. Tag the merge commit on `main`

## GitHub Branch Protection Rules

Configure these protection rules in GitHub Settings → Branches:

### Main Branch Protection
```
Branch name pattern: main
```
- ✅ Require pull request reviews before merging
  - Required approving reviews: 1
  - Dismiss stale pull request approvals when new commits are pushed
- ✅ Require status checks to pass before merging
  - Status checks: `Test`, `Build`, `Gitflow Validation`
  - Require branches to be up to date before merging
- ✅ Require conversation resolution before merging
- ✅ Require signed commits (optional)
- ✅ Include administrators
- ✅ Restrict who can push to matching branches
  - Allowed users/teams: Release managers only
- ❌ Allow force pushes
- ❌ Allow deletions

### Develop Branch Protection
```
Branch name pattern: develop
```
- ✅ Require pull request reviews before merging
  - Required approving reviews: 1
- ✅ Require status checks to pass before merging
  - Status checks: `Test`, `Build`, `Validate PR`
- ✅ Require conversation resolution before merging
- ✅ Include administrators
- ❌ Allow force pushes
- ❌ Allow deletions

### Release Branch Protection
```
Branch name pattern: release/*
```
- ✅ Require pull request reviews before merging
  - Required approving reviews: 2
- ✅ Require status checks to pass before merging
  - Status checks: `Test`, `Build`
- ✅ Restrict who can push to matching branches
  - Allowed users/teams: Release managers
- ❌ Allow force pushes
- ❌ Allow deletions

## Automated Workflows

The following GitHub Actions are configured:

### CI Workflow (`ci.yml`)
- **Triggers**: Push to main, develop, feature/*, release/*, hotfix/*
- **Actions**: Runs tests, linting, build verification on Node 18.x and 20.x
- **Coverage**: Uploads to Codecov
- **Security**: Runs npm audit and Snyk scanning

### PR Workflow (`pr.yml`)
- **Triggers**: Pull request events
- **Actions**:
  - Auto-labels PRs by size and branch type
  - Validates PR title follows conventional commits
  - Validates branch naming convention
  - Runs tests and build checks
  - Comments test coverage on PR

### Gitflow Workflow (`gitflow.yml`)
- **Triggers**: Push to develop, release/*, hotfix/*
- **Actions**:
  - Validates branch merge rules
  - Auto-merges release/hotfix to develop
  - Auto-bumps version for releases
  - Creates release PRs to main

### Release Workflow (`release.yml`)
- **Triggers**: Push tags matching v*.*.*
- **Actions**:
  - Validates version format
  - Runs full test suite
  - Publishes to NPM
  - Creates GitHub release
  - Optionally builds Docker image

## Conventional Commits

All commits should follow the conventional commit format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions or corrections
- `build`: Build system changes
- `ci`: CI/CD changes
- `chore`: Maintenance tasks
- `revert`: Revert previous commit

### Examples
```
feat(commit): add AI-powered commit message generation
fix(git): resolve stash tracking issue with old entries
docs(readme): update installation instructions
```

## NPM Publishing

Releases are automatically published to NPM when:
1. A tag is pushed matching `v*.*.*` pattern
2. All tests pass
3. Build succeeds
4. NPM_TOKEN secret is configured

To release a new version:
```bash
# Create release branch
git checkout -b release/1.2.0 develop

# Bump version
npm version 1.2.0

# Push branch and create PR
git push -u origin release/1.2.0

# After PR approval and merge to main
git checkout main
git pull
git tag v1.2.0
git push origin v1.2.0
```

## Quick Commands

```bash
# Start a new feature
kunj feature start my-feature

# Create a release
kunj release start 1.2.0

# Create a hotfix
kunj hotfix start 1.2.1

# View gitflow status
kunj flow status
```

## Environment Secrets

Configure these secrets in GitHub repository settings:

- `NPM_TOKEN` - NPM authentication token for publishing
- `SNYK_TOKEN` - Snyk security scanning (optional)
- `CODECOV_TOKEN` - Code coverage reporting (optional)