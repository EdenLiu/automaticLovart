const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function resolveFromRoot(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

async function readJson(filePath) {
  const raw = await fs.readFile(resolveFromRoot(filePath), "utf8");
  return JSON.parse(raw);
}

async function loadConfig() {
  const config = await readJson("lovart.config.json");
  config.headless = process.env.HEADLESS ? process.env.HEADLESS !== "false" : Boolean(config.headless);
  config.maxRounds = Math.min(Number(config.maxRounds || 6), 6);
  return config;
}

async function loadTasks(tasksPath) {
  const parsed = await readJson(tasksPath);
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;

  if (!Array.isArray(tasks)) {
    throw new Error("prompts.json must be an array or an object with a tasks array.");
  }

  const seen = new Set();
  return tasks.map((task, index) => {
    if (!task || typeof task !== "object") {
      throw new Error(`Task at index ${index} must be an object.`);
    }
    if (!task.id || typeof task.id !== "string") {
      throw new Error(`Task at index ${index} is missing a string id.`);
    }
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
    if (!task.prompt || typeof task.prompt !== "string") {
      throw new Error(`Task ${task.id} is missing a string prompt.`);
    }
    return {
      id: sanitizeTaskId(task.id),
      originalId: task.id,
      prompt: task.prompt,
      followUpPrompt: task.followUpPrompt,
    };
  });
}

function sanitizeTaskId(id) {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Invalid task id after sanitizing: ${id}`);
  }
  return safe;
}

module.exports = {
  ROOT,
  loadConfig,
  loadTasks,
  resolveFromRoot,
};
