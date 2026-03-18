# GitHub Actions Workflows

Simple CI/CD setup for Kunj CLI with tag-based releases.

## Workflows

### CI (`ci.yml`)
- **Runs on**: Pull requests to main + pushes to main
- **Does**: Install → Test → Build → Verify
- **Purpose**: Ensure code quality

### Release (`release.yml`)
- **Runs on**: Version tags (v*.*.*)
- **Does**: Build → Test → Publish to NPM → Create GitHub Release
- **Purpose**: Automated publishing when you push a version tag

## How to Release

1. **Commit your changes** to main
2. **Create and push a version tag**:

```bash
# Create a tag with your desired version
git tag v1.2.3
git push origin v1.2.3

# Or push all tags
git push --tags
```

3. **Automatic release** - The workflow will:
   - Extract version from tag (1.2.3)
   - Update package.json to match
   - Build and test
   - Publish to NPM
   - Create GitHub release with changelog

## Version Management

You control the version by creating tags:

```bash
# Patch release (1.0.0 → 1.0.1)
git tag v1.0.1

# Minor release (1.0.1 → 1.1.0)
git tag v1.1.0

# Major release (1.1.0 → 2.0.0)
git tag v2.0.0

# Pre-release
git tag v2.0.0-beta.1
```

## Required Setup

### 1. NPM Token
Add `NPM_TOKEN` secret in repository settings:
- Go to Settings → Secrets and variables → Actions
- Add new secret: `NPM_TOKEN` with your NPM automation token

### 2. GitHub Actions Permissions
The workflow needs write permissions (already configured in workflow file):
- Contents: write (for GitHub releases)
- Packages: write (for NPM publishing)

## Example Release Process

```bash
# 1. Make your changes and commit
git add .
git commit -m "feat: add awesome feature"
git push origin main

# 2. Wait for CI to pass

# 3. Tag and release
git tag v1.2.0
git push origin v1.2.0

# 4. Watch the Actions tab - release will automatically:
#    - Publish to NPM as version 1.2.0
#    - Create GitHub release v1.2.0
```

## Notes

- The version in package.json doesn't need to be updated manually
- The workflow uses the tag version as the source of truth
- Tags must follow the pattern `v*.*.*` (e.g., v1.0.0, v2.1.3)
- GitHub releases include auto-generated changelogs