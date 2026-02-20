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

# Check real usage for all accounts
cc-hotswap usage

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

### Usage checking

Check real usage percentages from Anthropic's API — the same numbers shown in claude.ai/settings:

```bash
# One-time: save a session cookie from your browser
# (DevTools → Application → Cookies → sessionKey)
cc-hotswap set-cookie work-account sk-ant-sid02-...

# Check usage across all accounts
cc-hotswap usage
```

Output:

```
Account Usage

work-account (active)
  Weekly:  ████████████████░░░░  82%
  Session: ██░░░░░░░░░░░░░░░░░░   9%
  Sonnet:  ███░░░░░░░░░░░░░░░░░  18%
  Resets in: 2d 3h

personal-account
  Weekly:  █░░░░░░░░░░░░░░░░░░░   0%
  Session: █░░░░░░░░░░░░░░░░░░░   0%
  Sonnet:  █░░░░░░░░░░░░░░░░░░░   0%
  Resets in: 6d 3h
```

Session cookies expire after ~10-30 minutes. For persistent usage checking, automate cookie refresh with a headless browser (Playwright/Puppeteer) — see [Cookie Refresh](#cookie-refresh) below.

## How it works

Claude Code on Linux stores OAuth credentials in `~/.claude/.credentials.json`. This tool saves named snapshots of that file and copies them back when you want to switch.

Usage checking works by hitting `claude.ai/api/organizations/{orgId}/usage` with browser-like headers and a session cookie. The `set-cookie` command auto-discovers your org UUID.

### Limitations

- **Swap before starting a session.** Claude Code reads credentials at startup. Swapping mid-session won't take effect until you start a new one.
- **Session cookies expire quickly.** The `usage` command needs a valid session cookie from claude.ai. These expire after ~10-30 minutes. You'll need to refresh them from your browser or automate it.
- **Linux only.** On macOS, Claude Code stores credentials in the system Keychain, not a flat file. This tool won't work there without modification.

## When to swap

Run `cc-hotswap usage` to see your current utilization across accounts. Swap when your primary account gets high.

You'll also know it's time when Claude Code starts showing usage warnings or throttling your requests.

Some context on Max plan tiers:
- **Max 5x** ($100/mo): Auto-switches Opus → Sonnet at 20% weekly usage
- **Max 20x** ($200/mo): Auto-switches Opus → Sonnet at 50% weekly usage

A common pattern: start each cycle on your bigger plan, and switch to the backup when it runs low.

## Cookie Refresh

Session cookies expire every ~10-30 minutes, so manual entry gets tedious fast. The solution: a persistent headless Playwright daemon that keeps sessions alive automatically.

### How it works

A Node.js daemon runs on an always-on machine (e.g. a Mac Mini). It:

1. Launches a single headless Chromium instance with [playwright-extra](https://github.com/nickreese/playwright-extra) and [stealth](https://github.com/nickreese/puppeteer-extra-plugin-stealth) to avoid bot detection
2. Creates a separate browser context per account, each with its own session state
3. Every 10 minutes, navigates each context to `claude.ai/settings`, extracts the refreshed `sessionKey` cookie, and verifies it against the API
4. Saves cookies to `session-{name}.key` files that `swap.sh usage` can pull over SSH

This is much lighter than launching and killing a browser every 10 minutes. One Chromium process stays warm, and launchd restarts it if it crashes.

### Setup

**Prerequisites:** Node.js, Playwright, and a machine that stays on.

```bash
# On the always-on machine
mkdir ~/cc-hotswap-cookies
npm install playwright-extra puppeteer-extra-plugin-stealth

# Initialize each account (opens a visible browser for manual login)
node cookie-daemon.cjs --init work-account
# Log in, script auto-detects completion and saves state

node cookie-daemon.cjs --init personal-account
```

**Run as a daemon:**

On macOS, create a launchd plist with `KeepAlive: true`. On Linux, use a systemd unit or pm2.

**Pull cookies remotely:**

`swap.sh usage` can auto-pull fresh cookies from your daemon machine via SSH before checking usage. Set `MAC_MINI_IP` and `MAC_MINI_COOKIE_DIR` in the script to enable this.

### Re-initializing expired sessions

If the daemon reports a session expired (e.g. after a machine reboot or long downtime), re-run `--init` for that account. The browser opens, you log in once, and the daemon takes over again.

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
  session-work-account.key    # Session cookie (for usage checking)
  org-work-account.uuid       # Org UUID (auto-discovered)
```

Credential and session files are stored with `600` permissions (owner read/write only). Override the storage directory with `CLAUDE_SWAP_DIR`.

## License

MIT
