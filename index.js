const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const API_TOKEN   = process.env.API_TOKEN;
const GUSER       = process.env.GOOGLE_USER;
const GPASS       = process.env.GOOGLE_PASS;

// Health check
app.get('/', (_, res) => res.send('OK'));

// Utilities
const UK_PHONE_REGEX =
  /(\+44\s?7\d{3}\s?\d{6}|07\d{3}\s?\d{6}|0\d{3}\s?\d{3}\s?\d{4}|\+44\s?0?\d{10})/;

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  // Convert 07xxxxxxxxx or +447xxxxxxxxx to E.164 (+447xxxxxxxxx)
  if (digits.startsWith('+44')) return digits;
  if (digits.startsWith('07')) return '+44' + digits.slice(1);
  if (digits.startsWith('0044')) return '+' + digits.slice(2);
  return raw;
}

async function loginGoogle(page) {
  // If already logged in, Google usually redirects to account page silently.
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  // If we see “Choose an account” or already logged, skip entering creds
  if (await page.locator('input[type="email"]').count()) {
    await page.fill('input[type="email"]', GUSER);
    await page.click('button:has-text("Next"), div[role="button"]:has-text("Next")');
    await page.waitForTimeout(800); // small pause for transition

    // Password step
    await page.fill('input[type="password"]', GPASS);
    await page.click('button:has-text("Next"), div[role="button"]:has-text("Next")');
  }

  // Wait for any Google property that indicates session
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

/**
 * NEW TASK: extract-phone
 * Body: { url: "https://c.gle/...", task: "extract-phone", callbackUrl? }
 */
app.post('/run-task', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { url, task, callbackUrl } = req.body;
  if (!task) return res.status(400).json({ error: 'task is required' });

  if (task === 'title') {                      // your existing simple task
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    await browser.close();
    return res.json({ title });
  }

  if (task === 'screenshot') {                 // your existing example
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: 'screenshot.png', fullPage: true });
    await browser.close();
    return res.json({ message: 'Screenshot saved', file: 'screenshot.png' });
  }

  if (task === 'extract-phone') {
    if (!url) return res.status(400).json({ error: 'url is required' });
    const browser = await chromium.launch({
      headless: true
      // Using Docker Playwright image, so no extra flags needed.
    });

    // Use a persistent context so Google stays logged-in between runs
    const context = await browser.newContext({ storageState: '/tmp/google-state.json' });
    const page = await context.newPage();

    try {
      // If we likely have no session, attempt login
      const cookies = await context.cookies();
      const hasGoogleCookie = cookies.some(c => c.domain.includes('google'));
      if (!hasGoogleCookie && GUSER && GPASS) {
        await loginGoogle(page);
        // Save session for next run
        await context.storageState({ path: '/tmp/google-state.json' });
      }

      // Open the lead link (your c.gle will redirect to ads.google.com page)
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Allow redirect and dynamic content to settle
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Grab plain text of page and regex the number
      const fullText = await page.evaluate(() => document.body.innerText || '');
      const match = fullText.match(UK_PHONE_REGEX);
      const phone = normalizePhone(match ? match[0] : null);

      const result = {
        ok: !!phone,
        phone,
        sourceUrl: url
      };

      // Optional: push to Make.com webhook if provided (or env fallback)
      const postTo = callbackUrl || process.env.CALLBACK_URL;
      if (postTo && phone) {
        await page.evaluate(async (endpoint, payload) => {
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        }, postTo, result);
      }

      await browser.close();
      return res.json(result);
    } catch (err) {
      await browser.close();
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Unsupported task: ${task}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
