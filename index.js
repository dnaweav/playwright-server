// index.js
// Playwright MCP-style micro-API for Make.com

try { require('dotenv').config(); } catch {}

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

// ---------- Config ----------
const API_TOKEN     = process.env.API_TOKEN;             // required
const GUSER         = process.env.GOOGLE_USER || "";     // optional fallback
const GPASS         = process.env.GOOGLE_PASS || "";     // optional fallback
const CALLBACK_URL  = process.env.CALLBACK_URL || "";    // optional Make webhook
const STATE_PATH    = '/tmp/google-state.json';

// Seed storage state from env on boot (recommended approach for Google)
try {
  if (process.env.GOOGLE_STATE_B64 && !fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, Buffer.from(process.env.GOOGLE_STATE_B64, 'base64'));
    console.log('Seeded Google storage state to', STATE_PATH);
  }
} catch (e) {
  console.log('WARN: could not seed GOOGLE_STATE_B64:', e.message);
}

// ---------- Helpers ----------

// Accept +44, 07…, 01…, 02… with optional spaces/hyphens; global for all matches in page-order
const UK_PHONE_REGEX_GLOBAL =
  /\b(?:\+44\s?\d(?:[\s-]?\d){8,9}|07(?:[\s-]?\d){9}|0[12](?:[\s-]?\d){8,9})\b/g;

// Simple email regex that avoids most false-positives and works with WIZ JSON text
const EMAIL_REGEX_GLOBAL =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Obvious non-lead domains to ignore when scraping from Google HTML/JS
const EMAIL_DOMAIN_BLOCKLIST = new Set([
  'google.com', 'gstatic.com', 'googletagmanager.com', 'gmail.com' // keep gmail? -> many leads use it; remove if you want to allow Gmail
]);
// If you want to allow Gmail leads, delete 'gmail.com' above.

// Fallback scripted login (avoid when possible—prefer storage state)
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

// Return the first phone number on the page (DOM first, then HTML source)
async function findFirstPhoneOnPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  // 1) Poll rendered text (keeps the "first seen" rule)
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText || '');
    const matches = text.match(UK_PHONE_REGEX_GLOBAL) || [];
    if (matches.length) return matches[0];
    await page.waitForTimeout(500);
  }

  // 2) Fallback: HTML source (captures numbers embedded in WIZ JSON)
  const html = await page.content();
  const srcMatches = html.match(UK_PHONE_REGEX_GLOBAL) || [];
  if (srcMatches.length) return srcMatches[0];

  return null;
}

// Return the first likely lead email (DOM first, then HTML source), skipping blocked domains
function pickFirstAllowedEmail(matches) {
  for (const m of matches) {
    const email = m.trim();
    const domain = email.split('@')[1]?.toLowerCase() || '';
    const root = domain.split(':')[0].split('/')[0]; // strip any oddities
    const tld = root.split('.').slice(-2).join('.');  // crude eTLD+1 approximation
    if (!EMAIL_DOMAIN_BLOCKLIST.has(tld)) return email;
  }
  return null;
}

async function findFirstEmailOnPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  // 1) Rendered text first
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText || '');
    const matches = text.match(EMAIL_REGEX_GLOBAL) || [];
    const chosen = pickFirstAllowedEmail(matches);
    if (chosen) return chosen;
    await page.waitForTimeout(500);
  }

  // 2) HTML source (WIZ JSON etc.)
  const html = await page.content();
  const srcMatches = html.match(EMAIL_REGEX_GLOBAL) || [];
  const chosen = pickFirstAllowedEmail(srcMatches);
  if (chosen) return chosen;

  return null;
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

  // ----- Shared setup for extract-* tasks -----
  async function withContext(run) {
    const browser = await chromium.launch({ headless: true });
    let context;
    try {
      const hasState = fs.existsSync(STATE_PATH);
      context = hasState
        ? await browser.newContext({ storageState: STATE_PATH })
        : await browser.newContext();

      const page = await context.newPage();

      // If no Google cookies and no state, attempt fallback login once
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
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1000); // give SPA a moment to hydrate

      return await run(page);
    } finally {
      try { if (context) await context.close(); } catch {}
      await browser.close();
    }
  }

  // ----- Advanced: EXTRACT-PHONE -----
  if (task === 'extract-phone') {
    if (!url) return res.status(400).json({ error: 'url is required' });

    try {
      const result = await withContext(async (page) => {
        // If header displays “No phone number”, force Required
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        let phone = "Required";
        if (!/no phone number/i.test(bodyText)) {
          phone = (await findFirstPhoneOnPage(page, 15000)) || "Required";
        }

        const payload = { ok: phone !== "Required", phone, sourceUrl: url };

        // Optional callback to Make.com webhook
        const endpoint = callbackUrl || CALLBACK_URL;
        if (endpoint) {
          try {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            log('callback posted to', endpoint);
          } catch (e) {
            log('WARN(callback failed):', e.message);
          }
        }
        return payload;
      });
      return res.json(result);
    } catch (err) {
      log('ERROR(extract-phone):', err.message);
      return res.status(500).json({ error: err.message, where: 'extract-phone' });
    }
  }

  // ----- Advanced: EXTRACT-EMAIL -----
  if (task === 'extract-email') {
    if (!url) return res.status(400).json({ error: 'url is required' });

    try {
      const result = await withContext(async (page) => {
        const email = (await findFirstEmailOnPage(page, 15000)) || "Required";
        const payload = { ok: email !== "Required", email, sourceUrl: url };

        const endpoint = callbackUrl || CALLBACK_URL;
        if (endpoint) {
          try {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            log('callback posted to', endpoint);
          } catch (e) {
            log('WARN(callback failed):', e.message);
          }
        }
        return payload;
      });
      return res.json(result);
    } catch (err) {
      log('ERROR(extract-email):', err.message);
      return res.status(500).json({ error: err.message, where: 'extract-email' });
    }
  }

  // ----- Advanced: EXTRACT-CONTACT (phone + email in one call) -----
  if (task === 'extract-contact') {
    if (!url) return res.status(400).json({ error: 'url is required' });

    try {
      const result = await withContext(async (page) => {
        // Phone (respect "No phone number")
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        let phone = "Required";
        if (!/no phone number/i.test(bodyText)) {
          phone = (await findFirstPhoneOnPage(page, 15000)) || "Required";
        }

        // Email
        const email = (await findFirstEmailOnPage(page, 15000)) || "Required";

        const payload = {
          ok: phone !== "Required" || email !== "Required",
          phone,
          email,
          sourceUrl: url
        };

        const endpoint = callbackUrl || CALLBACK_URL;
        if (endpoint) {
          try {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            log('callback posted to', endpoint);
          } catch (e) {
            log('WARN(callback failed):', e.message);
          }
        }
        return payload;
      });
      return res.json(result);
    } catch (err) {
      log('ERROR(extract-contact):', err.message);
      return res.status(500).json({ error: err.message, where: 'extract-contact' });
    }
  }

  return res.status(400).json({ error: `Unsupported task: ${task}` });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
