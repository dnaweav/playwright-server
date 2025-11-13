// index.js
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs/promises';

const app = express();
app.use(express.json());

const EXCLUDED_NUMBERS = new Set([
  '02035199816', '01872465067', '02035199325', '07491786550',
  '02035192748', '02477411008', '01442935082', '02036700435',
  '01726420021', '01904378049', '02035199193', '01784656042',
  '01392243076', '02036770465', '02035193564'
]);

const extractPhoneNumber = (text) => {
  const phoneRegex = /\b(?:0|\+44)\s?(?:\d\s?){9,10}\b/g;
  const matches = text.match(phoneRegex)?.map(num => num.replace(/\D/g, '')) || [];
  return matches.find(num => !EXCLUDED_NUMBERS.has(num));
};

app.post('/run-task', async (req, res) => {
  const { task, url } = req.body;
  if (task !== 'extract-contact' || !url) return res.status(400).json({ success: false, error: 'Invalid task or URL' });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000); // allow lazy-loading if any

    const bodyText = await page.textContent('body');
    const phone = extractPhoneNumber(bodyText);

    const screenshotPath = '/tmp/screenshot.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const buffer = await fs.readFile(screenshotPath);
    const base64Image = buffer.toString('base64');

    res.json({ success: true, phone: phone || null, screenshot: `data:image/png;base64,${base64Image}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await browser.close();
  }
});

app.listen(8080, () => console.log('🚀 Server running on port 8080'));
