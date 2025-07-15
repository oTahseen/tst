const colors = require("@colors/colors")
const moment = require("moment-timezone")

class Logger {
  constructor() {
    this.timezone = process.env.TZ || "Asia/Jakarta"
  }

  formatMessage(level, message, data = null) {
    const timestamp = moment().tz(this.timezone).format("DD/MM/YY HH:mm:ss")
    let logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`

    if (data) {
      logMessage += ` ${typeof data === "object" ? JSON.stringify(data, null, 2) : data}`
    }

    return logMessage
  }

  info(message, data = null) {
    console.log(colors.green(this.formatMessage("info", message, data)))
  }

  warn(message, data = null) {
    console.log(colors.yellow(this.formatMessage("warn", message, data)))
  }

  error(message, data = null) {
    console.log(colors.red(this.formatMessage("error", message, data)))
  }

  debug(message, data = null) {
    if (process.env.DEBUG === "true") {
      console.log(colors.gray(this.formatMessage("debug", message, data)))
    }
  }
}

module.exports = new Logger()
