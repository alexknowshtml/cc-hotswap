#!/usr/bin/env bun
/**
 * cc-hotswap v2: TypeScript CLI for switching between Claude Code accounts
 * Uses CLAUDE_CONFIG_DIR isolation instead of file overwriting.
 *
 * https://github.com/alexknowshtml/cc-hotswap
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, chmodSync, symlinkSync, lstatSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? "/root";
const ACCT_DIR = join(HOME, ".claude", "accounts");
const INSTANCES_DIR = join(ACCT_DIR, "instances");
const SESSION_COOKIES_DIR = join(ACCT_DIR, "session-cookies");
const ORG_UUIDS_DIR = join(ACCT_DIR, "org-uuids");
const CONFIG_FILE = join(ACCT_DIR, "config.json");
const ACTIVE_ENV_FILE = join(ACCT_DIR, "active.env");
const DEFAULT_CREDS_FILE = join(HOME, ".claude", ".credentials.json");

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;

const c = {
  green:  (s: string) => NO_COLOR ? s : `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s: string) => NO_COLOR ? s : `\x1b[0;33m${s}\x1b[0m`,
  red:    (s: string) => NO_COLOR ? s : `\x1b[0;31m${s}\x1b[0m`,
  cyan:   (s: string) => NO_COLOR ? s : `\x1b[0;36m${s}\x1b[0m`,
  dim:    (s: string) => NO_COLOR ? s : `\x1b[0;90m${s}\x1b[0m`,
  bold:   (s: string) => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountMeta {
  email?: string;
  plan?: string;
  instanceDir: string;
  created: string;
  lastUsed?: string | null;
  lastValidated?: string | null;
}

interface Registry {
  version: number;
  active: string | null;
  accounts: Record<string, AccountMeta>;
}

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  for (const dir of [ACCT_DIR, INSTANCES_DIR, SESSION_COOKIES_DIR, ORG_UUIDS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// Items in ~/.claude/ that should be shared across all accounts via symlinks.
// Only .credentials.json and .claude.json remain per-account.
const SHARED_ITEMS = [
  "settings.json", "CLAUDE.md", "hooks", "commands", "data", "config",
  "projects", "file-history", "history.jsonl", "ide", "mcp-needs-auth-cache.json",
  "paste-cache", "plans", "plugins", "session-env", "agents", "project-config.json",
];

/**
 * Create symlinks in an instance directory pointing back to shared ~/.claude/ items.
 * Skips items that already exist (symlink or real file) in the instance dir.
 */
function setupInstanceSymlinks(instDir: string): void {
  const claudeDir = join(HOME, ".claude");
  let linked = 0;

  for (const item of SHARED_ITEMS) {
    const target = join(claudeDir, item);
    const link = join(instDir, item);

    // Skip if source doesn't exist in ~/.claude/
    if (!existsSync(target)) continue;

    // Skip if already exists in instance dir (don't overwrite)
    if (existsSync(link)) {
      // But if it's not a symlink, warn about it
      try {
        const stat = lstatSync(link);
        if (!stat.isSymbolicLink()) {
          console.log(c.dim(`  ${item}: exists (not a symlink, skipping)`));
        }
      } catch { /* ignore */ }
      continue;
    }

    try {
      symlinkSync(target, link);
      linked++;
    } catch (err: any) {
      console.log(c.yellow(`  Warning: could not symlink ${item}: ${err.message}`));
    }
  }

  if (linked > 0) {
    console.log(c.dim(`  Linked ${linked} shared config items from ~/.claude/`));
  }
}

function readRegistry(): Registry {
  if (!existsSync(CONFIG_FILE)) {
    return { version: 2, active: null, accounts: {} };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { version: 2, active: null, accounts: {} };
  }
}

function writeRegistry(reg: Registry): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

function instanceDir(name: string): string {
  return join(INSTANCES_DIR, name);
}

function credentialsPath(name: string): string {
  return join(instanceDir(name), ".credentials.json");
}

function sessionCookiePath(name: string): string {
  return join(SESSION_COOKIES_DIR, `${name}.key`);
}

