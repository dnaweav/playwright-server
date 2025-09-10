// index.js
// Playwright MCP-style micro-API for Make.com

try { require('dotenv').config(); } catch {}

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

// ---------- Config ----------
const API_TOKEN     = process.env.API_TOKEN;             // required Auth bearer
const GUSER         = process.env.GOOGLE_USER || "";     // optional fallback
const GPASS         = process.env.GOOGLE_PASS || "";
const CALLBACK_URL  = process.env.CALLBACK_URL || "";
const STATE_PATH    = '/tmp/google-state.json';

// Seed storage state from env (recommended)
try {
  if (process.env.GOOGLE_STATE_B64 && !fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, Buffer.from(process.env.GOOGLE_STATE_B64, 'base64'));
    console.log('Seeded Google storage state to', STATE_PATH);
  }
} catch (e) {
  console.log('WARN: could not seed GOOGLE_STATE_B64:', e.message);
}

// ---------- Helpers ----------
// Match UK numbers with optional spaces/hyphens and return raw text
// - +44 followed by 9–10 digits (e.g. +44 20 7123 4567, +447796980202)
// - Mobiles 07xxxxxxxxx (allow spaces/hyphens)
// - Landlines starting 01 or 02 (allow spaces/hyphens)
const UK_PHONE_REGEX_GLOBAL =
  /\b(?:\+44\s?\d(?:[\s-]?\d){8,9}|07(?:[\s-]?\d){9}|0[12](?:[\s-]?\d){8,9})\b/g;

async function loginGoogle(page) {
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  const email = page.locator('input[type="email"], input[name="identifier"]');
  await email.waitFor({ timeout: 20000 });
  await email.fill(GUSER);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator('#identifierNext, button:has-text("Next"), div[role="button"]:has-text("Next")').click()
  ]);

  const pass = page.locator('input[type="password"], input[name="Passwd"]');
  await pass.waitFor({ timeout: 30000 });
  await pass.fill(GPASS);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator('#passwordNext, button:has-text("Next"), div[role="button"]:has-text("Next")').click()
  ]);
}

// ---------- Health ----------
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true }));

// ---------- Main endpoint ----------
app.post('/run-task', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || '';
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { task, url, callbackUrl } = req.body || {};
  if (!task) return res.status(400).json({ error: 'task is required' });

  const log = (...a) => console.log(`[run-task][${task}]`, ...a);

  // ----- Simple: TITLE -----
  if (task === 'title') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      return res.json({ title, sourceUrl: url });
    } catch (err) {
      log('ERROR(title):', err.message);
      return res.status(500).json({ error: err.message, where: 'title' });
    } finally {
      await browser.close();
    }
  }

  // ----- Simple: SCREENSHOT -----
  if (task === 'screenshot') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.screenshot({ path: 'screenshot.png', fullPage: true });
      return res.json({ message: 'Screenshot saved', file: 'screenshot.png', sourceUrl: url });
    } catch (err) {
      log('ERROR(screenshot):', err.message);
      return res.status(500).json({ error: err.message, where: 'screenshot' });
    } finally {
      await browser.close();
    }
  }

  // ----- Advanced: EXTRACT-PHONE -----
if (task === 'extract-phone') {
  if (!url) return res.status(400).json({ error: 'url is required' });

  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    const hasState = fs.existsSync(STATE_PATH);
    context = hasState
      ? await browser.newContext({ storageState: STATE_PATH })
      : await browser.newContext();

    const page = await context.newPage();

    const cookies = await context.cookies();
    const hasGoogleCookie = cookies.some(c => c.domain.includes('google'));
    log('hasState', hasState, 'hasGoogleCookie', hasGoogleCookie);

    if (!hasGoogleCookie && GUSER && GPASS && !hasState) {
      log('Attempting fallback login...');
      await loginGoogle(page);
      await context.storageState({ path: STATE_PATH });
      log('Login complete; state saved');
    }

    log('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const text = await page.evaluate(() => document.body?.innerText || '');
    // Get ALL matches in natural text order, then take the first
    const matches = text.match(UK_PHONE_REGEX_GLOBAL) || [];
    const phone = matches[0] || "Required";

    log('extracted phone:', phone);

    const result = { ok: phone !== "Required", phone, sourceUrl: url };

    const endpoint = callbackUrl || CALLBACK_URL;
    if (endpoint) {
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result)
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

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
