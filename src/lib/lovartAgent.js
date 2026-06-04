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
    let page = await context.newPage();
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
      page = await this.sendMessage(context, page, firstPrompt);
      await this.waitBeforeImageScan(page);
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
        page = await this.sendMessage(context, page, followUp);
        await this.waitBeforeImageScan(page);
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
    return Boolean(await findPromptInput(page, this.config.selectors.promptInputs || [], timeoutMs));
  }

  async sendMessage(context, page, message) {
    const input = await findPromptInput(page, this.config.selectors.promptInputs || [], this.config.promptSubmitTimeoutMs);
    if (!input) {
      throw new Error("Prompt input was not found.");
    }

    await writePromptText(page, input, message);

    const submittedByButton = await this.clickSubmitButton(page, input);
    if (!submittedByButton) {
      await page.keyboard.press("Enter");
    }

    page = await this.waitForCanvasPage(context, page, this.config.postSubmitNavigationTimeoutMs || this.config.promptSubmitTimeoutMs);
    await page.waitForTimeout(1500);
    return page;
  }

  async waitForCanvasPage(context, page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const canvasPage = context.pages().find((candidate) => isLovartCanvasUrl(candidate.url()));
      if (canvasPage) {
        await canvasPage.waitForLoadState("domcontentloaded").catch(() => {});
        return canvasPage;
      }
      if (isLovartCanvasUrl(page.url())) {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return page;
      }
      await page.waitForTimeout(500);
    }

    return page;
  }

  async waitBeforeImageScan(page) {
    const waitMs = Number(this.config.canvasGenerationMinWaitMs || 0);
    if (waitMs > 0 && isLovartCanvasUrl(page.url())) {
      await page.waitForTimeout(waitMs);
    }
  }

  async clickSubmitButton(page, input) {
    const selectors = this.config.selectors.submitButtons || [];
    for (const selector of selectors) {
      const button = page.locator(selector).last();
      if (!(await isVisible(button, 1000))) continue;
      const disabled = await button.evaluate((node) => node.disabled || node.getAttribute("aria-disabled") === "true").catch(() => false);
      if (disabled) continue;
      try {
        await button.click();
        return true;
      } catch (_) {
        continue;
      }
    }

    const nearbyButton = await findNearbySubmitButton(page, input);
    if (nearbyButton) {
      try {
        await nearbyButton.click();
        return true;
      } catch (_) {
        return false;
      }
    }

    return false;
  }

  async waitForGeneratedImages(page, context, task, taskDir, baseline, canvasBaseline, existingCount) {
    const deadline = Date.now() + this.config.generationWaitMs;
    const saved = [];
    const seen = new Set();

    while (Date.now() < deadline) {
      const candidates = await collectImageCandidates(page, this.config.minImageEdgePx);
      const generatedCandidates = candidates.filter((candidate) => isGeneratedImageCandidate(candidate, this.config));
      const fresh = generatedCandidates.filter((candidate) => {
        return candidate.fingerprint && !baseline.has(candidate.fingerprint) && !seen.has(candidate.fingerprint);
      });
      const bestCandidates = selectBestGeneratedCandidates(fresh);

      for (const candidate of bestCandidates) {
        const image = await this.saveCandidate(page, context, candidate, taskDir, task.id, existingCount + saved.length + 1);
        if (image) {
          seen.add(candidate.fingerprint);
          saved.push(image);
        }
      }

      if (this.config.captureCanvasScreenshots) {
        const canvasImages = await this.saveNewCanvasScreenshots(page, canvasBaseline, taskDir, task.id, existingCount + saved.length + 1);
        saved.push(...canvasImages);
      }

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
        if (!parsed) return await this.saveCandidateScreenshot(page, candidate, taskDir, taskId, index);
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
        if (!response.ok()) return await this.saveCandidateScreenshot(page, candidate, taskDir, taskId, index);
        contentType = response.headers()["content-type"] || "";
        buffer = await response.body();
      }

      const image = await saveValidatedImage({
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
      if (image) return image;

      return await this.saveCandidateScreenshot(page, candidate, taskDir, taskId, index);
    } catch (_) {
      return await this.saveCandidateScreenshot(page, candidate, taskDir, taskId, index);
    }
  }

  async saveCandidateScreenshot(page, candidate, taskDir, taskId, index) {
    if (!candidate.domId) return null;

    const locator = page.locator(`[data-lovart-agent-image-id="${candidate.domId}"]`).first();
    if (!(await isVisible(locator, 500))) return null;

    const box = await locator.boundingBox().catch(() => null);
    if (!box || Math.max(box.width, box.height) < this.config.minImageEdgePx) return null;

    const buffer = await locator.screenshot({ type: "png" }).catch(() => null);
    return await saveValidatedImage({
      buffer,
      taskDir,
      taskId,
      index,
      minImageBytes: this.config.minImageBytes,
      preferredExtension: ".png",
      source: {
        type: `${candidate.kind || "image"}-element-screenshot`,
        url: candidate.src?.startsWith("data:") ? "data-url" : candidate.src,
        alt: candidate.alt,
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    });
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

async function findPromptInput(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locators = page.locator(selector);
      const count = await locators.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i -= 1) {
        const locator = locators.nth(i);
        const details = await locator.evaluate((node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const tagName = node.tagName.toLowerCase();
          const role = node.getAttribute("role") || "";
          const disabled = Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true";
          const readOnly = Boolean(node.readOnly) || node.getAttribute("aria-readonly") === "true";
          const visible = style.visibility !== "hidden"
            && style.display !== "none"
            && Number(style.opacity || 1) !== 0
            && rect.width >= 120
            && rect.height >= 24;
          const editable = !disabled
            && !readOnly
            && (tagName === "textarea"
              || tagName === "input"
              || node.isContentEditable
              || role === "textbox");

          return {
            editable,
            visible,
          };
        }).catch(() => null);

        if (details?.visible && details.editable) {
          return locator;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function writePromptText(page, input, message) {
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ force: true });

  const tagName = await input.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  const isFormInput = tagName === "textarea" || tagName === "input";

  if (isFormInput) {
    await input.fill(message);
  } else {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.insertText(message);
  }

  if (await promptContainsText(input, message)) {
    return;
  }

  await input.evaluate((node, value) => {
    node.focus();
    const tagName = node.tagName.toLowerCase();
    if (tagName === "textarea" || tagName === "input") {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
      if (descriptor?.set) {
        descriptor.set.call(node, value);
      } else {
        node.value = value;
      }
    } else {
      node.textContent = value;
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, message);

  if (!(await promptContainsText(input, message))) {
    throw new Error("Prompt input was found, but the prompt text could not be written.");
  }
}

async function promptContainsText(input, message) {
  const expected = normalizePromptText(message).slice(0, 120);
  if (!expected) return true;

  const actual = await input.evaluate((node) => {
    const tagName = node.tagName.toLowerCase();
    if (tagName === "textarea" || tagName === "input") {
      return node.value || "";
    }
    return node.innerText || node.textContent || "";
  }).catch(() => "");

  return normalizePromptText(actual).includes(expected);
}

function normalizePromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isLovartCanvasUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("lovart.ai") && url.pathname === "/canvas" && url.searchParams.has("projectId");
  } catch (_) {
    return false;
  }
}

function isGeneratedImageCandidate(candidate, config) {
  const src = candidate?.src || "";
  if (!src || isIgnoredImageUrl(src, config)) return false;
  try {
    const url = new URL(src);
    return url.hostname === "a.lovart.ai" && url.pathname.startsWith("/artifacts/agent/");
  } catch (_) {
    return false;
  }
}

function isIgnoredImageUrl(src, config) {
  const ignored = config.ignoredImageUrls || [];
  return ignored.some((value) => src === value || src.includes(value) || value.includes(src))
    || /\/lovart_assets\/loading[^/]*\.gif/i.test(src);
}

function selectBestGeneratedCandidates(candidates) {
  if (candidates.length <= 1) return candidates;

  const sorted = [...candidates].sort((a, b) => imageCandidateScore(b) - imageCandidateScore(a));
  return [sorted[0]];
}

function imageCandidateScore(candidate) {
  const src = candidate?.src || "";
  const widthMatch = /[?&,]w_(\d+)/i.exec(src);
  const resizedWidth = widthMatch ? Number(widthMatch[1]) : 0;
  const isOriginalArtifact = /^https:\/\/a\.lovart\.ai\/artifacts\/agent\/[^?]+$/i.test(src);
  if (isOriginalArtifact) return 100000;
  return Math.max(resizedWidth, Number(candidate?.naturalWidth || 0), Number(candidate?.naturalHeight || 0));
}

async function findNearbySubmitButton(page, input) {
  const inputBox = await input.boundingBox().catch(() => null);
  if (!inputBox) return null;

  const buttons = page.locator("button");
  const count = await buttons.count().catch(() => 0);
  let best = null;

  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const details = await button.evaluate((node, box) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const disabled = Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true";
      const visible = style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity || 1) !== 0
        && rect.width >= 20
        && rect.height >= 20;
      const inputRight = box.x + box.width;
      const inputBottom = box.y + box.height;
      const inPromptRegion = rect.left >= box.x - 24
        && rect.right <= inputRight + 24
        && rect.top >= box.y - 8
        && rect.bottom <= inputBottom + 80;
      const nearBottomRight = rect.left >= inputRight - 140
        && rect.top >= inputBottom - 16
        && rect.bottom <= inputBottom + 80;
      const label = [
        node.getAttribute("aria-label") || "",
        node.getAttribute("title") || "",
        node.textContent || "",
      ].join(" ");
      const likelySubmit = /send|submit|generate|create|arrow|发送|提交|生成|创建/i.test(label)
        || (inPromptRegion && nearBottomRight);

      return {
        disabled,
        visible,
        likelySubmit,
        distance: Math.abs(inputRight - rect.right) + Math.abs(inputBottom - rect.bottom),
      };
    }, inputBox).catch(() => null);

    if (!details?.visible || details.disabled || !details.likelySubmit) continue;
    if (!best || details.distance < best.distance) {
      best = { locator: button, distance: details.distance };
    }
  }

  return best?.locator || null;
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

    function markCandidateNode(node) {
      if (!window.__lovartAgentImageId) {
        window.__lovartAgentImageId = 1;
      }
      if (!node.dataset.lovartAgentImageId) {
        node.dataset.lovartAgentImageId = `candidate-${window.__lovartAgentImageId}`;
        window.__lovartAgentImageId += 1;
      }
      return node.dataset.lovartAgentImageId;
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
        domId: markCandidateNode(img),
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
        domId: markCandidateNode(anchor),
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
        domId: markCandidateNode(node),
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
