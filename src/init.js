#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { PACKAGE_ROOT, ROOT } = require("./lib/config");

async function main() {
  await copyTemplate("lovart.config.json", "lovart.config.json");
  await copyTemplate("prompts.example.json", "prompts.json");
  console.log(`Initialized automatic-lovart files in ${ROOT}`);
}

async function copyTemplate(sourceName, targetName) {
  const sourcePath = path.join(PACKAGE_ROOT, sourceName);
  const targetPath = path.join(ROOT, targetName);

  if (await exists(targetPath)) {
    console.log(`Skipped existing ${targetName}`);
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
  console.log(`Created ${targetName}`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
