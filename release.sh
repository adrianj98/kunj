#!/bin/bash

# Simple release helper script for Kunj CLI

echo "🚀 Kunj CLI Release Helper"
echo "========================="
echo ""

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "⚠️  Warning: Not on main branch (currently on $CURRENT_BRANCH)"
    read -p "Continue anyway? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "❌ You have uncommitted changes. Please commit or stash them first."
    exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: v$CURRENT_VERSION"
echo ""

# Ask for version bump type
echo "How would you like to bump the version?"
echo "1) Patch (bug fixes)     - $CURRENT_VERSION → $(echo $CURRENT_VERSION | awk -F. '{print $1"."$2"."$3+1}')"
echo "2) Minor (new features)  - $CURRENT_VERSION → $(echo $CURRENT_VERSION | awk -F. '{print $1"."$2+1".0"}')"
echo "3) Major (breaking)      - $CURRENT_VERSION → $(echo $CURRENT_VERSION | awk -F. '{print $1+1".0.0"}')"
echo "4) Custom version"
echo ""

read -p "Select option (1-4): " VERSION_CHOICE

case $VERSION_CHOICE in
    1)
        NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1"."$2"."$3+1}')
        ;;
    2)
        NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1"."$2+1".0"}')
        ;;
    3)
        NEW_VERSION=$(echo $CURRENT_VERSION | awk -F. '{print $1+1".0.0"}')
        ;;
    4)
        read -p "Enter custom version (without 'v' prefix): " NEW_VERSION
        ;;
    *)
        echo "Invalid option"
        exit 1
        ;;
esac

echo ""
echo "📦 Ready to release v$NEW_VERSION"
read -p "Proceed with release? (y/n): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release cancelled"
    exit 1
fi

# Pull latest changes
echo "Pulling latest changes..."
git pull origin main

# Create and push tag
echo "Creating tag v$NEW_VERSION..."
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo "Pushing tag to GitHub..."
git push origin "v$NEW_VERSION"

echo ""
echo "✅ Release tag v$NEW_VERSION pushed successfully!"
echo ""
echo "🔄 GitHub Actions will now:"
echo "   1. Run tests"
echo "   2. Build the project"
echo "   3. Publish to NPM"
echo "   4. Create GitHub release"
echo ""
echo "📊 Monitor progress at: https://github.com/adrianj98/kunj/actions"
echo ""