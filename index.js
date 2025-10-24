// playwright_scraper_fixed/index.js
// Cleaned-up and debug-friendly Playwright scraper

require('dotenv').config();

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN;
const GUSER = process.env.GOOGLE_USER || "";
const GPASS = process.env.GOOGLE_PASS || "";
const CALLBACK_URL = process.env.CALLBACK_URL || "";
const STATE_PATH = '/tmp/google-state.json';
const EMAIL_RECIPIENT = process.env.ALERT_EMAIL || 'adrentleads@gmail.com';

const EXCLUDE_EMAILS = (process.env.EXCLUDE_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
const BLOCKED_PHONES = ["020 3519 9816", ...(process.env.BLOCKED_PHONES || '').split(',')].map(p => p.trim());
const BLOCKED_SET = new Set(BLOCKED_PHONES.map(p => normalizePhoneForCompare(p)));

const UK_PHONE_REGEX_GLOBAL = /\b(?:\+44\s?\d(?:[\s-]?\d){8,9}|07(?:[\s-]?\d){9}|0[12](?:[\s-]?\d){8,9})\b/g;
const EMAIL_REGEX_GLOBAL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function normalizePhoneForCompare(p = '') {
  const digits = p.replace(/\D/g, '');
  return digits.startsWith('44') ? '0' + digits.slice(2) : digits;
}

function isServiceEmail(email) {
  return ["google.com", "gstatic.com"].some(domain => email.endsWith(domain));
}

function isExcludedEmail(email) {
  return EXCLUDE_EMAILS.includes(email.toLowerCase()) || email.toLowerCase() === GUSER.toLowerCase();
}

async function loginGoogle(page) {
  await page.goto('https://accounts.google.com/');
  await page.locator('input[type="email"]').fill(GUSER);
  await page.click('#identifierNext');
  await page.waitForTimeout(2000);
  await page.locator('input[type="password"]').fill(GPASS);
  await page.click('#passwordNext');
  await page.waitForLoadState('networkidle');
  await page.context().storageState({ path: STATE_PATH });
}

async function findPhone(page) {
  const title = await page.title();
  const header = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*')).filter(el => {
      const styles = window.getComputedStyle(el);
      return styles.position === 'fixed' || styles.position === 'sticky';
    }).map(el => el.innerText).join("\n");
  });
  const body = await page.evaluate(() => document.body.innerText);
  const allText = `${title}\n${header}\n${body}`;
  const match = allText.match(UK_PHONE_REGEX_GLOBAL) || [];
  return match.find(p => !BLOCKED_SET.has(normalizePhoneForCompare(p))) || "Required";
}

async function findEmail(page) {
  const html = await page.content();
  const emails = html.match(EMAIL_REGEX_GLOBAL) || [];
  const valid = emails.filter(e => !isServiceEmail(e) && !isExcludedEmail(e));
  return valid[0] || "Required";
}

function sendErrorEmail(subject, message) {
  if (!EMAIL_RECIPIENT) return;
  const transporter = nodemailer.createTransport({ sendmail: true });
  transporter.sendMail({ from: 'scraper@adrentleads.com', to: EMAIL_RECIPIENT, subject, text: message });
}

app.post('/run-task', async (req, res) => {
  if (req.headers.authorization?.split(' ')[1] !== API_TOKEN) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { task, url } = req.body;
  if (!task || !url) return res.status(400).json({ error: 'Missing task or URL' });

  const browser = await chromium.launch();
  const context = fs.existsSync(STATE_PATH)
    ? await browser.newContext({ storageState: STATE_PATH })
    : await browser.newContext();

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    if (!fs.existsSync(STATE_PATH) && GUSER && GPASS) await loginGoogle(page);

    const result = { ok: true, sourceUrl: url };
    if (task === 'extract-phone') result.phone = await findPhone(page);
    else if (task === 'extract-email') result.email = await findEmail(page);
    else if (task === 'extract-contact') {
      result.phone = await findPhone(page);
      result.email = await findEmail(page);
      result.ok = result.phone !== 'Required' || result.email !== 'Required';
    }
    else throw new Error(`Unknown task: ${task}`);

    res.json(result);
  } catch (err) {
    sendErrorEmail(`Scraper failed: ${task}`, `${err.message}\n\nURL: ${url}`);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
