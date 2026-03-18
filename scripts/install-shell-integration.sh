#!/usr/bin/env bash

# Kunj Shell Integration Installer
# This script helps set up autocomplete and PR# in prompt

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Kunj Shell Integration Installer     ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo ""

# Detect shell
SHELL_NAME=$(basename "$SHELL")
RC_FILE=""

case "$SHELL_NAME" in
  zsh)
    RC_FILE="$HOME/.zshrc"
    PROMPT_SCRIPT="$(dirname "$0")/kunj-prompt.zsh"
    ;;
  bash)
    RC_FILE="$HOME/.bashrc"
    PROMPT_SCRIPT="$(dirname "$0")/kunj-prompt.bash"
    ;;
  *)
    echo -e "${RED}✗ Unsupported shell: $SHELL_NAME${NC}"
    echo -e "${YELLOW}Supported shells: zsh, bash${NC}"
    exit 1
    ;;
esac

echo -e "${GREEN}✓ Detected shell: $SHELL_NAME${NC}"
echo -e "${GREEN}✓ Configuration file: $RC_FILE${NC}"
echo ""

# Function to install autocomplete
install_autocomplete() {
  echo -e "${BLUE}Installing autocomplete...${NC}"

  if kunj completion --install 2>/dev/null; then
    echo -e "${GREEN}✓ Autocomplete installed${NC}"
  else
    echo -e "${YELLOW}⚠ Autocomplete installation failed, adding manual config${NC}"

    # Add manual completion to RC file
    if ! grep -q "kunj completion" "$RC_FILE"; then
      echo "" >> "$RC_FILE"
      echo "# Kunj autocomplete" >> "$RC_FILE"
      echo 'if command -v kunj &> /dev/null; then' >> "$RC_FILE"
      echo '  eval "$(kunj completion 2>/dev/null || true)"' >> "$RC_FILE"
      echo 'fi' >> "$RC_FILE"
      echo -e "${GREEN}✓ Added manual completion config${NC}"
    fi
  fi
}

# Function to install prompt integration
install_prompt() {
  echo -e "${BLUE}Installing PR# prompt integration...${NC}"

  # Check if already installed
  if grep -q "kunj_prompt_pr" "$RC_FILE"; then
    echo -e "${YELLOW}⚠ Prompt integration already installed${NC}"
    return
  fi

  # Get absolute path to prompt script
  PROMPT_SCRIPT_ABS=$(cd "$(dirname "$PROMPT_SCRIPT")" && pwd)/$(basename "$PROMPT_SCRIPT")

  if [ -f "$PROMPT_SCRIPT_ABS" ]; then
    echo "" >> "$RC_FILE"
    echo "# Kunj PR# prompt integration" >> "$RC_FILE"
    echo "source \"$PROMPT_SCRIPT_ABS\"" >> "$RC_FILE"
    echo -e "${GREEN}✓ Prompt integration added${NC}"
  else
    echo -e "${RED}✗ Prompt script not found: $PROMPT_SCRIPT_ABS${NC}"
  fi
}

# Main menu
echo -e "${YELLOW}What would you like to install?${NC}"
echo "1) Autocomplete only"
echo "2) PR# in prompt only"
echo "3) Both (recommended)"
echo "4) Cancel"
echo ""
read -p "Choose [1-4]: " choice

case $choice in
  1)
    install_autocomplete
    ;;
  2)
    install_prompt
    ;;
  3)
    install_autocomplete
    echo ""
    install_prompt
    ;;
  4)
    echo -e "${YELLOW}Installation cancelled${NC}"
    exit 0
    ;;
  *)
    echo -e "${RED}✗ Invalid choice${NC}"
    exit 1
    ;;
esac

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Installation Complete!                ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}To activate the changes, run:${NC}"
echo -e "  ${BLUE}source $RC_FILE${NC}"
echo ""
echo -e "${YELLOW}Or restart your terminal.${NC}"
echo ""
