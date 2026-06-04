const { spawn } = require("node:child_process");

function startWakeLock(reason) {
  const command = getWakeLockCommand(reason);
  if (!command) {
    console.warn(`Sleep prevention is not supported on ${process.platform}; continuing without a wake lock.`);
    return {
      label: "unsupported",
      stop() {},
    };
  }

  const child = spawn(command.file, command.args, {
    detached: false,
    stdio: "ignore",
  });

  let exited = false;
  let stopping = false;

  child.once("error", (error) => {
    console.warn(`Failed to start sleep prevention with ${command.label}: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    exited = true;
    if (!stopping && code !== 0) {
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      console.warn(`Sleep prevention stopped early (${detail}).`);
    }
  });

  return {
    label: command.label,
    stop() {
      stopping = true;
      if (!exited) {
        child.kill();
      }
    },
  };
}

function getWakeLockCommand(reason) {
  if (process.platform === "darwin") {
    return {
      file: "caffeinate",
      args: ["-dimsu", "-w", String(process.pid)],
      label: "caffeinate",
    };
  }

  if (process.platform === "linux") {
    return {
      file: "systemd-inhibit",
      args: [
        "--what=sleep:idle",
        "--who=automaticLovart",
        `--why=${reason}`,
        "--mode=block",
        "sleep",
        "infinity",
      ],
      label: "systemd-inhibit",
    };
  }

  return null;
}

module.exports = {
  startWakeLock,
};
