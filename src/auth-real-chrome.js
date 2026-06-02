const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const { stdin: input, stdout: output } = require("node:process");
const WebSocket = require("ws");
const { loadConfig, resolveFromRoot } = require("./lib/config");

async function main() {
  const config = await loadConfig();
  const storagePath = resolveFromRoot(config.storageStatePath);
  const userDataDir = resolveFromRoot(config.realChromeUserDataDir || "./.auth/real-chrome-profile");
  const port = Number(config.realChromeDebugPort || 9222);

  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.mkdir(userDataDir, { recursive: true });

  const chromePath = await findChromeExecutable();
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    config.lovartUrl,
  ], {
    detached: true,
    stdio: "ignore",
  });
  chrome.unref();

  console.log("Opened Lovart in your installed Google Chrome, not Chrome for Testing.");
  console.log("Log in with Google there. When the Lovart workspace/chat page is usable, return here and press Enter.");

  await waitForCdp(port, 30000);

  const rl = readline.createInterface({ input, output });
  await rl.question("");
  rl.close();

  const storageState = await collectStorageState(port, config.lovartUrl);
  await fs.writeFile(storagePath, `${JSON.stringify(storageState, null, 2)}\n`);
  console.log(`Saved Lovart storage state to ${storagePath}`);
}

async function findChromeExecutable() {
  if (process.env.CHROME_PATH) {
    await fs.access(process.env.CHROME_PATH);
    return process.env.CHROME_PATH;
  }

  const home = process.env.HOME || "";
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    path.join(home, "Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
    path.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_) {
      // Try the next known macOS Chrome location.
    }
  }

  throw new Error("Google Chrome was not found. Set CHROME_PATH to your Chrome executable path, for example: CHROME_PATH=\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" npm run auth:chrome");
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (_) {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Could not connect to Chrome remote debugging on port ${port}.`);
}

async function collectStorageState(port, lovartUrl) {
  const pageTarget = await pickLovartTarget(port, lovartUrl);
  const client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);

  try {
    await client.send("Runtime.enable");
    await client.send("Network.enable");
    const cookieResult = await client.send("Network.getAllCookies");
    const origin = new URL(lovartUrl).origin;
    const storageResult = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const localStorageItems = [];
        const sessionStorageItems = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const name = localStorage.key(i);
          localStorageItems.push({ name, value: localStorage.getItem(name) });
        }
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const name = sessionStorage.key(i);
          sessionStorageItems.push({ name, value: sessionStorage.getItem(name) });
        }
        return { localStorageItems, sessionStorageItems, href: location.href };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });

    const pageStorage = storageResult.result && storageResult.result.value
      ? storageResult.result.value
      : { localStorageItems: [], sessionStorageItems: [] };

    return {
      cookies: normalizeCookies(cookieResult.cookies || []),
      origins: [
        {
          origin,
          localStorage: pageStorage.localStorageItems || [],
          sessionStorage: pageStorage.sessionStorageItems || [],
        },
      ],
    };
  } finally {
    client.close();
  }
}

async function pickLovartTarget(port, lovartUrl) {
  const lovartHost = new URL(lovartUrl).host;
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);

  for (const target of targets) {
    try {
      if (target.type === "page" && new URL(target.url).host === lovartHost && target.webSocketDebuggerUrl) {
        return target;
      }
    } catch (_) {
      // Ignore blank and extension pages.
    }
  }

  const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (pageTargets.length > 0) {
    throw new Error(`Could not find an open Lovart tab on ${lovartHost}. Current page URLs: ${pageTargets.map((target) => target.url).join(", ")}`);
  }

  throw new Error("Could not find any debuggable Chrome page target.");
}

function normalizeCookies(cookies) {
  return cookies.map((cookie) => {
    const normalized = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: typeof cookie.expires === "number" ? cookie.expires : -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: normalizeSameSite(cookie.sameSite),
    };

    return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
  });
}

function normalizeSameSite(value) {
  if (!value) return undefined;
  const normalized = String(value).toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "lax") return "Lax";
  if (normalized === "none" || normalized === "no_restriction") return "None";
  return undefined;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return await response.json();
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message || "CDP error"}${message.error.data ? `: ${message.error.data}` : ""}`));
      } else {
        resolve(message.result || {});
      }
    });

    ws.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP websocket closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  collectStorageState,
  findChromeExecutable,
};
