const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { resolveFromRoot } = require("./config");
const { ensureDir, extensionFor, saveValidatedImage, verifyTaskImages, writeManifest } = require("./imageStore");

class LovartAgent {
  constructor(config) {
    this.config = config;
    this.outputDir = resolveFromRoot(config.outputDir);
  }

  async run(tasks) {
    await ensureDir(this.outputDir);
    const browser = await chromium.launch({
      headless: this.config.headless,
      channel: this.config.browserChannel || undefined,
    });
    const report = {
      startedAt: new Date().toISOString(),
      maxRounds: this.config.maxRounds,
      tasks: [],
    };

    try {
      for (const task of tasks) {
        const result = await this.runTask(browser, task);
        report.tasks.push(result);
        await this.writeReport(report);
      }
    } finally {
      await browser.close();
      report.finishedAt = new Date().toISOString();
      await this.writeReport(report);
    }

    return report;
  }

  async runTask(browser, task) {
    const taskDir = path.join(this.outputDir, task.id);
    await ensureDir(taskDir);

    const contextOptions = { acceptDownloads: true };
    const storageStatePath = resolveFromRoot(this.config.storageStatePath);
    if (await exists(storageStatePath)) {
      contextOptions.storageState = storageStatePath;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.promptSubmitTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    const taskLog = {
      id: task.id,
      originalId: task.originalId,
      status: "running",
      rounds: 0,
      images: [],
      startedAt: new Date().toISOString(),
    };

    try {
      await page.goto(this.config.lovartUrl, { waitUntil: "domcontentloaded" });
      page = await this.enterWorkspace(context, page);

      const baseline = await collectImageFingerprints(page);
      const canvasBaseline = await collectCanvasFingerprints(page);
      const firstPrompt = buildInitialPrompt(task.prompt);
      await this.sendMessage(page, firstPrompt);
      taskLog.rounds = 1;

      while (taskLog.rounds <= this.config.maxRounds) {
        const images = await this.waitForGeneratedImages(page, context, task, taskDir, baseline, canvasBaseline, taskLog.images.length);
        if (images.length > 0) {
          taskLog.images.push(...images);
          taskLog.verifiedImages = await verifyTaskImages(taskDir, this.config.minImageBytes);
          if (taskLog.verifiedImages.length === 0) {
            taskLog.status = "failed";
            taskLog.error = "Image was detected in the page but no valid image file was verified on disk.";
            taskLog.finishedAt = new Date().toISOString();
            await writeManifest(taskDir, taskLog);
            await context.close();
            return taskLog;
          }
          taskLog.status = "success";
          taskLog.finishedAt = new Date().toISOString();
          await writeManifest(taskDir, taskLog);
          await context.close();
          return taskLog;
        }

        if (taskLog.rounds >= this.config.maxRounds) {
          break;
        }

        const responseText = await this.readRecentLovartText(page);
        const followUp = buildFollowUpPrompt(task, responseText, taskLog.rounds, this.config);
        await this.sendMessage(page, followUp);
        taskLog.rounds += 1;
      }

      taskLog.status = "failed";
      taskLog.error = `No generated image was detected within ${this.config.maxRounds} rounds.`;
      taskLog.finishedAt = new Date().toISOString();
      await page.screenshot({ path: path.join(taskDir, "failure-page.png"), fullPage: true }).catch(() => {});
      await writeManifest(taskDir, taskLog);
      await context.close();
      return taskLog;
    } catch (error) {
      taskLog.status = "failed";
      taskLog.error = error.message;
      taskLog.finishedAt = new Date().toISOString();
      await page.screenshot({ path: path.join(taskDir, "failure-page.png"), fullPage: true }).catch(() => {});
      await writeManifest(taskDir, taskLog).catch(() => {});
      await context.close();
      return taskLog;
    }
  }

  async enterWorkspace(context, page) {
    if (await this.hasPromptInput(page, 5000)) {
      return page;
    }

    const selectors = this.config.selectors.entryButtons || [];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await isVisible(locator, 1500))) continue;

      const newPagePromise = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
      await locator.click().catch(() => {});
      const newPage = await newPagePromise;
      if (newPage) {
        await newPage.waitForLoadState("domcontentloaded").catch(() => {});
        page = newPage;
      } else {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }

