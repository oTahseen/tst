const colors = require("@colors/colors")
const moment = require("moment-timezone")

const log = (level, message, ...args) => {
  const timestamp = moment().tz("Asia/Jakarta").format("HH:mm:ss")
  let coloredMessage = message

  switch (level) {
    case "info":
      coloredMessage = colors.green(message)
      break
    case "warn":
      coloredMessage = colors.yellow(message)
      break
    case "error":
      coloredMessage = colors.red(message)
      break
    case "debug":
      coloredMessage = colors.blue(message)
      break
    default:
      break
  }

  console.log(`[${timestamp}] [${level.toUpperCase()}] ${coloredMessage}`, ...args)
}

module.exports = {
  info: (message, ...args) => log("info", message, ...args),
  warn: (message, ...args) => log("warn", message, ...args),
  error: (message, ...args) => log("error", message, ...args),
  debug: (message, ...args) => log("debug", message, ...args),
}
