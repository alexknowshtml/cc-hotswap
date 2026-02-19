#!/bin/bash
#
# cc-hotswap: Hotswap between Claude Code Max plan accounts
# https://github.com/alexknowshtml/cc-hotswap
#
# Usage:
#   swap.sh                        Show current account and list all
#   swap.sh <name>                 Switch to named account
#   swap.sh add <name>             Save current login as a named account
#   swap.sh remove <name>          Remove a saved account
#   swap.sh status                 Show current account details
#   swap.sh usage                  Check real usage for all accounts
#   swap.sh set-cookie <name> <key>  Save session cookie for usage checking
#   swap.sh discover-org <name>    Auto-discover org UUID from session cookie

set -euo pipefail

ACCT_DIR="${CLAUDE_SWAP_DIR:-$HOME/.claude/accounts}"
CREDS="$HOME/.claude/.credentials.json"
CURRENT_FILE="$ACCT_DIR/.current"

# Colors (disable with NO_COLOR=1)
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  DIM='\033[0;90m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' CYAN='' DIM='' BOLD='' NC=''
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
    echo -e "  ${DIM}No accounts saved. Run: cc-hotswap add <name>${NC}"
  fi
}

check_creds_exist() {
  if [ ! -f "$CREDS" ]; then
    echo -e "${RED}Error:${NC} No credentials file found at $CREDS"
    echo "Run 'claude auth login' first."
    exit 1
  fi
}

usage_bar() {
  local pct=$1
  local width=20
  local filled=$(( pct * width / 100 ))
  local empty=$(( width - filled ))
  local color="$GREEN"
  if [ "$pct" -ge 80 ]; then
    color="$RED"
  elif [ "$pct" -ge 50 ]; then
    color="$YELLOW"
  fi
  printf "${color}"
  printf '%.0s█' $(seq 1 $filled 2>/dev/null) || true
  printf "${DIM}"
  printf '%.0s░' $(seq 1 $empty 2>/dev/null) || true
  printf "${NC} %3d%%" "$pct"
}

