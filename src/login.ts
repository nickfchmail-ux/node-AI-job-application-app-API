/**
 * Run this ONCE to log in to JobsDB in a real visible browser.
 * It waits for you to complete login, then saves the session to
 * browser-state.json so enrichJobs.ts can reuse it without logging in again.
 *
 * Usage:  npm run login
 */
import * as path from "path";
import { chromium } from "playwright";

const STATE_FILE = path.join(process.cwd(), "browser-state.json");

async function main(): Promise<void> {
  console.log("Opening browser — please log in to JobsDB HK...");
  console.log("The window will close automatically once login is detected.\n");

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome", // use the real installed Chrome, not Playwright's Chromium
    args: ["--start-maximized"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: null,
  });

  const page = await context.newPage();
  await page.goto("https://hk.jobsdb.com/login", {
    waitUntil: "domcontentloaded",
  });

  console.log("Waiting for you to log in (up to 5 minutes)...");

  await page.waitForFunction(
    () => {
      const html = document.documentElement.innerHTML;
      return (
        html.includes("Sign out") ||
        html.includes("My account") ||
        html.includes("My Profile") ||
        document.querySelector("[data-automation='account-menu']") !== null ||
        document.querySelector("[aria-label='My account']") !== null
      );
    },
    { timeout: 5 * 60 * 1000, polling: 2000 },
  );

  console.log("✅ Logged in! Saving session...");
  await context.storageState({ path: STATE_FILE });
  console.log(`Session saved to: ${STATE_FILE}`);
  console.log("You can now run:  npm run enrich\n");

  await browser.close();
}

main().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
