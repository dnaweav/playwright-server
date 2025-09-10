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

// --- Main task endpoint ---
app.post('/run-task', async (req, res) => {
  // Auth
  const token = req.headers.authorization?.split(' ')[1] || '';
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { task, url, callbackUrl } = req.body || {};
  if (!task) return res.status(400).json({ error: 'task is required' });

  // Simple tasks (no login)
  if (task === 'title') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const title = await page.title();
      return res.json({ title, sourceUrl: url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    } finally {
      await browser.close();
    }
  }

  if (task === 'screenshot') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.screenshot({ path: 'screenshot.png', fullPage: true });
      return res.json({ message: 'Screenshot saved', file: 'screenshot.png', sourceUrl: url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    } finally {
      await browser.close();
    }
  }

  // Advanced: extract-phone (requires Google session in many cases)
  if (task === 'extract-phone') {
    if (!url) return res.status(400).json({ error: 'url is required' });

    const browser = await chromium.launch({ headless: true });
    let context;
    try {
      // Use persisted session if present
      if (fs.existsSync(STATE_PATH)) {
        context = await browser.newContext({ storageState: STATE_PATH });
      } else {
        context = await browser.newContext();
      }

      const page = await context.newPage();

      // Determine if we need to log in (cookie presence heuristic)
      const cookies = await context.cookies();
      const hasGoogleCookie = cookies.some(c => c.domain.includes('google'));

      if (!hasGoogleCookie && GUSER && GPASS) {
        await loginGoogle(page);
        // Save session for next runs
        await context.storageState({ path: STATE_PATH });
      }

      // Go to the lead URL (c.gle will redirect to the Google page you saw)
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Extract phone number from whole page text (robust fallback)
      const fullText = await page.evaluate(() => document.body?.innerText || '');
      const match = fullText.match(UK_PHONE_REGEX);
      const phone = normalizePhone(match ? match[0] : null);

      const result = { ok: !!phone, phone, sourceUrl: url };

      // Optional callback to Make.com webhook
      const endpoint = callbackUrl || CALLBACK_URL;
      if (endpoint) {
        try {
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
          });
        } catch {
          // non-fatal if callback fails; still return result
        }
      }

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