fetch_usage() {
  local name=$1
  local session_file="$ACCT_DIR/session-$name.key"
  local org_file="$ACCT_DIR/org-$name.uuid"

  if [ ! -f "$session_file" ]; then
    echo -e "  ${DIM}No session cookie. Run: cc-hotswap set-cookie $name <key>${NC}"
    return 1
  fi
  if [ ! -f "$org_file" ]; then
    echo -e "  ${DIM}No org UUID. Run: cc-hotswap discover-org $name${NC}"
    return 1
  fi

  local session_key
  session_key=$(cat "$session_file")
  local org_uuid
  org_uuid=$(cat "$org_file")

  local response
  response=$(curl -s "https://claude.ai/api/organizations/$org_uuid/usage" \
    -H 'accept: application/json' \
    -H "cookie: sessionKey=$session_key" \
    -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' \
    -H 'sec-ch-ua: "Chromium";v="133"' \
    -H 'sec-fetch-dest: empty' \
    -H 'sec-fetch-mode: cors' \
    -H 'sec-fetch-site: same-origin' \
    -H 'referer: https://claude.ai/settings' 2>/dev/null)

  # Check for Cloudflare challenge or error
  if echo "$response" | grep -q 'Just a moment' 2>/dev/null; then
    echo -e "  ${RED}Cloudflare blocked — session cookie expired${NC}"
    echo -e "  ${DIM}Run: cc-hotswap set-cookie $name <new-key>${NC}"
    return 1
  fi

  if echo "$response" | grep -q '"error"' 2>/dev/null; then
    local err_msg
    err_msg=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','unknown'))" 2>/dev/null || echo "unknown")
    echo -e "  ${RED}$err_msg${NC}"
    echo -e "  ${DIM}Run: cc-hotswap set-cookie $name <new-key>${NC}"
    return 1
  fi

  # Parse usage
  local parsed
  parsed=$(echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
weekly = d.get('seven_day', {})
session = d.get('five_hour', {})
sonnet = d.get('seven_day_sonnet', {})
print(f\"{int(weekly.get('utilization', 0))}|{int(session.get('utilization', 0))}|{int(sonnet.get('utilization', 0))}|{weekly.get('resets_at', 'unknown')}\")
" 2>/dev/null)

  if [ -z "$parsed" ]; then
    echo -e "  ${RED}Failed to parse usage response${NC}"
    return 1
  fi

  IFS='|' read -r weekly_pct session_pct sonnet_pct resets_at <<< "$parsed"

  echo -e "  Weekly:  $(usage_bar "$weekly_pct")"
  echo -e "  Session: $(usage_bar "$session_pct")"
  echo -e "  Sonnet:  $(usage_bar "$sonnet_pct")"

  if [ "$resets_at" != "unknown" ] && [ "$resets_at" != "null" ] && [ -n "$resets_at" ]; then
    local reset_display
    reset_display=$(python3 -c "
from datetime import datetime, timezone
try:
    dt = datetime.fromisoformat('$resets_at')
    now = datetime.now(timezone.utc)
    delta = dt - now
    hours = int(delta.total_seconds() / 3600)
    days = hours // 24
    remaining_hours = hours % 24
    if days > 0:
        print(f'{days}d {remaining_hours}h')
    else:
        print(f'{hours}h')
except:
    print('unknown')
" 2>/dev/null)
    echo -e "  ${DIM}Resets in: $reset_display${NC}"
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
  # Clean up associated files
  rm -f "$ACCT_DIR/session-$name.key" "$ACCT_DIR/org-$name.uuid"
  echo -e "Removed ${BOLD}$name${NC}"
}

cmd_status() {
  check_creds_exist
  echo -e "${BOLD}Active account:${NC} $(current)"
  echo ""

  # Try to extract email from credentials using claude auth status
  if command -v claude &>/dev/null; then
    CLAUDECODE= claude auth status 2>/dev/null | grep -E "email|orgId|subscriptionType" || true
  fi

  echo ""
  echo "Accounts:"
  list_accounts
}

cmd_usage() {
  echo -e "${BOLD}Account Usage${NC}"
  echo ""
  for f in "$ACCT_DIR"/creds-*.json; do
    [ -f "$f" ] || continue
    name=$(basename "$f" | sed 's/^creds-//;s/\.json$//')
    local marker=""
    if [ "$name" = "$(current)" ]; then
      marker=" ${GREEN}(active)${NC}"
    fi
    echo -e "${BOLD}$name${NC}$marker"
    fetch_usage "$name" || true
    echo ""
  done
}

cmd_set_cookie() {
  local name=$1
  local key=$2
  echo -n "$key" > "$ACCT_DIR/session-$name.key"
  chmod 600 "$ACCT_DIR/session-$name.key"
  echo -e "${GREEN}Session cookie saved for ${BOLD}$name${NC}"

  # Auto-discover org UUID if not set
  if [ ! -f "$ACCT_DIR/org-$name.uuid" ]; then
    echo -e "${DIM}Discovering org UUID...${NC}"
    cmd_discover_org "$name"
  fi
}

cmd_discover_org() {
  local name=$1
  local session_file="$ACCT_DIR/session-$name.key"

  if [ ! -f "$session_file" ]; then
    echo -e "${RED}No session cookie for $name${NC}"
    return 1
  fi

  local session_key
  session_key=$(cat "$session_file")
  local response
  response=$(curl -s 'https://claude.ai/api/organizations' \
    -H 'accept: application/json' \
    -H "cookie: sessionKey=$session_key" \
    -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' \
    -H 'sec-ch-ua: "Chromium";v="133"' \
    -H 'sec-fetch-dest: empty' \
    -H 'sec-fetch-mode: cors' \
    -H 'sec-fetch-site: same-origin' 2>/dev/null)

  local org_uuid
  org_uuid=$(echo "$response" | python3 -c "
import sys, json
orgs = json.load(sys.stdin)
# Find the org with claude_max capability
for org in orgs:
    if 'claude_max' in org.get('capabilities', []):
        print(org['uuid'])
        break
else:
    # Fall back to first org
    if orgs:
        print(orgs[0]['uuid'])
" 2>/dev/null)

  if [ -n "$org_uuid" ]; then
    echo -n "$org_uuid" > "$ACCT_DIR/org-$name.uuid"
    echo -e "${GREEN}Org UUID saved: ${DIM}$org_uuid${NC}"
  else
    echo -e "${RED}Could not discover org UUID — session cookie may be expired${NC}"
    return 1
  fi
}

cmd_help() {
  cat <<'EOF'
cc-hotswap: Hotswap between Claude Code accounts

Usage:
  cc-hotswap                        Show current account and list all
  cc-hotswap <name>                 Switch to named account
  cc-hotswap add <name>             Save current login as a named account
  cc-hotswap remove <name>          Remove a saved account
  cc-hotswap status                 Show current account with auth details
  cc-hotswap usage                  Check real usage for all accounts
  cc-hotswap set-cookie <name> <key>  Save session cookie for usage checking
  cc-hotswap discover-org <name>    Auto-discover org UUID from session cookie
  cc-hotswap help                   Show this help

Setup:
  1. Log in:    claude auth login
  2. Save it:   cc-hotswap add my-account
  3. Repeat for each account
  4. Swap:      cc-hotswap my-account

Usage Checking Setup:
  1. Open claude.ai in browser → DevTools → Application → Cookies
  2. Copy the 'sessionKey' value
  3. Run: cc-hotswap set-cookie my-account <session-key>
  4. Run: cc-hotswap usage

Notes:
  - Swap BEFORE starting a Claude Code session (tokens load at startup)
  - Credentials stored in ~/.claude/accounts/ with 600 permissions
  - Session cookies expire after ~10-30 minutes
  - Override storage dir with CLAUDE_SWAP_DIR env var
  - Weekly limits reset on a rolling 7-day cycle
EOF
}

# --- Main ---

mkdir -p "$ACCT_DIR"

case "${1:-}" in
  ""|list)    cmd_list ;;
  add)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} cc-hotswap add <name>"; exit 1; }
    cmd_add "$2" ;;
  remove|rm)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} cc-hotswap remove <name>"; exit 1; }
    cmd_remove "$2" ;;
  status)     cmd_status ;;
  usage)      cmd_usage ;;
  set-cookie)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} cc-hotswap set-cookie <name> <session-key>"; exit 1; }
    [ -z "${3:-}" ] && { echo -e "${RED}Usage:${NC} cc-hotswap set-cookie <name> <session-key>"; exit 1; }
    cmd_set_cookie "$2" "$3" ;;
  discover-org)
    [ -z "${2:-}" ] && { echo -e "${RED}Usage:${NC} cc-hotswap discover-org <name>"; exit 1; }
    cmd_discover_org "$2" ;;
  help|--help|-h)  cmd_help ;;
  *)          cmd_swap "$1" ;;
esac
