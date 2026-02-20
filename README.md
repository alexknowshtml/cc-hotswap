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

## Cookie Refresh

Session cookies expire every ~10-30 minutes, so manual entry gets tedious fast. This repo includes two scripts that automate cookie refresh using Playwright:

- **`cookie-daemon.cjs`** — Persistent daemon that keeps one Chromium instance running and refreshes all accounts every 10 minutes
- **`refresh-cookies.cjs`** — One-shot tool for initializing accounts (`--init`) and manual refresh

### How it works

The daemon launches a single headless Chromium instance with [playwright-extra](https://github.com/nickreese/playwright-extra) and [stealth](https://github.com/nickreese/puppeteer-extra-plugin-stealth) to avoid bot detection. It creates a separate browser context per account, each with its own session state. Every 10 minutes it navigates each context to claude.ai, extracts the refreshed `sessionKey` cookie, and verifies it against the API.

One Chromium process stays warm — much lighter than launching and killing a browser on every refresh cycle.

### Setup

```bash
# Install dependencies in the daemon directory
mkdir -p ~/.claude/accounts/cc-hotswap-cookies
cd ~/.claude/accounts/cc-hotswap-cookies
npm init -y
npm install playwright playwright-extra puppeteer-extra-plugin-stealth

# Copy the scripts
cp /path/to/cc-hotswap/cookie-daemon.cjs .
cp /path/to/cc-hotswap/refresh-cookies.cjs .

# Install Playwright browsers (if not already installed)
npx playwright install chromium

# Initialize each account (opens a visible browser for manual login)
node refresh-cookies.cjs --init work-account
# Log in, script auto-detects completion and saves state

node refresh-cookies.cjs --init personal-account
```

### Running the daemon

**Linux (systemd):**

```ini
# ~/.config/systemd/user/cc-hotswap-cookies.service
[Unit]
Description=cc-hotswap cookie refresh daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.claude/accounts/cc-hotswap-cookies
ExecStart=/usr/bin/node cookie-daemon.cjs
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now cc-hotswap-cookies.service
```

**macOS (launchd):** Create a plist in `~/Library/LaunchAgents/` with `KeepAlive: true`.

**Any platform:** `pm2 start cookie-daemon.cjs --name cc-hotswap`

### One-shot refresh

If you don't want to run a persistent daemon, use the one-shot refresh:

```bash
cc-hotswap refresh
```

This launches Chromium, refreshes all sessions, and exits. You can cron this every 15-20 minutes, though the daemon approach is lighter.

### Re-initializing expired sessions

If the daemon logs "Session expired — needs re-init" (e.g. after a long downtime), re-run init for that account:

```bash
cd ~/.claude/accounts/cc-hotswap-cookies
node refresh-cookies.cjs --init work-account
```

A browser window opens. Log in, and the script auto-detects completion and saves the state. No Ctrl+C needed.

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
