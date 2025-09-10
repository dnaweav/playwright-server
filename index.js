const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN;

// Health check
app.get('/', (_, res) => res.send('OK'));

// ✅ POST /run-task (not GET)
app.post('/run-task', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { url, task } = req.body;
  if (!url || !task) return res.status(400).json({ error: 'url and task are required' });

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (task === 'title') {
      const title = await page.title();
      await browser.close();
      return res.json({ title });
    }

    if (task === 'screenshot') {
      await page.screenshot({ path: 'screenshot.png', fullPage: true });
      await browser.close();
      return res.json({ message: 'Screenshot saved', file: 'screenshot.png' });
    }

    await browser.close();
    return res.status(400).json({ error: `Unsupported task: ${task}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
