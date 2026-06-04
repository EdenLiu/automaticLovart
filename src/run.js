const { LovartAgent } = require("./lib/lovartAgent");
const { loadConfig, loadTasks } = require("./lib/config");
const {
  formatDuration,
  formatLocalDateTime,
  getNextStartTime,
  parseRunOptions,
  waitUntil,
} = require("./lib/scheduler");
const { startWakeLock } = require("./lib/wakeLock");

async function main() {
  const options = parseRunOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  let wakeLock = null;
  if (options.startAt) {
    const target = getNextStartTime(options.startAt);
    wakeLock = startWakeLock("automaticLovart scheduled run");
    console.log(`Scheduled run for ${formatLocalDateTime(target)} (in ${formatDuration(target.getTime() - Date.now())}).`);
    console.log(`Sleep prevention enabled with ${wakeLock.label} until this process exits.`);
    await waitUntil(target);
  }

  try {
    const config = await loadConfig();
    const tasks = await loadTasks(config);

    if (tasks.length === 0) {
      throw new Error("No tasks found. Add tasks to prompts.json first.");
    }

    const agent = new LovartAgent(config);
    const report = await agent.run(tasks);

    const failed = report.tasks.filter((task) => task.status !== "success");
    if (failed.length > 0) {
      console.error(`Finished with ${failed.length} failed task(s). See run-report.json.`);
      process.exitCode = 1;
      return;
    }

    console.log(`All ${report.tasks.length} task(s) completed. See run-report.json.`);
  } finally {
    if (wakeLock) {
      wakeLock.stop();
    }
  }
}

function printUsage() {
  console.log(`Usage:
  npm run run -- [--start-at HH:MM]
  npm run run:headed -- [--start-at HH:MM]

Options:
  --start-at HH:MM       Wait until the next local 24-hour time before running.
  --start-time HH:MM     Alias for --start-at.
  --schedule-at HH:MM    Alias for --start-at.
  -h, --help             Show this help.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
