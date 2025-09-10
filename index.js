const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const API_TOKEN = 'Fudg3Acc0unt#!'; // 🔐 Change this to your own password

app.post('/run-task', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { url, task } = req.body;

  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);

    if (task === 'screenshot') {
      await page.screenshot({ path: 'screenshot.png', fullPage: true });
      await browser.close();
      return res.json({ message: 'Screenshot saved!' });
    }

    if (task === 'title') {
      const title = await page.title();
      await browser.close();
      return res.json({ title });
    }

    await browser.close();
    res.json({ message: 'Done, but task unknown' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});