function orgUuidPath(name: string): string {
  return join(ORG_UUIDS_DIR, `${name}.uuid`);
}

function readCredentials(name: string): Credentials | null {
  const p = credentialsPath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage bar
// ---------------------------------------------------------------------------

function usageBar(pct: number, width = 20): string {
  const filled = Math.round((pct * width) / 100);
  const empty = width - filled;
  let color: (s: string) => string;
  if (pct >= 80) color = c.red;
  else if (pct >= 50) color = c.yellow;
  else color = c.green;

  const bar = color("█".repeat(filled)) + c.dim("░".repeat(empty));
  const label = String(pct).padStart(3) + "%";
  return `${bar} ${label}`;
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

interface UsageData {
  weekly: number;
  session: number;
  sonnet: number;
  resetsAt: string | null;
}

async function fetchUsage(name: string): Promise<UsageData | null> {
  const cookiePath = sessionCookiePath(name);
  const uuidPath = orgUuidPath(name);

  if (!existsSync(cookiePath)) {
    console.log(`  ${c.dim(`No session cookie — run: cc-hotswap set-cookie ${name} <key>`)}`);
    return null;
  }
  if (!existsSync(uuidPath)) {
    console.log(`  ${c.dim(`No org UUID — run: cc-hotswap discover-org ${name}`)}`);
    return null;
  }

  const sessionKey = readFileSync(cookiePath, "utf8").trim();
  const orgUuid = readFileSync(uuidPath, "utf8").trim();

  const headers: Record<string, string> = {
    accept: "application/json",
    cookie: `sessionKey=${sessionKey}`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="133"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    referer: "https://claude.ai/settings",
  };

  let response: Response;
  try {
    response = await fetch(`https://claude.ai/api/organizations/${orgUuid}/usage`, { headers });
  } catch (e: any) {
    console.log(`  ${c.red("Network error:")} ${e.message}`);
    return null;
  }

  const text = await response.text();

  if (text.includes("Just a moment")) {
    console.log(`  ${c.red("Cloudflare blocked — session cookie expired")}`);
    console.log(`  ${c.dim(`Run: cc-hotswap set-cookie ${name} <new-key>`)}`);
    return null;
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`  ${c.red("Failed to parse response")}`);
    return null;
  }

  if (data?.error) {
    console.log(`  ${c.red(data.error?.message ?? "API error")}`);
    console.log(`  ${c.dim(`Run: cc-hotswap set-cookie ${name} <new-key>`)}`);
    return null;
  }

  const weekly = Math.round(data?.seven_day?.utilization ?? 0);
  const session = Math.round(data?.five_hour?.utilization ?? 0);
  const sonnet = Math.round(data?.seven_day_sonnet?.utilization ?? 0);
  const resetsAt = data?.seven_day?.resets_at ?? null;

  return { weekly, session, sonnet, resetsAt };
}

function formatTimeRemaining(resetsAt: string): string {
  try {
    const dt = new Date(resetsAt);
    const now = new Date();
    const deltaMs = dt.getTime() - now.getTime();
    if (deltaMs <= 0) return "now";
    const totalHours = Math.floor(deltaMs / (1000 * 60 * 60));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0) return `${days}d ${hours}h`;
    return `${totalHours}h`;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Org discovery
// ---------------------------------------------------------------------------

async function discoverOrgUuid(name: string): Promise<string | null> {
  const cookiePath = sessionCookiePath(name);
  if (!existsSync(cookiePath)) {
    console.error(c.red(`No session cookie for ${name}`));
    return null;
  }

  const sessionKey = readFileSync(cookiePath, "utf8").trim();
  const headers: Record<string, string> = {
    accept: "application/json",
    cookie: `sessionKey=${sessionKey}`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="133"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  let response: Response;
  try {
    response = await fetch("https://claude.ai/api/organizations", { headers });
  } catch (e: any) {
    console.error(c.red(`Network error: ${e.message}`));
    return null;
  }

  let orgs: any[];
  try {
    const parsed = await response.json();
    orgs = parsed as any[];
  } catch {
    console.error(c.red("Failed to parse organizations response"));
    return null;
  }

  if (!Array.isArray(orgs)) {
    console.error(c.red("Unexpected response format"));
    return null;
  }

  // Prefer org with claude_max capability
  const maxOrg = orgs.find((org: any) =>
    (org.capabilities ?? []).includes("claude_max")
  );
  const org = maxOrg ?? orgs[0];
  return org?.uuid ?? null;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

interface TokenStatus {
  valid: boolean;
  source?: "access_token" | "expired";
  expiresAt?: number;
  error?: string;
}

function validateTokens(name: string): TokenStatus {
  const creds = readCredentials(name);
  if (!creds) {
    return { valid: false, error: "No credentials file found" };
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth) {
    return { valid: false, error: "No OAuth data in credentials" };
  }

  if (oauth.expiresAt && oauth.expiresAt > Date.now()) {
    return { valid: true, source: "access_token", expiresAt: oauth.expiresAt };
  }

  return {
    valid: false,
    source: "expired",
    expiresAt: oauth.expiresAt,
    error: "Access token expired — run `claude auth login` then `cc-hotswap add <name>`",
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(): void {
  const reg = readRegistry();
  const active = reg.active;

  console.log(`${c.bold("Current:")} ${active ? c.green(active) : c.dim("none")}`);
  console.log("Accounts:");

  const names = Object.keys(reg.accounts);
  if (names.length === 0) {
    console.log(`  ${c.dim("No accounts saved. Run: cc-hotswap add <name>")}`);
    return;
  }

  for (const name of names) {
    const meta = reg.accounts[name];
    const isActive = name === active;
    const marker = isActive ? c.green("*") : " ";
    const label = isActive ? c.bold(name) + " " + c.green("(active)") : name;
    const email = meta.email ? c.dim(` <${meta.email}>`) : "";
    console.log(`  ${marker} ${label}${email}`);
  }
}

function cmdSwap(name: string): void {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    console.error("");
    console.error("Available accounts:");
    for (const n of Object.keys(reg.accounts)) {
      console.error(`  ${n}`);
    }
    process.exit(1);
  }

  const instDir = instanceDir(name);
  const activeEnv = `export CLAUDE_CONFIG_DIR=${instDir}\n`;

  ensureDirs();
  writeFileSync(ACTIVE_ENV_FILE, activeEnv, { mode: 0o600 });

  reg.active = name;
  reg.accounts[name].lastUsed = new Date().toISOString();
  writeRegistry(reg);

  console.log(`${c.green("Switched to")} ${c.bold(name)}`);
  console.log(c.dim(`CLAUDE_CONFIG_DIR=${instDir}`));
  console.log("");
  console.log(c.dim("To apply in current shell, run:"));
  console.log(`  source ${ACTIVE_ENV_FILE}`);
  console.log(c.dim("Or add to ~/.zshrc / ~/.bashrc:"));
  console.log(`  ${c.dim(`[ -f ${ACTIVE_ENV_FILE} ] && source ${ACTIVE_ENV_FILE}`)}`);
}

async function cmdUsage(): Promise<void> {
  const reg = readRegistry();
  const names = Object.keys(reg.accounts);

  if (names.length === 0) {
    console.log(c.dim("No accounts saved. Run: cc-hotswap add <name>"));
    return;
  }

  console.log(c.bold("Account Usage"));
  console.log("");

  for (const name of names) {
    const isActive = name === reg.active;
    const marker = isActive ? " " + c.green("(active)") : "";
    console.log(`${c.bold(name)}${marker}`);

    const usage = await fetchUsage(name);
    if (usage) {
      console.log(`  Weekly:  ${usageBar(usage.weekly)}`);
      console.log(`  Session: ${usageBar(usage.session)}`);
      console.log(`  Sonnet:  ${usageBar(usage.sonnet)}`);
      if (usage.resetsAt) {
        const remaining = formatTimeRemaining(usage.resetsAt);
        console.log(`  ${c.dim(`Resets in: ${remaining}`)}`);
      }
    }
    console.log("");
  }
}

function cmdStatus(): void {
  const reg = readRegistry();
  const active = reg.active;

  console.log(`${c.bold("Active account:")} ${active ? c.green(active) : c.dim("none")}`);
  console.log("");

  if (active && reg.accounts[active]) {
    const meta = reg.accounts[active];
    const instDir = instanceDir(active);
    const creds = readCredentials(active);
    const oauth = creds?.claudeAiOauth;

    if (meta.email) console.log(`  Email:  ${meta.email}`);
    if (meta.plan)  console.log(`  Plan:   ${meta.plan}`);
    console.log(`  Dir:    ${instDir}`);

    if (oauth?.expiresAt) {
      const exp = new Date(oauth.expiresAt);
      const expired = oauth.expiresAt < Date.now();
      const label = expired ? c.red("EXPIRED") : c.green("valid");
      console.log(`  Token:  ${label} (expires ${exp.toLocaleString()})`);
    }
    if (meta.lastUsed) console.log(`  ${c.dim(`Last used: ${new Date(meta.lastUsed).toLocaleString()}`)}`);
    console.log("");
  }

  console.log("All accounts:");
  for (const [name, meta] of Object.entries(reg.accounts)) {
    const isActive = name === active;
    const marker = isActive ? c.green("*") : " ";
    const label = isActive ? c.bold(name) : name;
    const status = validateTokens(name);
    const tokenLabel = status.valid ? c.green("ok") : c.red("expired");
    const email = meta.email ? c.dim(` <${meta.email}>`) : "";
    console.log(`  ${marker} ${label}${email} [${tokenLabel}]`);
  }
}

function cmdAdd(name: string): void {
  if (!existsSync(DEFAULT_CREDS_FILE)) {
    console.error(c.red(`No credentials file found at ${DEFAULT_CREDS_FILE}`));
    console.error("Run 'claude auth login' first.");
    process.exit(1);
  }

  const reg = readRegistry();
  const instDir = instanceDir(name);

  if (existsSync(credentialsPath(name))) {
    console.log(c.yellow(`Account '${name}' already exists.`));
    process.stdout.write("Overwrite? (y/N): ");
    // Use synchronous read for interactive prompt
    const buf = Buffer.alloc(4096);
    const n = require("fs").readSync(process.stdin.fd, buf, 0, buf.length, null);
    const answer = buf.slice(0, n).toString().trim();
    if (answer !== "y" && answer !== "Y") {
      console.log("Aborted.");
      return;
    }
  }

  ensureDirs();
  mkdirSync(instDir, { recursive: true });
  copyFileSync(DEFAULT_CREDS_FILE, credentialsPath(name));
  chmodSync(credentialsPath(name), 0o600);
  setupInstanceSymlinks(instDir);

  // Try to extract email from creds
  let email: string | undefined;
  let plan: string | undefined;
  try {
    const raw: Credentials = JSON.parse(readFileSync(DEFAULT_CREDS_FILE, "utf8"));
    plan = raw.claudeAiOauth?.subscriptionType;
  } catch { /* ignore */ }

  const now = new Date().toISOString();
  reg.accounts[name] = {
    email,
    plan,
    instanceDir: instDir,
    created: now,
    lastUsed: now,
    lastValidated: now,
  };

  if (!reg.active) {
    reg.active = name;
    // Write active.env as well
    const activeEnv = `export CLAUDE_CONFIG_DIR=${instDir}\n`;
    writeFileSync(ACTIVE_ENV_FILE, activeEnv, { mode: 0o600 });
  }

  writeRegistry(reg);
  console.log(`${c.green("Saved current credentials as")} ${c.bold(name)}`);

  if (reg.active === name) {
    console.log(c.dim(`Set as active. Source ${ACTIVE_ENV_FILE} to apply.`));
  }
}

function cmdRemove(name: string): void {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    process.exit(1);
  }

  if (name === reg.active) {
    console.log(c.yellow(`Warning: '${name}' is the active account.`));
    process.stdout.write("Remove anyway? (y/N): ");
    const buf = Buffer.alloc(4096);
    const n = require("fs").readSync(process.stdin.fd, buf, 0, buf.length, null);
    const answer = buf.slice(0, n).toString().trim();
    if (answer !== "y" && answer !== "Y") {
      console.log("Aborted.");
      return;
    }
    reg.active = null;
  }

  delete reg.accounts[name];
  writeRegistry(reg);

  // Clean up associated files (but not the instance dir — keep credentials as backup)
  const cookiePath = sessionCookiePath(name);
  const uuidPath = orgUuidPath(name);
  if (existsSync(cookiePath)) unlinkSync(cookiePath);
  if (existsSync(uuidPath)) unlinkSync(uuidPath);

  console.log(`Removed ${c.bold(name)}`);
  console.log(c.dim(`Instance directory kept at: ${instanceDir(name)}`));
}

function cmdValidate(name?: string): void {
  const reg = readRegistry();
  const names = name ? [name] : Object.keys(reg.accounts);

  if (names.length === 0) {
    console.log(c.dim("No accounts to validate."));
    return;
  }

  let anyInvalid = false;

  for (const n of names) {
    if (!reg.accounts[n]) {
      console.error(c.red(`Account '${n}' not found.`));
      continue;
    }

    const status = validateTokens(n);
    const isActive = n === reg.active;
    const marker = isActive ? " " + c.green("(active)") : "";

    if (status.valid) {
      const exp = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "unknown";
      console.log(`${c.green("✓")} ${c.bold(n)}${marker} — token valid until ${exp}`);
    } else {
      anyInvalid = true;
      console.log(`${c.red("✗")} ${c.bold(n)}${marker} — ${status.error}`);
    }

    // Update lastValidated
    reg.accounts[n].lastValidated = new Date().toISOString();
  }

  writeRegistry(reg);

  if (anyInvalid) {
    console.log("");
    console.log(c.dim("To fix expired tokens: claude auth login, then cc-hotswap add <name>"));
    process.exit(1);
  }
}

function cmdExec(name: string, cmd: string[]): void {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    process.exit(1);
  }

  if (cmd.length === 0) {
    console.error(c.red("No command specified. Usage: cc-hotswap exec <name> -- <cmd...>"));
    process.exit(1);
  }

  const instDir = instanceDir(name);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: instDir };

  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
  });

  process.exit(result.status ?? 0);
}

