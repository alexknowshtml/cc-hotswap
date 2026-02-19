# cc-hotswap

Hotswap between multiple [Claude Code](https://claude.ai/code) Max plan accounts from the command line.

If you burn through your weekly usage limit before it resets, hotswap to another account and keep working.

## Why?

Claude Code Max plans have weekly usage limits that reset every Saturday at 10:00 AM. Heavy users (especially on Opus) can hit these limits days early. If you have multiple accounts, this tool lets you hotswap between them with one command.

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

# Hotswap to another account
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

Claude Code on Linux stores OAuth credentials in `~/.claude/.credentials.json`. This tool copies named credential snapshots in and out of that file.

That's it. No daemon, no wrapper, no dependencies.

### Limitations

- **Swap before starting a session.** Claude Code reads credentials at startup. Swapping mid-session won't take effect until you start a new one.
- **No usage tracking.** Anthropic doesn't expose Max plan usage programmatically ([#19385](https://github.com/anthropics/claude-code/issues/19385), [#24459](https://github.com/anthropics/claude-code/issues/24459)). The only way to check your actual weekly usage is at [claude.ai/settings](https://claude.ai/settings) → Usage.
- **Linux only.** On macOS, Claude Code stores credentials in the system Keychain, not a flat file. This tool won't work there without modification.

## When to swap

Max plans have two tiers:
- **Max 5x** ($100/mo): Auto-switches Opus → Sonnet at 20% weekly usage
- **Max 20x** ($200/mo): Auto-switches Opus → Sonnet at 50% weekly usage

Start each week on your bigger plan. When you feel throttling or see usage warnings, hotswap to the backup. Saturday at 10 AM, swap back.

## Claude Code Skill

cc-hotswap includes a `SKILL.md` file that works as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills). When loaded, it gives Claude Code the context to run swap commands on your behalf.

To use it, add the repo to your project's `.claude/skills/` directory or symlink it:

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
