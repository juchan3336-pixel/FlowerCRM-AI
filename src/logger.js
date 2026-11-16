import fs from "node:fs";
import path from "node:path";

export class RunLogger {
  // sanitize: applied to every entry's payload before it is written (e.g. to mask addresses in a
  // log that is published).
  constructor(logDir = "logs", prefix = "collect", { sanitize = null } = {}) {
    this.sanitize = sanitize;
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(logDir, `${prefix}-${stamp}.log`);
  }

  info(message, data = {}) {
    this.write("INFO", message, data);
  }

  error(message, error) {
    this.write("ERROR", message, {
      message: error?.message || String(error),
      stack: error?.stack || "",
    });
  }

  write(level, message, data = {}) {
    const payload = typeof this.sanitize === "function" ? this.sanitize({ message, ...data }) : { message, ...data };
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      ...payload,
    });
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}
