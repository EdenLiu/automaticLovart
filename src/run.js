const { LovartAgent } = require("./lib/lovartAgent");
const { loadConfig, loadTasks } = require("./lib/config");

async function main() {
  const config = await loadConfig();
  const tasks = await loadTasks(config.tasksPath);

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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
