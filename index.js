const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());

app.post("/run-task", async (req, res) => {
  const { task, url } = req.body;

  if (task !== "extract-contact" || !url) {
    return res.status(400).json({ error: "Invalid task or missing URL." });
  }

  try {
    console.log("🧠 Task: extract-contact");
    console.log("🔗 URL:", url);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: "./google-state.json", // <-- Load session
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const title = await page.title();
    console.log("📝 Page title:", title);

    const pageContent = await page.content();
    const phoneMatch = pageContent.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,5}[-.\s]?\d{4}/);

    if (phoneMatch) {
      console.log("✅ Found phone:", phoneMatch[0]);
      res.json({ success: true, phone: phoneMatch[0] });
    } else {
      console.log("❌ No phone number found.");
      res.json({ success: false, message: "No phone number found." });
    }

    await browser.close();
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
