// capture-state.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false }); // visible
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://accounts.google.com/');

  console.log('Log in to Google in the opened window. When the account page loads, come back here and press Enter.');
  process.stdin.resume();
  process.stdin.on('data', async () => {
    await context.storageState({ path: 'google-state.json' });
    console.log('Saved to google-state.json');
    await browser.close();
    process.exit(0);
  });
})();
