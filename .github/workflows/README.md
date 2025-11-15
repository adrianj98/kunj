# GitHub Actions Workflows

Automated CI/CD setup for Kunj CLI with auto-release on merge to main.

## Workflows

### CI (`ci.yml`)
- **Runs on**: Pull requests to main
- **Does**: Install → Test → Build → Verify
- **Purpose**: Ensure code quality before merging

### Auto-Release (`release.yml`)
- **Runs on**: Every merge/push to main (except [skip ci] commits)
- **Does**:
  1. Build and test
  2. Determine version bump based on commit message
  3. Bump version in package.json
  4. Create git tag
  5. Publish to NPM
  6. Create GitHub release
- **Purpose**: Automated versioning and publishing

## Version Bumping Logic

The workflow automatically determines how to bump the version based on commit messages:

| Commit Message | Version Bump | Example |
|----------------|--------------|---------|
| Contains `BREAKING CHANGE` or `!` | Major | 1.0.0 → 2.0.0 |
| Starts with `feat:` | Minor | 1.0.0 → 1.1.0 |
| Everything else | Patch | 1.0.0 → 1.0.1 |

## How It Works

1. **Create PR** → CI runs tests
2. **Merge PR** → Auto-release workflow:
   - Bumps version
   - Creates tag `v1.0.1`
   - Publishes to NPM
   - Creates GitHub release

## Skip Release

To merge without triggering a release, include `[skip ci]` in your commit message:
```bash
git commit -m "docs: update readme [skip ci]"
```

## Manual Version Control

If you need specific version control, you can:
1. Update version manually in package.json before merge
2. The workflow will detect and use that version

## Required Secrets

- `NPM_TOKEN`: Your NPM automation token for publishing

## Examples

```bash
# Feature commit (minor bump)
git commit -m "feat: add new command"
# After merge → 1.0.0 → 1.1.0

# Fix commit (patch bump)
git commit -m "fix: resolve stash issue"
# After merge → 1.1.0 → 1.1.1

# Breaking change (major bump)
git commit -m "feat!: change CLI interface"
# After merge → 1.1.1 → 2.0.0

# Skip release
git commit -m "chore: update deps [skip ci]"
# After merge → No release
```

## Notes

- Version bumps are committed back to main with `[skip ci]` to avoid loops
- Tags are automatically created and pushed
- GitHub releases include auto-generated changelogs