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
// NEW: optional comma-separated list of emails to ignore (in addition to GOOGLE_USER)
const EXCLUDE_EMAILS = (process.env.EXCLUDE_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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

// Email regex (robust enough for scraping; avoids catastrophic backtracking)
const EMAIL_REGEX_GLOBAL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Known non-lead/system domains to ignore
const SERVICE_EMAIL_DOMAINS = [
  'google.com', 'gstatic.com', 'googlemail.com', 'corp.google.com',
  'adwords.corp.google.com', 'awx-sab-debug.corp.google.com'
];

function isServiceEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  return SERVICE_EMAIL_DOMAINS.some(d => domain.endsWith(d));
}

function isExcludedEmail(email) {
  const e = (email || '').toLowerCase();
  if (GUSER && e === GUSER.toLowerCase()) return true; // always exclude login email
  return EXCLUDE_EMAILS.includes(e);
}

// Try to get the main "lead" panel text (to avoid header/user chrome)
async function getLeadPanelText(page) {
  return await page.evaluate(() => {
    const candidates = [];
    // role=main first
    const main = document.querySelector('[role="main"]');
    if (main) candidates.push(main);

    // Any element that contains Lead header labels
    const allDivs = Array.from(document.querySelectorAll('div, section, main'));
    for (const el of allDivs) {
      const t = (el.innerText || '').toLowerCase();
      if (t.includes('lead summary') || t.includes('conversation')) {
        candidates.push(el);
      }
    }

    // Return the largest informative candidate text
    let best = '';
    for (const el of candidates) {
      const text = (el.innerText || '').trim();
      if (text && text.length > best.length) best = text;
    }
    return best;
  });
}

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

// PHONE: DOM poll then HTML fallback
async function findFirstPhoneOnPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText || '');
    const matches = text.match(UK_PHONE_REGEX_GLOBAL) || [];
    if (matches.length) return matches[0];
    await page.waitForTimeout(500);
  }

  const html = await page.content();
  const srcMatches = html.match(UK_PHONE_REGEX_GLOBAL) || [];
  if (srcMatches.length) return srcMatches[0];

  return null;
}

// EMAIL: lead panel first, then body, then HTML; exclude login/service emails
async function findFirstEmailOnPage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  // 1) Lead panel text first (reduces chance of grabbing login email)
  const leadText = (await getLeadPanelText(page)) || '';
  const panelMatches = (leadText.match(EMAIL_REGEX_GLOBAL) || [])
    .filter(e => !isServiceEmail(e) && !isExcludedEmail(e));
  if (panelMatches.length) return panelMatches[0];

  // 2) Poll rendered body
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body?.innerText || '');
    const matches = (text.match(EMAIL_REGEX_GLOBAL) || [])
      .filter(e => !isServiceEmail(e) && !isExcludedEmail(e));
    if (matches.length) return matches[0];
    await page.waitForTimeout(500);
  }

  // 3) Fallback: HTML source
  const html = await page.content();
  const srcMatches = (html.match(EMAIL_REGEX_GLOBAL) || [])
    .filter(e => !isServiceEmail(e) && !isExcludedEmail(e));
  if (srcMatches.length) return srcMatches[0];

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
      await page.waitForTimeout(1000);

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
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        let phone = "Required";
        if (!/no phone number/i.test(bodyText)) {
          phone = (await findFirstPhoneOnPage(page, 15000)) || "Required";
        }
        const payload = { ok: phone !== "Required", phone, sourceUrl: url };

        const endpoint = callbackUrl || CALLBACK_URL;
        if (endpoint) {
          try {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            log('callback posted to', endpoint);
          } catch (e) { log('WARN(callback failed):', e.message); }
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
          } catch (e) { log('WARN(callback failed):', e.message); }
        }
        return payload;
      });
      return res.json(result);
    } catch (err) {
      log('ERROR(extract-email):', err.message);
      return res.status(500).json({ error: err.message, where: 'extract-email' });
    }
  }

  // ----- Advanced: EXTRACT-CONTACT (phone + email) -----
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

        // Email (lead panel → body → html; exclude login/service)
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
          } catch (e) { log('WARN(callback failed):', e.message); }
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
