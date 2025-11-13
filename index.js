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

const WEBHOOK_URL = 'https://hook.eu2.make.com/53k63zyavw86zmgpf50ilu864ul4zr0b';

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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { timeout: 60000 });
    await page.waitForLoadState('networkidle');

    // Try to wait for phone number UI to appear
    await page.waitForTimeout(1000);

    const fullText = await page.evaluate(() => document.body.innerText);
    console.log("🧾 Full page text:", fullText);

    const match = fullText.match(/\b(?:\+44\s?\d{4,5}\s?\d{5,6}|07\d{9}|01\d{9}|02\d{9})\b/);
    const number = match ? match[0] : null;

    if (!number) {
      throw new Error('Phone number not found in page text');
    }

    await browser.close();
    return number;

  } catch (error) {
    await browser.close();
    await sendErrorToWebhook(error, `Failed to extract contact from URL: ${url}`);
    throw error;
  }
}

app.post('/run-task', async (req, res) => {
  const { task, url } = req.body;
  console.log('📩 /run-task received:', JSON.stringify(req.body, null, 2));

  try {
    if (task === 'extract-contact') {
      console.log(`🔍 Extracting contact from: ${url}`);
      const result = await extractContact(url);
      return res.status(200).json({ success: true, phone: result });
    }

    throw new Error('❌ Invalid task or missing URL');

  } catch (error) {
    console.error('🔥 Error in /run-task:', error.message);
    await sendErrorToWebhook(error, 'run-task');
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
