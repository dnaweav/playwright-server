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

    const content = await page.content();

    const number = await page.evaluate(() => {
      const span = [...document.querySelectorAll('span')]
        .find(el => /\d{5}\s?\d{6}/.test(el.textContent));
      return span ? span.textContent.trim() : null;
    });

    if (!number) {
      throw new Error('Phone number not found on the page');
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

  try {
    if (task === 'extract-contact') {
      const result = await extractContact(url);
      return res.status(200).json({ success: true, phone: result });
    }

    return res.status(400).json({ error: `Unsupported task: ${task}` });

  } catch (error) {
    await sendErrorToWebhook(error, `Failed /run-task with task: ${task}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
