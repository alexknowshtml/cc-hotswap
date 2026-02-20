---
name: cc-hotswap
description: Manage Claude Code Max plan account rotation. Hotswap between accounts, check real usage data, and decide when to swap. Use when user mentions account swapping, usage limits, or running out of Claude tokens.
---

# cc-hotswap

Hotswap between multiple Claude Code Max plan accounts to extend weekly usage limits.

## Commands

### Check current account
```bash
~/.claude/accounts/swap.sh
```

### Hotswap to a specific account
```bash
~/.claude/accounts/swap.sh <account-name>
```

### Check real usage (all accounts)
```bash
~/.claude/accounts/swap.sh usage
```
Shows weekly, session, and Sonnet usage percentages with visual bars. Requires valid session cookies.

### Run one-shot cookie refresh
```bash
~/.claude/accounts/swap.sh refresh
```
Runs the Playwright refresh script to grab fresh session cookies. The persistent daemon handles this automatically, so `refresh` is only needed for manual one-off refreshes.

### Save a session cookie for usage checking
```bash
~/.claude/accounts/swap.sh set-cookie <account-name> <session-key>
```
Manual fallback — paste a session key from browser DevTools. Not normally needed when the daemon is running.

### Add a new account (saves current login)
```bash
~/.claude/accounts/swap.sh add <account-name>
```

### Remove an account
```bash
~/.claude/accounts/swap.sh remove <account-name>
```

## Rotation Strategy

1. **Start each cycle on your biggest plan** (most usage headroom)
2. Run `swap.sh usage` to check utilization across accounts
3. When your primary gets high, hotswap to backup account
4. When primary resets, swap back

## Important Notes

- **Swap before launching a session**, not during one. Tokens are read at startup.
- The `usage` command shows real Anthropic data (same as claude.ai/settings)
- Session cookies expire after ~10-30 minutes — the cookie daemon handles this automatically
- Max 20x auto-switches Opus → Sonnet at 50% weekly usage. Max 5x at 20%.
- **Linux only.** On macOS, Claude Code stores credentials in the system Keychain, not a flat file.

## Key Files

- **Swap script:** `~/.claude/accounts/swap.sh`
- **Credentials:** `~/.claude/accounts/creds-{name}.json`
- **Session cookies:** `~/.claude/accounts/session-{name}.key`
- **Org UUIDs:** `~/.claude/accounts/org-{name}.uuid`
- **Active account tracker:** `~/.claude/accounts/.current`
- **Live credentials:** `~/.claude/.credentials.json`
