import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Ghi log ra file data/bot.log (de xem khi chay an), tu cat khi > 5MB
const LOG_FILE = path.join(config.dataDir, "bot.log");
let logStream = null;
function fileWrite(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(config.dataDir, { recursive: true });
      try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
          fs.renameSync(LOG_FILE, LOG_FILE + ".old");
        }
      } catch {}
      logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch {}
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[config.logLevel] ?? LEVELS.info;

// Bo dem log gan nhat + event de app quan ly xem truc tiep
const RING_MAX = 500;
export const logRing = [];
export const logEvents = new EventEmitter();
logEvents.setMaxListeners(50);

function fmt(level, args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const entry = { ts, level, msg };
  logRing.push(entry);
  if (logRing.length > RING_MAX) logRing.shift();
  logEvents.emit("log", entry);
  const line = `${ts} [${level.toUpperCase()}] ${msg}`;
  fileWrite(line);
  return line;
}

export const log = {
  debug: (...a) => current <= LEVELS.debug && console.log(fmt("debug", a)),
  info: (...a) => current <= LEVELS.info && console.log(fmt("info", a)),
  warn: (...a) => current <= LEVELS.warn && console.warn(fmt("warn", a)),
  error: (...a) => current <= LEVELS.error && console.error(fmt("error", a)),
};
