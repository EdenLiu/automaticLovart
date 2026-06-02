const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { chromium } = require("playwright");
const { loadConfig, resolveFromRoot } = require("./lib/config");

async function main() {
  const config = await loadConfig();
  const storagePath = resolveFromRoot(config.storageStatePath);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  await page.goto(config.lovartUrl, { waitUntil: "domcontentloaded" });

  console.log("Lovart has opened in a browser window.");
  console.log("Log in manually. When the workspace/chat page is usable, return here and press Enter.");

  const rl = readline.createInterface({ input, output });
  await rl.question("");
  rl.close();

  await context.storageState({ path: storagePath });
  await browser.close();
  console.log(`Saved Lovart storage state to ${storagePath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
