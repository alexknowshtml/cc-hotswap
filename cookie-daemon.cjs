// cc-hotswap cookie daemon
// Keeps one Chromium instance running persistently, refreshes both accounts
// every 10 minutes. Much lighter than launching/killing a browser each time.

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const https = require('https');

chromium.use(stealth());

const COOKIE_DIR = process.env.CC_HOTSWAP_DIR || path.join(process.env.HOME, '.claude', 'accounts', 'cc-hotswap-cookies');
const ACCT_DIR = process.env.CC_HOTSWAP_ACCT_DIR || path.join(process.env.HOME, '.claude', 'accounts');
const STATE_DIR = path.join(COOKIE_DIR, 'browser-state');
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const LOG_FILE = path.join(COOKIE_DIR, 'daemon.log');

function log(msg) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function truncateLog() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 1024 * 1024) { // 1MB
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n'));
      log('Log truncated to last 500 lines');
    }
  } catch {}
}

function verifySessionCurl(cookie) {
  return new Promise((resolve) => {
    const req = https.get('https://claude.ai/api/organizations', {
      headers: {
        'cookie': `sessionKey=${cookie}`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'referer': 'https://claude.ai/settings'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve(res.statusCode === 200 && !data.includes('Invalid authorization'));
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
  });
}

function saveCookie(context, name) {
  return context.cookies('https://claude.ai').then(cookies => {
    const sc = cookies.find(c => c.name === 'sessionKey');
    if (sc) {
      // Save to accounts dir (where swap.sh reads them)
      const cookieFile = path.join(ACCT_DIR, `session-${name}.key`);
      fs.writeFileSync(cookieFile, sc.value);
      fs.chmodSync(cookieFile, 0o600);
      return sc.value;
    }
    return null;
  });
}

async function refreshContext(context, page, name, stateFile) {
  try {
    await page.goto('https://claude.ai/settings', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    // Handle Cloudflare
    const isCloudflare = await page.evaluate(() =>
      document.title.includes('Just a moment') ||
      document.body?.innerText?.includes('Verifying you are human')
    ).catch(() => false);

    if (isCloudflare) {
      log(`  ${name}: Cloudflare challenge, waiting 10s...`);
      await page.waitForTimeout(10000);
    }

    // Extract and verify cookie
    const cookie = await saveCookie(context, name);
    if (!cookie) {
      log(`  ${name}: No sessionKey cookie found`);
      return false;
    }

    const valid = await verifySessionCurl(cookie);
    if (!valid) {
      log(`  ${name}: Session expired — needs re-init`);
      return false;
    }

    // Save browser state for recovery
    await context.storageState({ path: stateFile });
    fs.chmodSync(stateFile, 0o600);

    log(`  ${name}: OK`);
    return true;
  } catch (err) {
    log(`  ${name}: Error — ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function gracefulStop(contexts, browser, signal) {
  log(`Received ${signal}, saving state...`);
  for (const [name, ctx] of Object.entries(contexts)) {
    try {
      await ctx.context.storageState({ path: ctx.stateFile });
      await saveCookie(ctx.context, name);
    } catch {}
  }
  await browser.close().catch(() => {});
  log('Daemon stopped');
  process.exit(0);
}

async function main() {
  log('Cookie daemon starting...');

  const stateFiles = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  if (stateFiles.length === 0) {
    log('No browser state files found. Run refresh-cookies.cjs --init first.');
    process.exit(1);
  }

  const accounts = stateFiles.map(f => f.replace('.json', ''));
  log(`Accounts: ${accounts.join(', ')}`);

  // Launch one browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  log('Browser launched (headless)');

  // Create one context+page per account
  const contexts = {};
  for (const name of accounts) {
    const stateFile = path.join(STATE_DIR, `${name}.json`);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      storageState: stateFile
    });
    const page = await context.newPage();
    contexts[name] = { context, page, stateFile };
  }

  log(`${Object.keys(contexts).length} context(s) initialized`);

  // Initial refresh
  log('Running initial refresh...');
  for (const [name, ctx] of Object.entries(contexts)) {
    await refreshContext(ctx.context, ctx.page, name, ctx.stateFile);
  }

  // Refresh loop
  log(`Entering refresh loop (every ${REFRESH_INTERVAL / 60000} minutes)`);

  // Graceful stop handlers
  process.on('SIGTERM', () => gracefulStop(contexts, browser, 'SIGTERM'));
  process.on('SIGINT', () => gracefulStop(contexts, browser, 'SIGINT'));

  while (true) {
    await new Promise(r => setTimeout(r, REFRESH_INTERVAL));
    truncateLog();
    log('Refreshing...');
    for (const [name, ctx] of Object.entries(contexts)) {
      await refreshContext(ctx.context, ctx.page, name, ctx.stateFile);
    }
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
