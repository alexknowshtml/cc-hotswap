#!/bin/bash
#
# claude-code-swap: Rotate between Claude Code Max plan accounts
# https://github.com/alexknowshtml/claude-code-swap
#
# Usage:
#   swap.sh                  Show current account and list all
#   swap.sh <name>           Switch to named account
#   swap.sh add <name>       Save current login as a named account
#   swap.sh remove <name>    Remove a saved account
#   swap.sh status           Show current account details

set -euo pipefail

ACCT_DIR="${CLAUDE_SWAP_DIR:-$HOME/.claude/accounts}"
CREDS="$HOME/.claude/.credentials.json"
CURRENT_FILE="$ACCT_DIR/.current"

# Colors (disable with NO_COLOR=1)
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  DIM='\033[0;90m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' DIM='' BOLD='' NC=''
fi

current() {
  cat "$CURRENT_FILE" 2>/dev/null || echo "unknown"
}

list_accounts() {
  local found=0
  for f in "$ACCT_DIR"/creds-*.json; do
    [ -f "$f" ] || continue
    found=1
    name=$(basename "$f" | sed 's/^creds-//;s/\.json$//')
    if [ "$name" = "$(current)" ]; then
      echo -e "  ${GREEN}*${NC} ${BOLD}$name${NC} ${GREEN}(active)${NC}"
    else
      echo -e "    $name"
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo -e "  ${DIM}No accounts saved. Run: swap.sh add <name>${NC}"
  fi
}

check_creds_exist() {
  if [ ! -f "$CREDS" ]; then
    echo -e "${RED}Error:${NC} No credentials file found at $CREDS"
    echo "Run 'claude auth login' first."
    exit 1
  fi
}

cmd_list() {
  echo -e "${BOLD}Current:${NC} $(current)"
  echo "Accounts:"
  list_accounts
}

cmd_swap() {
  local target="$1"
  if [ ! -f "$ACCT_DIR/creds-$target.json" ]; then
    echo -e "${RED}Account '$target' not found.${NC}"
    echo ""
    echo "Available accounts:"
    list_accounts
    exit 1
  fi

  cp "$ACCT_DIR/creds-$target.json" "$CREDS"
  echo "$target" > "$CURRENT_FILE"
  echo -e "${GREEN}Switched to ${BOLD}$target${NC}"
  echo -e "${DIM}Start a new Claude Code session for the change to take effect.${NC}"
}

cmd_add() {
  local name="$1"
  check_creds_exist
  mkdir -p "$ACCT_DIR"

  if [ -f "$ACCT_DIR/creds-$name.json" ]; then
    echo -e "${YELLOW}Account '$name' already exists.${NC} Overwrite? (y/N)"
    read -r confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
      echo "Aborted."
      exit 0
    fi
  fi

  cp "$CREDS" "$ACCT_DIR/creds-$name.json"
  chmod 600 "$ACCT_DIR/creds-$name.json"
  echo "$name" > "$CURRENT_FILE"
  echo -e "${GREEN}Saved current credentials as ${BOLD}$name${NC}"
}

cmd_remove() {
  local name="$1"
  if [ ! -f "$ACCT_DIR/creds-$name.json" ]; then
    echo -e "${RED}Account '$name' not found.${NC}"
    exit 1
  fi

  if [ "$name" = "$(current)" ]; then
    echo -e "${YELLOW}Warning:${NC} '$name' is the active account."
    echo "Remove anyway? (y/N)"
    read -r confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
      echo "Aborted."
      exit 0
    fi
    echo "unknown" > "$CURRENT_FILE"
  fi

  rm "$ACCT_DIR/creds-$name.json"
  echo -e "Removed ${BOLD}$name${NC}"
}

cmd_status() {
  check_creds_exist
  echo -e "${BOLD}Active account:${NC} $(current)"
  echo ""

  # Try to extract email from credentials using claude auth status
  if command -v claude &>/dev/null; then
    # Temporarily unset CLAUDECODE to avoid nested session error
    CLAUDECODE= claude auth status 2>/dev/null | grep -E "email|orgId|subscriptionType" || true
  fi

  echo ""
  echo "Accounts:"
  list_accounts
}

cmd_help() {
  cat <<'EOF'
claude-code-swap: Rotate between Claude Code accounts

Usage:
  swap.sh                  Show current account and list all
  swap.sh <name>           Switch to named account
  swap.sh add <name>       Save current login as a named account
  swap.sh remove <name>    Remove a saved account
  swap.sh status           Show current account with auth details
  swap.sh help             Show this help

Setup:
  1. Log in:    claude auth login
  2. Save it:   swap.sh add my-account
  3. Repeat for each account
  4. Swap:      swap.sh my-account

Notes:
  - Swap BEFORE starting a Claude Code session (tokens load at startup)
  - Credentials stored in ~/.claude/accounts/ with 600 permissions
  - Override storage dir with CLAUDE_SWAP_DIR env var
  - Weekly limits reset Saturday 10:00 AM (check claude.ai/settings)
EOF
}

# --- Main ---

mkdir -p "$ACCT_DIR"

case "${1:-}" in
  ""|list)    cmd_list ;;
  add)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} swap.sh add <name>"; exit 1; }
    cmd_add "$2" ;;
  remove|rm)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} swap.sh remove <name>"; exit 1; }
    cmd_remove "$2" ;;
  status)     cmd_status ;;
  help|--help|-h)  cmd_help ;;
  *)          cmd_swap "$1" ;;
esac
