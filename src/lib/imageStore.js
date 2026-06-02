const fs = require("node:fs/promises");
const path = require("node:path");

const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: true, extension: ".png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, extension: ".jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { ok: true, extension: ".webp", mime: "image/webp" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return { ok: true, extension: ".gif", mime: "image/gif" };
  }
  return { ok: false };
}

function extensionFor(contentType, fallbackUrl) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_EXTENSIONS[mime]) return IMAGE_EXTENSIONS[mime];
  try {
    const pathname = new URL(fallbackUrl).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch (_) {
    // Ignore malformed URLs and fall through to validation.
  }
  return "";
}

async function saveValidatedImage({ buffer, taskDir, taskId, index, source, minImageBytes, preferredExtension }) {
  if (!buffer || buffer.length < minImageBytes) {
    return null;
  }

  const detected = detectImage(buffer);
  if (!detected.ok) {
    return null;
  }

  const extension = preferredExtension || detected.extension;
  const fileName = `${taskId}_${String(index).padStart(3, "0")}${extension}`;
  const filePath = path.join(taskDir, fileName);
  await fs.writeFile(filePath, buffer);

  return {
    filePath,
    fileName,
    bytes: buffer.length,
    mime: detected.mime,
    source,
  };
}

async function writeManifest(taskDir, manifest) {
  await fs.writeFile(path.join(taskDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function verifyTaskImages(taskDir, minImageBytes) {
  const entries = await fs.readdir(taskDir, { withFileTypes: true }).catch(() => []);
  const images = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) continue;

    const filePath = path.join(taskDir, entry.name);
    const buffer = await fs.readFile(filePath).catch(() => null);
    if (!buffer || buffer.length < minImageBytes) continue;

    const detected = detectImage(buffer);
    if (!detected.ok) continue;

    images.push({
      filePath,
      fileName: entry.name,
      bytes: buffer.length,
      mime: detected.mime,
    });
  }

  return images.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

module.exports = {
  ensureDir,
  extensionFor,
  saveValidatedImage,
  verifyTaskImages,
  writeManifest,
};
