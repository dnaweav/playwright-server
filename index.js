console.log("🚀 Server is starting...");

process.on('uncaughtException', err => {
  console.error("💥 Uncaught Exception:", err);
  sendErrorToWebhook(err, 'Uncaught Exception');
});

process.on('unhandledRejection', err => {
  console.error("❌ Unhandled Rejection:", err);
  sendErrorToWebhook(err, 'Unhandled Rejection');
});

const express = require('express');
const { chromium } = require('playwright');
const dotenv = require('dotenv');
const axios = require('axios');
dotenv.config();

const app = express();
app.use(express.json());

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://hook.eu2.make.com/53k63zyavw86zmgpf50ilu864ul4zr0b';

async function sendErrorToWebhook(error, context = '') {
  try {
    await axios.post(WEBHOOK_URL, {
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      context,
    });
  } catch (err) {
    console.error('Failed to send error to webhook:', err.message);
  }
}

async function extractContact(url) {
  const browser = await chromium.launch({ headless: false }); // Use `false` if testing visually
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(3000); // Optional: allow time for page to fully load

    const number = await page.evaluate(() => {
      const h1s = Array.from(document.querySelectorAll('h1, span, div, header, strong'));
      for (const el of h1s) {
        const match = el.textContent.match(/07\d{3}\s?\d{6}/);
        if (match) return match[0].replace(/\s+/g, '');
      }
      return null;
    });

    const title = await page.title();
    console.log(`📝 Page title: ${title}`);
    if (!number) throw new Error('Phone number not found on the page');

    await browser.close();
    return number;

  } catch (error) {
    await browser.close();
    await sendErrorToWebhook(error, `Failed to extract contact from: ${url}`);
    throw error;
  }
}

app.post('/run-task', async (req, res) => {
  console.log('📩 /run-task received:', JSON.stringify(req.body, null, 2));
  const { task, url } = req.body;

  try {
    if (task === 'extract-contact') {
      console.log(`🔍 Extracting contact from: ${url}`);
      const phone = await extractContact(url);
      return res.status(200).json({ success: true, phone });
    }
    return res.status(400).json({ error: `Unsupported task: ${task}` });

  } catch (error) {
    console.error('🔥 Error in /run-task:', error);
    await sendErrorToWebhook(error, 'run-task');
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