function cmdEnv(name: string): void {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    process.exit(1);
  }

  const instDir = instanceDir(name);
  console.log(`export CLAUDE_CONFIG_DIR=${instDir}`);
}

function cmdSetCookie(name: string, key: string): void {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    process.exit(1);
  }

  ensureDirs();
  writeFileSync(sessionCookiePath(name), key.trim(), { mode: 0o600 });
  console.log(`${c.green("Session cookie saved for")} ${c.bold(name)}`);

  // Auto-discover org UUID if missing
  if (!existsSync(orgUuidPath(name))) {
    console.log(c.dim("Discovering org UUID..."));
    discoverOrgUuid(name).then((uuid) => {
      if (uuid) {
        writeFileSync(orgUuidPath(name), uuid, { mode: 0o600 });
        console.log(`${c.green("Org UUID saved:")} ${c.dim(uuid)}`);
      } else {
        console.log(c.red("Could not discover org UUID — session cookie may be expired"));
      }
    });
  }
}

async function cmdDiscoverOrg(name: string): Promise<void> {
  const reg = readRegistry();

  if (!reg.accounts[name]) {
    console.error(c.red(`Account '${name}' not found.`));
    process.exit(1);
  }

  const uuid = await discoverOrgUuid(name);
  if (uuid) {
    ensureDirs();
    writeFileSync(orgUuidPath(name), uuid, { mode: 0o600 });
    console.log(`${c.green("Org UUID saved:")} ${c.dim(uuid)}`);
  } else {
    console.error(c.red("Could not discover org UUID — session cookie may be expired"));
    process.exit(1);
  }
}

