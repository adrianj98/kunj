# GitHub Actions Workflows

Simple CI/CD setup for Kunj CLI.

## Workflows

### CI (`ci.yml`)
- **Runs on**: Pull requests and pushes to main
- **Does**: Install → Test → Build → Verify
- **Purpose**: Ensure code quality before merging

### Release (`release.yml`)
- **Runs on**: Version tags (v*.*.*)
- **Does**: Build → Test → Publish to NPM → Create GitHub Release
- **Purpose**: Automated package publishing

## How to Release

1. Update version in package.json:
   ```bash
   npm version patch  # or minor, major
   ```

2. Push with tags:
   ```bash
   git push && git push --tags
   ```

3. The release workflow will automatically:
   - Run tests
   - Publish to NPM
   - Create a GitHub release with changelog

## Required Secrets

- `NPM_TOKEN`: Your NPM automation token for publishing

That's it! Simple and effective.