import fs from "node:fs";
import path from "node:path";

export class RunLogger {
  constructor(logDir = "logs") {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(logDir, `collect-${stamp}.log`);
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
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...data,
    });
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}
