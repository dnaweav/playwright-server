import express from "express";
import playwright from "playwright";
import fs from "fs/promises";

const app = express();
app.use(express.json());

const EXCLUDED_NUMBERS = [
  "02035199816", "01872465067", "02035199325", "07491786550", "02035192748",
  "02477411008", "01442935082", "02036700435", "01726420021", "01904378049",
  "02035199193", "01784656042", "01392243076", "02036770465", "02035193564"
];

function normalizeNumber(number) {
  return number.replace(/\D/g, ""); // remove non-digits
}

function isExcluded(number) {
  const normalized = normalizeNumber(number);
  return EXCLUDED_NUMBERS.includes(normalized);
}

function extractPhoneNumbers(text) {
  const regex = /(?:\+44\s?7\d{3}|\(?0\d{2,4}\)?)\s?\d{3,4}\s?\d{3,4}/g;
  return (text.match(regex) || []).map(num => num.trim());
}

app.post("/run-task", async (req, res) => {
  const { task, url } = req.body;
  if (task !== "extract-contact" || !url) {
    return res.status(400).json({ success: false, error: "Invalid input." });
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: "./google-state.json"
  });
  const page = await context.newPage();

  try {
    console.log(`🔍 Extracting contact from: ${url}`);
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000); // let dynamic scripts render

    const content = await page.content();

    const foundNumbers = extractPhoneNumbers(content);
    const validNumbers = foundNumbers.filter(num => !isExcluded(num));

    if (validNumbers.length > 0) {
      const phone = validNumbers[0];
      console.log(`📞 Valid phone found: ${phone}`);
      return res.json({ success: true, phone });
    } else {
      console.error("❌ No valid phone number found.");
      return res.json({ success: false, error: "Phone number not found or excluded." });
    }
  } catch (error) {
    console.error("❌ Extraction error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