function cmdMigrate(): void {
  // Read old format from ~/.claude/accounts/
  const OLD_ACCT_DIR = join(HOME, ".claude", "accounts");
  const currentFile = join(OLD_ACCT_DIR, ".current");

  console.log(c.bold("Migrating from swap.sh format to cc-hotswap v2..."));
  console.log("");

  ensureDirs();
  const reg = readRegistry();

  // Read old current account
  const oldCurrent = existsSync(currentFile)
    ? readFileSync(currentFile, "utf8").trim()
    : null;

  // Find all old-format creds files
  let found = 0;
  const oldFiles = existsSync(OLD_ACCT_DIR)
    ? readdirSync(OLD_ACCT_DIR).filter((f) => f.startsWith("creds-") && f.endsWith(".json"))
    : [];

  for (const file of oldFiles) {
    const name = file.replace(/^creds-/, "").replace(/\.json$/, "");
    const oldCredsPath = join(OLD_ACCT_DIR, file);
    const instDir = instanceDir(name);

    if (!existsSync(instDir)) {
      mkdirSync(instDir, { recursive: true });
    }

    const destCreds = credentialsPath(name);
    copyFileSync(oldCredsPath, destCreds);
    chmodSync(destCreds, 0o600);
    setupInstanceSymlinks(instDir);
    console.log(`  ${c.green("✓")} Migrated ${c.bold(name)}`);

    // Try to extract plan from creds
    let plan: string | undefined;
    try {
      const raw: Credentials = JSON.parse(readFileSync(oldCredsPath, "utf8"));
      plan = raw.claudeAiOauth?.subscriptionType;
    } catch { /* ignore */ }

    const now = new Date().toISOString();
    if (!reg.accounts[name]) {
      reg.accounts[name] = {
        plan,
        instanceDir: instDir,
        created: now,
        lastUsed: name === oldCurrent ? now : undefined,
        lastValidated: null,
      };
    }

    // Migrate session cookie (old: session-<name>.key → new path)
    const oldCookiePath = join(OLD_ACCT_DIR, `session-${name}.key`);
    if (existsSync(oldCookiePath)) {
      const newCookiePath = sessionCookiePath(name);
      copyFileSync(oldCookiePath, newCookiePath);
      chmodSync(newCookiePath, 0o600);
      console.log(`    ${c.dim(`Session cookie migrated → ${newCookiePath}`)}`);
    }

    // Migrate org UUID (old: org-<name>.uuid → new path)
    const oldUuidPath = join(OLD_ACCT_DIR, `org-${name}.uuid`);
    if (existsSync(oldUuidPath)) {
      const newUuidPath = orgUuidPath(name);
      copyFileSync(oldUuidPath, newUuidPath);
      chmodSync(newUuidPath, 0o600);
      console.log(`    ${c.dim(`Org UUID migrated → ${newUuidPath}`)}`);
    }

    found++;
  }

  if (found === 0) {
    console.log(c.dim("No old-format creds-*.json files found."));
    console.log(c.dim("If you have accounts in a different location, set CLAUDE_SWAP_DIR."));
  }

  // Set active account
  if (oldCurrent && reg.accounts[oldCurrent]) {
    reg.active = oldCurrent;
    const instDir = instanceDir(oldCurrent);
    const activeEnv = `export CLAUDE_CONFIG_DIR=${instDir}\n`;
    writeFileSync(ACTIVE_ENV_FILE, activeEnv, { mode: 0o600 });
    console.log("");
    console.log(`${c.green("Active account:")} ${c.bold(oldCurrent)}`);
  }

  writeRegistry(reg);

  console.log("");
  console.log(c.bold("Migration complete."));
  console.log(c.dim("Old files kept as backup — remove manually when satisfied."));
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Add to ~/.zshrc: ${c.dim(`[ -f ${ACTIVE_ENV_FILE} ] && source ${ACTIVE_ENV_FILE}`)}`);
  console.log(`  2. Reload shell:    source ~/.zshrc`);
  console.log(`  3. Verify:         cc-hotswap status`);
}

function cmdHelp(): void {
  console.log(`${c.bold("cc-hotswap")} — switch between Claude Code accounts using CLAUDE_CONFIG_DIR

${c.bold("Usage:")}
  cc-hotswap                        Show current account and list all
  cc-hotswap swap <name>            Switch active account
  cc-hotswap usage                  Check usage for all accounts
  cc-hotswap status                 Detailed status (tokens, expiry, tier)
  cc-hotswap add <name>             Save current login as a named account
  cc-hotswap remove <name>          Remove a saved account
  cc-hotswap validate [name]        Check if tokens are valid
  cc-hotswap exec <name> -- <cmd>   Run a command with CLAUDE_CONFIG_DIR set
  cc-hotswap env <name>             Print CLAUDE_CONFIG_DIR export line
  cc-hotswap set-cookie <name> <key>  Save session cookie for usage API
  cc-hotswap discover-org <name>    Auto-discover org UUID from session cookie
  cc-hotswap migrate                One-time migration from swap.sh format
  cc-hotswap help                   Show this help

${c.bold("Setup:")}
  1. Log in:    claude auth login
  2. Save it:   cc-hotswap add my-account
  3. Repeat for each account
  4. Swap:      cc-hotswap swap my-account
  5. Apply:     source ~/.claude/accounts/active.env

${c.bold("Shell integration (add to ~/.zshrc / ~/.bashrc):")}
  [ -f ~/.claude/accounts/active.env ] && source ~/.claude/accounts/active.env

${c.bold("Usage checking:")}
  1. Open claude.ai in browser → DevTools → Application → Cookies
  2. Copy the 'sessionKey' value
  3. Run: cc-hotswap set-cookie my-account <session-key>
  4. Run: cc-hotswap usage

${c.bold("Programmatic use:")}
  cc-hotswap exec my-account -- claude --print "hello"
  eval "$(cc-hotswap env my-account)" && claude --print "hello"

${c.bold("Storage:")}
  Registry:     ~/.claude/accounts/config.json
  Instances:    ~/.claude/accounts/instances/<name>/
  Active env:   ~/.claude/accounts/active.env
  Session keys: ~/.claude/accounts/session-cookies/<name>.key
  Org UUIDs:    ~/.claude/accounts/org-uuids/<name>.uuid
`);
}

// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case undefined:
    case "list":
      cmdList();
      break;

    case "swap": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap swap <name>"));
        process.exit(1);
      }
      cmdSwap(name);
      break;
    }

    case "usage":
      await cmdUsage();
      break;

    case "status":
      cmdStatus();
      break;

    case "add": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap add <name>"));
        process.exit(1);
      }
      cmdAdd(name);
      break;
    }

    case "remove":
    case "rm": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap remove <name>"));
        process.exit(1);
      }
      cmdRemove(name);
      break;
    }

    case "validate": {
      const name = args[1]; // optional
      cmdValidate(name);
      break;
    }

    case "exec": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap exec <name> -- <cmd...>"));
        process.exit(1);
      }
      const dashDash = args.indexOf("--");
      const cmd = dashDash >= 0 ? args.slice(dashDash + 1) : [];
      cmdExec(name, cmd);
      break;
    }

    case "env": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap env <name>"));
        process.exit(1);
      }
      cmdEnv(name);
      break;
    }

    case "set-cookie": {
      const name = args[1];
      const key = args[2];
      if (!name || !key) {
        console.error(c.red("Usage: cc-hotswap set-cookie <name> <session-key>"));
        process.exit(1);
      }
      cmdSetCookie(name, key);
      break;
    }

    case "discover-org": {
      const name = args[1];
      if (!name) {
        console.error(c.red("Usage: cc-hotswap discover-org <name>"));
        process.exit(1);
      }
      await cmdDiscoverOrg(name);
      break;
    }

    case "migrate":
      cmdMigrate();
      break;

    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;

    default:
      console.error(c.red(`Unknown command: ${cmd}`));
      console.error(`Run ${c.bold("cc-hotswap help")} for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
