const express = require('express');
const playwright = require('playwright');

const app = express();
const port = 8080;

app.use(express.json());

const ignoreNumbers = new Set([
  '02035199816', '01872465067', '02035199325', '07491786550',
  '02035192748', '02477411008', '01442935082', '02036700435',
  '01726420021', '01904378049', '02035199193', '01784656042',
  '01392243076', '02036770465', '02035193564'
]);

// Normalize number to digits only for comparison
function normalizeNumber(number) {
  return number.replace(/\D/g, '');
}

app.post('/run-task', async (req, res) => {
  const { task, url } = req.body;

  if (task !== 'extract-contact' || !url) {
    return res.status(400).json({ error: 'Invalid task or URL' });
  }

  let browser;

  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: 'google-state.json',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // wait for content to settle

    const htmlContent = await page.content();

    // Match UK landlines and mobile formats
    const phoneRegex = /\b(?:0\d{9,10})\b/g;
    const foundNumbers = htmlContent.match(phoneRegex) || [];

    // Filter out ignored numbers
    const validNumbers = foundNumbers.filter(num => !ignoreNumbers.has(normalizeNumber(num)));

    if (validNumbers.length > 0) {
      console.log('📞 Valid phone found:', validNumbers[0]);
      res.json({ success: true, phone: validNumbers[0] });
    } else {
      console.log('❌ No valid phone number found.');
      res.json({ success: false, error: 'Phone number not found or excluded.' });
    }

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
