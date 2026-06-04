const { setTimeout: sleep } = require("node:timers/promises");

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function parseRunOptions(argv) {
  const options = {
    help: false,
    startAt: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--start-at" || arg === "--start-time" || arg === "--schedule-at") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a time value, for example: --start-at 23:30`);
      }
      options.startAt = parseStartAt(value);
      index += 1;
      continue;
    }

    const inlineMatch = arg.match(/^--(start-at|start-time|schedule-at)=(.+)$/);
    if (inlineMatch) {
      options.startAt = parseStartAt(inlineMatch[2]);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function parseStartAt(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid start time: ${value}. Use 24-hour HH:MM format, for example: 23:30`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid start time: ${value}. Hour must be 0-23 and minute must be 0-59.`);
  }

  return { hour, minute };
}

function getNextStartTime(startAt, now = new Date()) {
  const target = new Date(now);
  target.setHours(startAt.hour, startAt.minute, 0, 0);

  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

async function waitUntil(target) {
  while (Date.now() < target.getTime()) {
    const remainingMs = target.getTime() - Date.now();
    await sleep(Math.min(remainingMs, MAX_TIMEOUT_MS));
  }
}

function formatLocalDateTime(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  formatDuration,
  formatLocalDateTime,
  getNextStartTime,
  parseRunOptions,
  parseStartAt,
  waitUntil,
};
