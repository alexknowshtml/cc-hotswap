---
name: cc-hotswap
description: Manage Claude Code Max plan account rotation. Hotswap between accounts, check which is active, and view usage estimates. Use when user mentions account swapping, usage limits, or running out of Claude tokens.
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

### Add a new account (saves current login)
```bash
~/.claude/accounts/swap.sh add <account-name>
```

### Remove an account
```bash
~/.claude/accounts/swap.sh remove <account-name>
```

### Show account details
```bash
~/.claude/accounts/swap.sh status
```

## Rotation Strategy

1. **Start each week on your biggest plan** (most usage headroom)
2. Weekly limits reset **Saturday 10:00 AM ET**
3. When usage warnings appear or you feel throttling, hotswap to backup account
4. Saturday morning, swap back to primary

## Important Notes

- **Swap before launching a session**, not during one. Tokens are read at startup.
- Local tools (ccusage, claude-monitor) estimate from session logs - they don't match Anthropic's actual usage dashboard. The only source of truth is `claude.ai/settings -> Usage`.
- The `anthropic-ratelimit-unified-*` response headers contain real usage %, but Claude Code doesn't persist them. GitHub issues [#19385](https://github.com/anthropics/claude-code/issues/19385) and [#24459](https://github.com/anthropics/claude-code/issues/24459) request this feature.
- Max 20x auto-switches from Opus -> Sonnet at 50% weekly usage. Max 5x switches at 20%.
- **Linux only.** On macOS, Claude Code stores credentials in the system Keychain, not a flat file.

## Key Files

- **Swap script:** `~/.claude/accounts/swap.sh`
- **Credentials:** `~/.claude/accounts/creds-{name}.json`
- **Active account tracker:** `~/.claude/accounts/.current`
- **Live credentials:** `~/.claude/.credentials.json`

## Credential Security

- Credential files contain OAuth access + refresh tokens
- Files are stored with user-only permissions (`chmod 600`)
- Tokens auto-refresh via the refresh token; if an account sits unused too long, you may need to `claude auth login` again
