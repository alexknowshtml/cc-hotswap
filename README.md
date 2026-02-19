# cc-hotswap

Easily swap between multiple [Claude Code](https://claude.ai/code) Max plan accounts from the command line.

When you hit your weekly usage limit, one command switches to another account so you can keep working.

## Why?

Claude Code Max plans have weekly usage limits that reset on a rolling 7-day cycle. Heavy users (especially on Opus) can hit these limits days early. If you have multiple accounts, this tool makes swapping between them trivial — one command instead of a logout/login dance.

It also ships as a [Claude Code skill](#claude-code-skill), so you can ask Claude to swap accounts for you without leaving your session.

## Install

```bash
# Clone the repo
git clone https://github.com/alexknowshtml/cc-hotswap.git

# Add to your PATH (pick one)
ln -s "$(pwd)/cc-hotswap/swap.sh" ~/.local/bin/cc-hotswap
# or
alias cc-hotswap='/path/to/cc-hotswap/swap.sh'
```

## Setup

Save each account you want to rotate between:

```bash
# Log into your first account
claude auth login
cc-hotswap add work-account

# Log into your second account
claude auth logout
claude auth login
cc-hotswap add personal-account

# Switch back to your primary
cc-hotswap work-account
```

## Usage

```bash
# See which account is active
cc-hotswap

# Switch to another account
cc-hotswap personal-account

# See account details
cc-hotswap status

# List all commands
cc-hotswap help
```

Output:

```
Current: work-account
Accounts:
  * work-account (active)
    personal-account
```

## How it works

Claude Code on Linux stores OAuth credentials in `~/.claude/.credentials.json`. This tool saves named snapshots of that file and copies them back when you want to switch.

That's it. One shell script, no dependencies.

### Limitations

- **Swap before starting a session.** Claude Code reads credentials at startup. Swapping mid-session won't take effect until you start a new one.
- **No usage tracking.** Anthropic doesn't expose Max plan usage programmatically ([#19385](https://github.com/anthropics/claude-code/issues/19385), [#24459](https://github.com/anthropics/claude-code/issues/24459)). The only way to check your actual weekly usage % is at [claude.ai/settings](https://claude.ai/settings) → Usage.
- **Linux only.** On macOS, Claude Code stores credentials in the system Keychain, not a flat file. This tool won't work there without modification.

## When to swap

You'll know it's time to swap when Claude Code starts showing usage warnings or throttling your requests. Check your usage at [claude.ai/settings](https://claude.ai/settings) → Usage to see your current % and reset time.

Some context on Max plan tiers:
- **Max 5x** ($100/mo): Auto-switches Opus → Sonnet at 20% weekly usage
- **Max 20x** ($200/mo): Auto-switches Opus → Sonnet at 50% weekly usage

A common pattern: start each cycle on your bigger plan, and switch to the backup when it runs low.

## Claude Code Skill

cc-hotswap includes a `SKILL.md` file that works as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills). When loaded, it gives Claude Code the context to run swap commands on your behalf.

To use it, symlink the repo into your skills directory:

```bash
ln -s /path/to/cc-hotswap ~/.claude/skills/cc-hotswap
```

Then invoke it in Claude Code with `/cc-hotswap`.

## File layout

```
~/.claude/accounts/
  .current                    # Name of active account
  creds-work-account.json     # Saved credentials
  creds-personal-account.json
```

Credential files are stored with `600` permissions (owner read/write only). Override the storage directory with `CLAUDE_SWAP_DIR`.

## License

MIT