      if (await this.hasPromptInput(page, 15000)) {
        return page;
      }
    }

    if (!(await this.hasPromptInput(page, 15000))) {
      throw new Error("Could not find Lovart prompt input. Run npm run auth first or update selectors/lovartUrl.");
    }

    return page;
  }

  async hasPromptInput(page, timeoutMs) {
    return Boolean(await findFirstVisible(page, this.config.selectors.promptInputs || [], timeoutMs));
  }

  async sendMessage(page, message) {
    const input = await findFirstVisible(page, this.config.selectors.promptInputs || [], this.config.promptSubmitTimeoutMs);
    if (!input) {
      throw new Error("Prompt input was not found.");
    }

    await input.click();
    const tagName = await input.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    const isContentEditable = await input.evaluate((node) => node.isContentEditable).catch(() => false);

    if (tagName === "textarea" || tagName === "input") {
      await input.fill(message);
    } else if (isContentEditable) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.insertText(message);
    } else {
      await input.fill(message).catch(async () => {
        await page.keyboard.insertText(message);
      });
    }

    const submittedByButton = await this.clickSubmitButton(page);
    if (!submittedByButton) {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(1500);
  }

  async clickSubmitButton(page) {
    const selectors = this.config.selectors.submitButtons || [];
    for (const selector of selectors) {
      const button = page.locator(selector).last();
      if (!(await isVisible(button, 1000))) continue;
      const disabled = await button.evaluate((node) => node.disabled || node.getAttribute("aria-disabled") === "true").catch(() => false);
      if (disabled) continue;
      await button.click().catch(() => {});
      return true;
    }
    return false;
  }

  async waitForGeneratedImages(page, context, task, taskDir, baseline, canvasBaseline, existingCount) {
    const deadline = Date.now() + this.config.generationWaitMs;
    const saved = [];
    const seen = new Set();

    while (Date.now() < deadline) {
      const candidates = await collectImageCandidates(page, this.config.minImageEdgePx);
      const fresh = candidates.filter((candidate) => {
        if (!candidate.fingerprint || baseline.has(candidate.fingerprint) || seen.has(candidate.fingerprint)) {
          return false;
        }
        seen.add(candidate.fingerprint);
        return true;
      });

      for (const candidate of fresh) {
        const image = await this.saveCandidate(page, context, candidate, taskDir, task.id, existingCount + saved.length + 1);
        if (image) {
          saved.push(image);
        }
      }

      const canvasImages = await this.saveNewCanvasScreenshots(page, canvasBaseline, taskDir, task.id, existingCount + saved.length + 1);
      saved.push(...canvasImages);

      if (saved.length > 0) {
        return saved;
      }

      await page.waitForTimeout(this.config.pollIntervalMs);
    }

    return [];
  }

  async saveCandidate(page, context, candidate, taskDir, taskId, index) {
    try {
      let buffer;
      let contentType = candidate.contentType || "";

      if (candidate.src.startsWith("data:")) {
        const parsed = parseDataUrl(candidate.src);
        if (!parsed) return null;
        buffer = parsed.buffer;
        contentType = parsed.contentType;
      } else if (candidate.src.startsWith("blob:")) {
        const blob = await page.evaluate(async (url) => {
          const response = await fetch(url);
          const data = await response.arrayBuffer();
          return {
            contentType: response.headers.get("content-type") || "",
            base64: btoa(String.fromCharCode(...new Uint8Array(data))),
          };
        }, candidate.src);
        buffer = Buffer.from(blob.base64, "base64");
        contentType = blob.contentType;
      } else {
        const response = await context.request.get(candidate.src, {
          headers: { referer: this.config.lovartUrl },
          timeout: this.config.promptSubmitTimeoutMs,
        });
        if (!response.ok()) return null;
        contentType = response.headers()["content-type"] || "";
        buffer = await response.body();
      }

      return await saveValidatedImage({
        buffer,
        taskDir,
        taskId,
        index,
        minImageBytes: this.config.minImageBytes,
        preferredExtension: extensionFor(contentType, candidate.src),
        source: {
          type: candidate.kind || "image",
          url: candidate.src.startsWith("data:") ? "data-url" : candidate.src,
          alt: candidate.alt,
          width: candidate.naturalWidth,
          height: candidate.naturalHeight,
        },
      });
    } catch (_) {
      return null;
    }
  }

  async saveNewCanvasScreenshots(page, canvasBaseline, taskDir, taskId, startIndex) {
    const saved = [];
    const canvases = page.locator("canvas");
    const count = await canvases.count().catch(() => 0);

    for (let i = 0; i < count; i += 1) {
      const canvas = canvases.nth(i);
      if (!(await isVisible(canvas, 200))) continue;
      const box = await canvas.boundingBox().catch(() => null);
      if (!box || box.width < this.config.minImageEdgePx || box.height < this.config.minImageEdgePx) continue;

      const buffer = await canvas.screenshot({ type: "png" }).catch(() => null);
      const fingerprint = hashBuffer(buffer);
      if (!fingerprint || canvasBaseline.has(fingerprint)) continue;
      canvasBaseline.add(fingerprint);

      const image = await saveValidatedImage({
        buffer,
        taskDir,
        taskId,
        index: startIndex + saved.length,
        minImageBytes: this.config.minImageBytes,
        preferredExtension: ".png",
        source: {
          type: "canvas-screenshot",
          url: "visible-canvas",
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
      });
      if (image) saved.push(image);
    }

    return saved;
  }

  async readRecentLovartText(page) {
    const selectors = this.config.selectors.assistantMessages || [];
    for (const selector of selectors) {
      const locators = page.locator(selector);
      const count = await locators.count().catch(() => 0);
      if (count === 0) continue;
      const text = await locators.nth(count - 1).innerText({ timeout: 1000 }).catch(() => "");
      if (text.trim()) return text.trim().slice(-2000);
    }
    const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    return body.trim().slice(-2000);
  }

  async writeReport(report) {
    await fs.writeFile(resolveFromRoot("run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function findFirstVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).last();
      if (await isVisible(locator, 500)) {
        return locator;
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function isVisible(locator, timeoutMs) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

async function collectImageFingerprints(page) {
  const candidates = await collectImageCandidates(page, 1);
  return new Set(candidates.map((candidate) => candidate.fingerprint).filter(Boolean));
}

async function collectCanvasFingerprints(page) {
  const fingerprints = new Set();
  const canvases = page.locator("canvas");
  const count = await canvases.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const canvas = canvases.nth(i);
    if (!(await isVisible(canvas, 200))) continue;
    const buffer = await canvas.screenshot({ type: "png" }).catch(() => null);
    const fingerprint = hashBuffer(buffer);
    if (fingerprint) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

function hashBuffer(buffer) {
  if (!buffer || buffer.length === 0) return "";
  let hash = 2166136261;
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${hash >>> 0}:${buffer.length}`;
}

async function collectImageCandidates(page, minEdgePx) {
  return await page.evaluate((minEdge) => {
    function absoluteUrl(value) {
      try {
        return new URL(value, window.location.href).href;
      } catch (_) {
        return "";
      }
    }

    function cleanBackgroundUrl(value) {
      const match = /url\(["']?(.+?)["']?\)/.exec(value || "");
      return match ? absoluteUrl(match[1]) : "";
    }

    const candidates = [];
    for (const img of Array.from(document.images)) {
      const rect = img.getBoundingClientRect();
      const src = absoluteUrl(img.currentSrc || img.src || "");
      const naturalWidth = img.naturalWidth || Math.round(rect.width);
      const naturalHeight = img.naturalHeight || Math.round(rect.height);
      if (!src || Math.max(naturalWidth, naturalHeight, rect.width, rect.height) < minEdge) continue;
      if (/\.svg(\?|#|$)/i.test(src)) continue;
      candidates.push({
        kind: "img",
        src,
        alt: img.alt || "",
        naturalWidth,
        naturalHeight,
        fingerprint: `img:${src}`,
      });
    }

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = absoluteUrl(anchor.getAttribute("href"));
      if (!/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(href) && !/assets|image|download|lovart/i.test(href)) continue;
      const rect = anchor.getBoundingClientRect();
      candidates.push({
        kind: "link",
        src: href,
        alt: anchor.textContent || "",
        naturalWidth: Math.round(rect.width),
        naturalHeight: Math.round(rect.height),
        fingerprint: `link:${href}`,
      });
    }

    for (const node of Array.from(document.querySelectorAll("*"))) {
      const rect = node.getBoundingClientRect();
      if (Math.max(rect.width, rect.height) < minEdge) continue;
      const bg = cleanBackgroundUrl(getComputedStyle(node).backgroundImage);
      if (!bg || /\.svg(\?|#|$)/i.test(bg)) continue;
      candidates.push({
        kind: "background",
        src: bg,
        alt: "",
        naturalWidth: Math.round(rect.width),
        naturalHeight: Math.round(rect.height),
        fingerprint: `background:${bg}`,
      });
    }

    return candidates;
  }, minEdgePx);
}

function buildInitialPrompt(prompt) {
  return [
    prompt.trim(),
    "",
    "Important constraints for this automated run:",
    "- Generate the final image directly unless a clarification is absolutely required.",
    "- Make the generated image visible and downloadable in this conversation.",
  ].join("\n");
}

function buildFollowUpPrompt(task, responseText, round, config) {
  const base = task.followUpPrompt || config.followUpPrompt;
  return [
    base,
    "",
    `Original request: ${task.prompt}`,
    `This is automated round ${round + 1} of ${config.maxRounds}; the final image must be produced no later than this round.`,
    responseText ? `Latest Lovart response summary: ${responseText.slice(-800)}` : "",
  ].filter(Boolean).join("\n");
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";
  return {
    contentType,
    buffer: isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8"),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  LovartAgent,
};
