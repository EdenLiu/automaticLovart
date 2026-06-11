const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = process.cwd();
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

function resolveFromRoot(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

async function readJson(filePath) {
  const resolved = resolveFromRoot(filePath);
  let raw;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && path.basename(filePath) === "lovart.config.json") {
      throw new Error(`Could not find lovart.config.json in ${ROOT}. Run automatic-lovart-init first.`);
    }
    throw error;
  }
  return JSON.parse(raw);
}

async function loadConfig() {
  const config = await readJson("lovart.config.json");
  config.headless = process.env.HEADLESS ? process.env.HEADLESS !== "false" : Boolean(config.headless);
  config.maxRounds = Math.min(Number(config.maxRounds || 6), 6);
  config.taskStatePath = config.taskStatePath || "./.auth/task-state.json";
  return config;
}

async function loadTasks(tasksPathOrConfig) {
  const options = typeof tasksPathOrConfig === "string"
    ? { tasksPath: tasksPathOrConfig }
    : tasksPathOrConfig;
  const tasksPath = options.tasksPath;
  const parsed = await readJson(tasksPath);
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;

  if (!Array.isArray(tasks)) {
    throw new Error("prompts.json must be an array or an object with a tasks array.");
  }

  const normalized = tasks.map((task, index) => {
    if (typeof task === "string") {
      const prompt = task.trim();
      if (!prompt) {
        throw new Error(`Task at index ${index} has an empty prompt.`);
      }
      return { prompt };
    }

    if (!task || typeof task !== "object") {
      throw new Error(`Task at index ${index} must be a prompt string or an object.`);
    }

    if (!task.prompt || typeof task.prompt !== "string") {
      throw new Error(`Task at index ${index} is missing a string prompt.`);
    }

    const prompt = task.prompt.trim();
    if (!prompt) {
      throw new Error(`Task at index ${index} has an empty prompt.`);
    }

    return {
      prompt,
      followUpPrompt: task.followUpPrompt,
    };
  });

  return await assignTaskIds(normalized, options);
}

async function assignTaskIds(tasks, options) {
  if (tasks.length === 0) return [];

  const statePath = resolveFromRoot(options.taskStatePath || "./.auth/task-state.json");
  const outputDir = resolveFromRoot(options.outputDir || "./picture_lovart");
  const state = await readTaskState(statePath);
  const highestExistingTaskNumber = await readHighestExistingTaskNumber(outputDir);
  const nextTaskNumber = parsePositiveInteger(state.nextTaskNumber, 1);
  const firstTaskNumber = Math.max(nextTaskNumber, highestExistingTaskNumber + 1);
  const assigned = tasks.map((task, index) => {
    const taskNumber = firstTaskNumber + index;
    const id = formatTaskId(taskNumber);
    return {
      id,
      originalId: id,
      prompt: task.prompt,
      followUpPrompt: task.followUpPrompt,
    };
  });

  await writeTaskState(statePath, {
    nextTaskNumber: firstTaskNumber + tasks.length,
    updatedAt: new Date().toISOString(),
  });

  return assigned;
}

async function readTaskState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeTaskState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function readHighestExistingTaskNumber(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  return entries.reduce((highest, entry) => {
    if (!entry.isDirectory()) return highest;
    const match = entry.name.match(/^task_(\d+)$/);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);
}

function formatTaskId(taskNumber) {
  return `task_${String(taskNumber).padStart(3, "0")}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

module.exports = {
  PACKAGE_ROOT,
  ROOT,
  loadConfig,
  loadTasks,
  resolveFromRoot,
};
