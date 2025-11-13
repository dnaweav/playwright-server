const express = require("express");
const { chromium } = require("playwright");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
app.use(express.json());

app.post("/run-task", async (req, res) => {
  const { task, url } = req.body;

  if (task === "extract-contact") {
    console.log("📦 Extracting contact from:", url);
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        storageState: "google-state.json",
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });

      const title = await page.title();
      console.log("📄 Page title:", title);

      // More robust: Search all spans for UK phone number pattern
      const phone = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll("span"));
        for (const span of spans) {
          const match = span.textContent.match(/\b07\d{9}\b/); // UK mobile format
          if (match) return match[0];
        }
        return null;
      });

      if (phone) {
        console.log("✅ Found phone:", phone);
        res.json({ success: true, phone });
      } else {
        console.log("❌ Phone number not found.");
        res.json({ success: false, error: "Phone number not found." });
      }
    } catch (error) {
      console.error("❌ Error in /run-task:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (browser) await browser.close();
    }
  } else {
    res.status(400).json({ success: false, error: "Unknown task" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
