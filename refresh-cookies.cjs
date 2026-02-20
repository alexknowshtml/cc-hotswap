// cc-hotswap cookie refresh script
// One-shot refresh and init for claude.ai session cookies

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

chromium.use(stealth());

const COOKIE_DIR = process.env.CC_HOTSWAP_DIR || path.join(process.env.HOME, '.claude', 'accounts', 'cc-hotswap-cookies');
const ACCT_DIR = process.env.CC_HOTSWAP_ACCT_DIR || path.join(process.env.HOME, '.claude', 'accounts');
const STATE_DIR = path.join(COOKIE_DIR, 'browser-state');

fs.mkdirSync(COOKIE_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

async function verifySession(context) {
  // Actually verify the session works by hitting the organizations API
  const cookies = await context.cookies('https://claude.ai');
  const sessionCookie = cookies.find(c => c.name === 'sessionKey');
  if (!sessionCookie) return false;
  
  try {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.get('https://claude.ai/api/organizations', {
        headers: {
          'cookie': `sessionKey=${sessionCookie.value}`,
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
  } catch {
    return false;
  }
}

async function initAccount(name) {
  console.log(`Opening browser for login: ${name}`);
  
  const stateFile = path.join(STATE_DIR, `${name}.json`);
  
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  const launchOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
  };
  if (fs.existsSync(stateFile)) {
    launchOpts.storageState = stateFile;
  }
  
  const context = await browser.newContext(launchOpts);
  const page = await context.newPage();
  await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  
  // Verify session actually works (not just URL check)
  if (await verifySession(context)) {
    console.log('Session is valid! Saving state...');
    await saveAndExit(context, browser, name, stateFile);
    return;
  }
  
  console.log('Waiting for login... (will auto-save when valid session detected)');
  
  // Poll for valid session — every 3 seconds for up to 5 minutes
  const maxWait = 300000;
  const pollInterval = 3000;
  let elapsed = 0;
  
  while (elapsed < maxWait) {
    await page.waitForTimeout(pollInterval);
    elapsed += pollInterval;
    
    if (await verifySession(context)) {
      console.log('Login detected and verified!');
      await page.waitForTimeout(2000); // let page settle
      await saveAndExit(context, browser, name, stateFile);
      return;
    }
    
    if (elapsed % 15000 === 0) {
      console.log(`  Still waiting... (${Math.round(elapsed/1000)}s)`);
    }
  }
  
  console.log('Timed out waiting for login (5 minutes). No state saved.');
  await browser.close();
  process.exit(1);
}

async function saveAndExit(context, browser, name, stateFile) {
  await context.storageState({ path: stateFile });
  fs.chmodSync(stateFile, 0o600);
  const saved = await extractAndSaveCookie(context, name);
  await browser.close();
  if (saved) {
    console.log(`Done. State saved for ${name}`);
  }
  process.exit(0);
}

async function extractAndSaveCookie(context, name) {
  const cookies = await context.cookies('https://claude.ai');
  const sessionCookie = cookies.find(c => c.name === 'sessionKey');
  
  if (sessionCookie) {
    const cookieFile = path.join(ACCT_DIR, `session-${name}.key`);
    fs.writeFileSync(cookieFile, sessionCookie.value);
    fs.chmodSync(cookieFile, 0o600);
    console.log(`Session cookie saved: session-${name}.key`);
    return true;
  } else {
    console.log(`WARNING: No sessionKey cookie found for ${name}`);
    return false;
  }
}

async function refreshAccount(name) {
  const stateFile = path.join(STATE_DIR, `${name}.json`);
  
  if (!fs.existsSync(stateFile)) {
    console.log(`No saved state for ${name}. Run --init first.`);
    return false;
  }
  
  console.log(`Refreshing: ${name}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      storageState: stateFile
    });
    
    const page = await context.newPage();
    
    await page.goto('https://claude.ai/settings', { 
      waitUntil: 'domcontentloaded', 
      timeout: 60000 
    });
    
    await page.waitForTimeout(5000);
    
    const isCloudflare = await page.evaluate(() => 
      document.title.includes('Just a moment') || 
      document.body?.innerText?.includes('Verifying you are human')
    ).catch(() => false);
    
    if (isCloudflare) {
      console.log(`  Cloudflare challenge detected, waiting...`);
      await page.waitForTimeout(10000);
    }
    
    // Verify with API instead of URL check
    if (!(await verifySession(context))) {
      console.log(`  Session expired — manual re-login needed`);
      console.log(`  Run: node refresh-cookies.cjs --init ${name}`);
      await browser.close();
      return false;
    }
    
    await context.storageState({ path: stateFile });
    fs.chmodSync(stateFile, 0o600);
    
    const success = await extractAndSaveCookie(context, name);
    
    await browser.close();
    if (success) console.log(`  OK`);
    return success;
  } catch (err) {
    console.log(`  Error: ${err.message.split('\n')[0]}`);
    if (browser) await browser.close().catch(() => {});
    return false;
  }
}

async function refreshAll() {
  const stateFiles = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  
  if (stateFiles.length === 0) {
    console.log('No saved sessions. Run: node refresh-cookies.cjs --init <name>');
    return;
  }
  
  console.log(`Refreshing ${stateFiles.length} account(s)...\n`);
  
  let success = 0, failed = 0;
  
  for (const file of stateFiles) {
    const name = file.replace('.json', '');
    const ok = await refreshAccount(name);
    if (ok) success++; else failed++;
  }
  
  console.log(`\nDone: ${success} refreshed, ${failed} failed`);
}

// --- Main ---
const args = process.argv.slice(2);

if (args[0] === '--init' && args[1]) {
  initAccount(args[1]);
} else if (args.length === 0) {
  refreshAll();
} else {
  console.log('Usage:');
  console.log('  node refresh-cookies.cjs              Refresh all saved sessions');
  console.log('  node refresh-cookies.cjs --init <name>  Manual login to save session');
}
