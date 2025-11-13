// login-state.js
const { chromium } = require('playwright');
(async () => {
  const context = await chromium.launchPersistentContext('chrome-profile', {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    // reduce automation signal
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });
  console.log('Log in fully in the Chrome window, then press Enter here...');
  process.stdin.once('data', async () => {
    await context.storageState({ path: 'google-state.json' });
    console.log('Saved google-state.json');
    await context.close();
    process.exit(0);
  });
})();
