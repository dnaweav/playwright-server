// index.js
// Minimal Playwright MCP server with Google login + phone extraction

// Optional local .env support (Railway uses env vars automatically)
try { require('dotenv').config(); } catch {}

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

// --- Config from environment ---
const API_TOKEN    = process.env.API_TOKEN;          // required for auth
const GUSER        = process.env.GOOGLE_USER || "";  // google email (optional if using saved state)
const GPASS        = process.env.GOOGLE_PASS || "";  // google password (optional if using saved state)
const CALLBACK_URL = process.env.CALLBACK_URL || ""; // optional Make.com webhook
const STATE_PATH   = '/tmp/google-state.json';       // persisted Google session

// --- Helpers ---
const UK_PHONE_REGEX =
  /(\+44\s?7\d{3}\s?\d{6}|07\d{3}\s?\d{6}|0\d{3}\s?\d{3}\s?\d{4}|\+44\s?0?\d{10})/;

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) return digits;
  if (digits.startsWith('07')) return '+44' + digits.slice(1);
  if (digits.startsWith('0044')) return '+' + digits.slice(2);
  return raw;
}

async function loginGoogle(page) {
  // Navigate to Google Accounts and perform email/password login.
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  // If an email field is present, we need to log in
  if (await page.locator('input[type="email"]').count()) {
    await page.fill('input[type="email"]', GUSER);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('button:has-text("Next"), div[role="button"]:has-text("Next")')
    ]);

    // Password step
    await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});
    await page.fill('input[type="password"]', GPASS);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('button:has-text("Next"), div[role="button"]:has-text("Next")')
    ]);
  }

  // Try to settle on a logged-in state
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

// health checks
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

app.post('/run-task', async (req, res) => {
  const startAt = Date.now();
  const token = req.headers.authorization?.split(' ')[1] || '';
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { task, url, callbackUrl } = req.body || {};
  if (!task) return res.status(400).json({ error: 'task is required' });

  const log = (...args) => console.log(`[run-task][${task}]`, ...args);

  // --- simple tasks ---
  if (task === 'title' || task === 'screenshot') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      log('goto', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      if (task === 'title') {
        const title = await page.title();
        log('title:', title);
        return res.json({ title, sourceUrl: url, ms: Date.now() - startAt });
      }

      await page.screenshot({ path: 'screenshot.png', fullPage: true });
      log('screenshot saved');
      return res.json({ message: 'Screenshot saved', file: 'screenshot.png', sourceUrl: url, ms: Date.now() - startAt });
    } catch (err) {
      log('ERROR(simple):', err.message);
      return res.status(500).json({ error: err.message, where: 'simple' });
    } finally {
      await browser.close();
    }
  }

  // --- extract-phone ---
  if (task === 'extract-phone') {
    if (!url) return res.status(400).json({ error: 'url is required' });

    const browser = await chromium.launch({ headless: true });
    let context;
    try {
      // storage state guard
      const statePath = '/tmp/google-state.json';
      const hasState = fs.existsSync(statePath);
      context = hasState
        ? await browser.newContext({ storageState: statePath })
        : await browser.newContext();

      const page = await context.newPage();

      // see if we’re logged in already
      const cookies = await context.cookies();
      const hasGoogleCookie = cookies.some(c => c.domain.includes('google'));
      log('hasState', hasState, 'hasGoogleCookie', hasGoogleCookie);

      if (!hasGoogleCookie && GUSER && GPASS) {
        log('logging in to Google...');
        try {
          await loginGoogle(page);
          await context.storageState({ path: statePath });
          log('login complete; state saved');
        } catch (e) {
          log('ERROR(login):', e.message);
          return res.status(500).json({ error: `login failed: ${e.message}` });
        }
      }

      log('goto lead', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      const text = await page.evaluate(() => document.body?.innerText || '');
      const m = text.match(/(\+44\s?7\d{3}\s?\d{6}|07\d{3}\s?\d{6}|0\d{3}\s?\d{3}\s?\d{4}|\+44\s?0?\d{10})/);
      const phone = normalizePhone(m ? m[0] : null);
      log('extracted phone:', phone);

      const result = { ok: !!phone, phone, sourceUrl: url, ms: Date.now() - startAt };

      // optional callback
      const endpoint = callbackUrl || process.env.CALLBACK_URL;
      if (endpoint) {
        try {
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
          });
          log('callback posted to', endpoint);
        } catch (e) {
          log('WARN(callback failed):', e.message);
        }
      }

      return res.json(result);
    } catch (err) {
      log('ERROR(extract-phone):', err.message);
      return res.status(500).json({ error: err.message, where: 'extract-phone' });
    } finally {
      try { if (context) await context.close(); } catch {}
      await browser.close();
    }
  }

  return res.status(400).json({ error: `Unsupported task: ${task}` });
});


// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
