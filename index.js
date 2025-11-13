const express = require('express');
const { chromium } = require('playwright');
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
dotenv.config();

const app = express();
app.use(express.json());

const WEBHOOK_URL = 'https://hook.eu2.make.com/53k63zyavw86zmgpf50ilu864ul4zr0b';

async function sendErrorToWebhook(error, context = '', screenshot = null) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      context,
    };
    if (screenshot) {
      payload.screenshot = screenshot;
    }
    await axios.post(WEBHOOK_URL, payload);
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

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    const content = await page.content();
    const phoneRegex = /\b(?:\+44\s?\d{4}|0\d{4}|0\d{3})\s?\d{3}\s?\d{3}\b/g;
    const matches = content.match(phoneRegex) || [];

    const blocklist = [
      "020 3519 9816", "01872 465067", "020 3519 9325", "07491 786550",
      "020 3519 2748", "0247 7411008", "01442935082", "0203 6700435",
      "01726 420021", "01904 378049", "020 3519 9193", "01784 656042",
      "01392 243076", "020 3677 0465", "0203 5193564"
    ];

    const clean = matches.find(m => !blocklist.includes(m));

    if (!clean) {
      throw new Error('Phone number not found or all matches are blocked');
    }

    await browser.close();
    return { phone: clean, screenshot: screenshotBase64 };

  } catch (error) {
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = screenshotBuffer.toString('base64');
    await browser.close();
    await sendErrorToWebhook(error, `Failed to extract contact from URL: ${url}`, screenshotBase64);
    throw error;
  }
}

app.post('/run-task', async (req, res) => {
  const { task, url } = req.body;

  try {
    if (task === 'extract-contact') {
      const result = await extractContact(url);
      await axios.post(WEBHOOK_URL, result);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unsupported task: ${task}` });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
