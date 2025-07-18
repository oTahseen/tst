const logger = require("../system/logger")
const fs = require("fs") // Synchronous fs for existsSync
const fsPromises = require("fs").promises // Promise-based fs for async operations
const path = require("path")
const { exec } = require("child_process") // Import child_process for executing shell commands

class TelegramCommands {
  constructor(bridge) {
    this.bridge = bridge
    this.paginationState = new Map()
  }

  // Helper to sanitize output for Markdown code blocks
  sanitizeOutput(text) {
    if (!text) return ""
    // Replace triple backticks with escaped ones to prevent breaking markdown code blocks
    let sanitized = text.replace(/```/g, "`\\`\\``")
    // Also escape single backticks if they are not part of a code block
    sanitized = sanitized.replace(/`/g, "\\`")
    return sanitized
  }

  async handleCommand(msg) {
    const text = msg.text
    if (!text || !text.startsWith("/")) return

    const [command, ...args] = text.trim().split(/\s+/)
    const userId = msg.from.id

    // Allow /password command without authentication
    if (command.toLowerCase() === "/password") {
      await this.handlePassword(msg.chat.id, args)
      return
    }

    // Check authentication for all other commands
    if (!this.bridge.isUserAuthenticated(userId)) {
      await this.bridge.telegramBot.sendMessage(msg.chat.id, "🔒 Access denied. Use /password to authenticate.", {
        parse_mode: "Markdown",
      })
      return
    }

    try {
      switch (command.toLowerCase()) {
        case "/start":
          await this.handleStart(msg.chat.id)
          break
        case "/status":
          await this.handleStatus(msg.chat.id)
          break
        case "/send":
          await this.handleSend(msg.chat.id, args)
          break
        case "/contacts":
          const pageArg = args[0] ? Number.parseInt(args[0]) - 1 : 0 // Convert to 0-based index
          await this.handleContacts(msg.chat.id, pageArg)
          break
        case "/searchcontact":
          await this.handleSearchContact(msg.chat.id, args)
          break
        case "/addfilter":
          await this.handleAddFilter(msg.chat.id, args)
          break
        case "/filters":
          await this.handleListFilters(msg.chat.id)
          break
        case "/clearfilters":
          await this.handleClearFilters(msg.chat.id)
          break
        case "/backup":
          await this.handleBackup(msg.chat.id)
          break
        case "/restore":
          await this.handleRestore(msg.chat.id, msg)
          break
        case "/updatetopics":
          await this.handleUpdateTopics(msg.chat.id)
          break
        case "/restart":
          await this.handleRestart(msg.chat.id)
          break
        case "/updatebot":
          await this.handleUpdateBot(msg.chat.id)
          break
        case "/joingroup":
          await this.handleJoinGroup(msg.chat.id, args)
          break
        case "/listgroups":
          const listGroupsPageArg = args[0] ? Number.parseInt(args[0]) - 1 : 0
          await this.handleListGroups(msg.chat.id, listGroupsPageArg)
          break
        default:
          await this.handleMenu(msg.chat.id)
      }
    } catch (error) {
      logger.error(`Error handling command ${command}:`, error)
      await this.bridge.telegramBot.sendMessage(
        msg.chat.id,
        `❌ Command error: ${this.sanitizeOutput(error.message)}`,
        {
          parse_mode: "Markdown",
        },
      )
    }
  }

  async handleStart(chatId) {
    try {
      // Calculate uptime
      const uptimeMs = process.uptime() * 1000
      const startTime = new Date(Date.now() - uptimeMs)

      // Format uptime duration
      const formatUptime = (ms) => {
        const seconds = Math.floor(ms / 1000)
        const minutes = Math.floor(seconds / 60)
        const hours = Math.floor(minutes / 60)
        const days = Math.floor(hours / 24)

        const h = hours % 24
        const m = minutes % 60
        const s = seconds % 60

        if (days > 0) {
          return `${days}d${h}h${m}m${s}s`
        } else if (hours > 0) {
          return `${h}h${m}m${s}s`
        } else if (minutes > 0) {
          return `${m}m${s}s`
        } else {
          return `${s}s`
        }
      }

      // Format start time
      const formatDate = (date) => {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

        const day = date.getDate().toString().padStart(2, "0")
        const month = months[date.getMonth()]
        const year = date.getFullYear()
        const dayName = days[date.getDay()]
        const hours = date.getHours().toString().padStart(2, "0")
        const minutes = date.getMinutes().toString().padStart(2, "0")

        return `${day} ${month}, ${year} - ${dayName} @ ${hours}:${minutes}`
      }

      const statusText =
        `Hi! The bot is up and running\n\n` + `• Up Since: ${formatDate(startTime)} [ ${formatUptime(uptimeMs)} ]`

      await this.bridge.telegramBot.sendMessage(chatId, statusText, { parse_mode: "Markdown" })
    } catch (error) {
      logger.error("Error in handleStart:", error)
      await this.bridge.telegramBot.sendMessage(chatId, "Hi! The bot is up and running", { parse_mode: "Markdown" })
    }
  }

  async handleStatus(chatId) {
    try {
      const whatsapp = this.bridge.whatsappClient
      const userName = whatsapp?.user?.name || "Unknown"

      // Get server information
      const memUsage = process.memoryUsage()
      const uptimeSeconds = process.uptime()
      const cpuUsage = process.cpuUsage()

      // Format memory usage
      const formatBytes = (bytes) => {
        const sizes = ["Bytes", "KB", "MB", "GB"]
        if (bytes === 0) return "0 Bytes"
        const i = Math.floor(Math.log(bytes) / Math.log(1024))
        return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
      }

      // Format uptime
      const formatUptime = (seconds) => {
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const secs = Math.floor(seconds % 60)

        if (days > 0) {
          return `${days}d ${hours}h ${minutes}m ${secs}s`
        } else if (hours > 0) {
          return `${hours}h ${minutes}m ${secs}s`
        } else if (minutes > 0) {
          return `${minutes}m ${secs}s`
        } else {
          return `${secs}s`
        }
      }

      // Get system load (if available)
      let loadAverage = "N/A"
      try {
        const os = require("os")
        const load = os.loadavg()
        loadAverage = `${load[0].toFixed(2)}, ${load[1].toFixed(2)}, ${load[2].toFixed(2)}`
      } catch (error) {
        // Load average not available on all systems
      }

      // Get platform info
      const os = require("os")
      const platform = `${os.type()} ${os.release()}`
      const arch = os.arch()
      const nodeVersion = process.version

      // Calculate CPU usage percentage (approximate)
      const cpuPercent = (((cpuUsage.user + cpuUsage.system) / 1000000 / uptimeSeconds) * 100).toFixed(2)

      // Get database info
      let dbInfo = "Local"
      let dbSize = "Unknown"
      try {
        if (process.env.DATABASE_URL) {
          if (process.env.DATABASE_URL.includes("mongo")) {
            dbInfo = "MongoDB (Cloud)"
          } else if (process.env.DATABASE_URL.includes("postgres")) {
            dbInfo = "PostgreSQL (Cloud)"
          }
        } else {
          // Try to get local database file size
          const dbPath = "./data.json"
          if (fs.existsSync(dbPath)) {
            // Using synchronous fs.existsSync
            const stats = fs.statSync(dbPath) // Using synchronous fs.statSync
            dbSize = formatBytes(stats.size)
          }
        }
      } catch (error) {
        // Ignore errors
      }

      const status =
        `📊 *Bridge Status*\n\n` +
        `🔗 *Connection Status:*\n` +
        `├ WhatsApp: ${whatsapp ? "✅ Connected" : "❌ Disconnected"}\n` +
        `├ User: ${userName}\n` +
        `├ Telegram: ✅ Active\n` +
        `└ Bridge: ${this.bridge.config?.telegram?.enabled ? "✅ Enabled" : "❌ Disabled"}\n\n` +
        `💬 *Bridge Statistics:*\n` +
        `├ Chats: ${this.bridge.chatMappings?.size || 0}\n` +
        `├ Users: ${this.bridge.userMappings?.size || 0}\n` +
        `├ Contacts: ${this.bridge.contactMappings?.size || 0}\n` +
        `└ Filters: ${this.bridge.filters?.size || 0}\n\n` +
        `🖥️ *Server Information:*\n` +
        `├ Platform: ${platform}\n` +
        `├ Architecture: ${arch}\n` +
        `├ Node.js: ${nodeVersion}\n` +
        `├ Uptime: ${formatUptime(uptimeSeconds)}\n` +
        `├ Load Average: ${loadAverage}\n\n` +
        `💾 *Memory Usage:*\n` +
        `├ RSS: ${formatBytes(memUsage.rss)}\n` +
        `├ Heap Used: ${formatBytes(memUsage.heapUsed)}\n` +
        `├ Heap Total: ${formatBytes(memUsage.heapTotal)}\n` +
        `├ External: ${formatBytes(memUsage.external)}\n` +
        `└ CPU Usage: ~${cpuPercent}%\n\n` +
        `🗄️ *Database:*\n` +
        `├ Type: ${dbInfo}\n` +
        `└ Size: ${dbSize}\n\n` +
        `⏰ *Last Updated:* ${new Date().toLocaleString()}`

      await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: "Markdown" })
    } catch (error) {
      logger.error("Error in handleStatus:", error)
      // Fallback to basic status if detailed status fails
      const whatsapp = this.bridge.whatsappClient
      const userName = whatsapp?.user?.name || "Unknown"

      const basicStatus =
        `📊 *Bridge Status*\n\n` +
        `🔗 WhatsApp: ${whatsapp ? "✅ Connected" : "❌ Disconnected"}\n` +
        `👤 User: ${userName}\n` +
        `💬 Chats: ${this.bridge.chatMappings?.size || 0}\n` +
        `👥 Users: ${this.bridge.userMappings?.size || 0}\n` +
        `📞 Contacts: ${this.bridge.contactMappings?.size || 0}\n\n` +
        `⚠️ *Note:* Detailed server info unavailable`

      await this.bridge.telegramBot.sendMessage(chatId, basicStatus, { parse_mode: "Markdown" })
    }
  }

  async handleBackup(chatId) {
    let messageId // To store the message ID of the initial processing message
    try {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Creating database backup...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.debug(`Sent initial backup message with ID: ${messageId}`)

      // Save current database state
      if (this.bridge.database && typeof this.bridge.database.save === "function") {
        await this.bridge.database.save(global.db)
      }

      // Get database configuration
      const env = require("../../config.json")
      const dbFileName = `${env.database || "data"}.json`
      const backupFileName = `backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      const backupPath = path.join(process.cwd(), backupFileName)

      // Create backup file
      const backupData = {
        timestamp: new Date().toISOString(),
        version: require("../../package.json").version,
        database: global.db,
        metadata: {
          users: global.db.users?.length || 0,
          groups: global.db.groups?.length || 0,
          chats: global.db.chats?.length || 0,
          contacts: Object.keys(global.db.bridge?.contactMappings || {}).length,
          chatMappings: Object.keys(global.db.bridge?.chatMappings || {}).length,
        },
      }

      await fsPromises.writeFile(backupPath, JSON.stringify(backupData, null, 2), "utf8") // Using fsPromises.writeFile

      // Get file stats
      const stats = await fsPromises.stat(backupPath) // Using fsPromises.stat
      const fileSize = this.formatBytes(stats.size)

      // Edit the initial message to confirm backup creation
      await this.bridge.telegramBot.editMessageText(
        `✅ **Database Backup Created!**\n\n` +
          `📅 **Date:** ${new Date().toLocaleString()}\n` +
          `📊 **Size:** ${fileSize}\n` +
          `👥 **Users:** ${backupData.metadata.users}\n` +
          `🏷️ **Groups:** ${backupData.metadata.groups}\n` +
          `💬 **Chats:** ${backupData.metadata.chats}\n` +
          `📞 **Contacts:** ${backupData.metadata.contacts}\n` +
          `🔗 **Mappings:** ${backupData.metadata.chatMappings}\n\n` +
          `⚠️ **Keep this file safe!** You can use it to restore your database with /restore`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        },
      )
      logger.debug(`Edited initial backup message with ID: ${messageId} to success.`)

      // Send backup file as a separate document
      await this.bridge.telegramBot.sendDocument(chatId, backupPath, {
        caption: "⬆️ Your backup file is attached above.",
        parse_mode: "Markdown",
      })

      // Clean up backup file
      setTimeout(async () => {
        try {
          await fsPromises.unlink(backupPath) // Using fsPromises.unlink
          logger.debug(`Cleaned up backup file: ${backupFileName}`)
        } catch (error) {
          logger.warn(`Failed to clean up backup file: ${error.message}`)
        }
      }, 60000) // Delete after 1 minute

      logger.info(`Database backup created and sent via Telegram: ${backupFileName}`)
    } catch (error) {
      logger.error("Error creating backup:", error)
      const errorMessage = `❌ **Backup Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease try again or check the logs.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited initial backup message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleRestore(chatId, msg) {
    let messageId // To store the message ID of the initial processing message
    try {
      let documentMsg = null

      // Check if current message has document
      if (msg.document) {
        documentMsg = msg
      }
      // Check if replying to a message with document
      else if (msg.reply_to_message && msg.reply_to_message.document) {
        documentMsg = msg.reply_to_message
      }

      // If no document found, show instructions
      if (!documentMsg) {
        await this.bridge.telegramBot.sendMessage(
          chatId,
          `📁 **Database Restore**\n\n` +
            `To restore the database, please:\n` +
            `1. Reply to this message with a backup file\n` +
            `2. Or send /restore command while replying to a backup file\n` +
            `3. Or send the backup file directly with /restore command\n\n` +
            `⚠️ **Warning:** This will replace your current database!`,
          { parse_mode: "Markdown" },
        )
        return
      }

      // Validate file
      if (!documentMsg.document.file_name || !documentMsg.document.file_name.endsWith(".json")) {
        await this.bridge.telegramBot.sendMessage(
          chatId,
          "❌ **Invalid File**\n\nPlease provide a valid JSON backup file.",
          { parse_mode: "Markdown" },
        )
        return
      }

      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Restoring database from backup...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.debug(`Sent initial restore message with ID: ${messageId}`)

      // Download the backup file
      const fileId = documentMsg.document.file_id
      const fileInfo = await this.bridge.telegramBot.getFile(fileId)
      const fileUrl = `https://api.telegram.org/file/bot${this.bridge.config.telegram.botToken}/${fileInfo.file_path}`

      const axios = require("axios")
      const response = await axios.get(fileUrl, { responseType: "text" })
      const backupContent = response.data

      // Parse and validate backup
      let backupData
      try {
        backupData = JSON.parse(backupContent)
      } catch (parseError) {
        throw new Error("Invalid JSON format in backup file")
      }

      // Validate backup structure
      if (!backupData.database) {
        throw new Error("Invalid backup file: missing database section")
      }

      // Validate essential database structure
      const requiredFields = ["users", "groups", "chats", "setting"]
      for (const field of requiredFields) {
        if (!backupData.database[field]) {
          logger.warn(`Backup missing field: ${field}, initializing as empty`)
          backupData.database[field] = field === "setting" ? {} : []
        }
      }

      // Ensure bridge data exists
      if (!backupData.database.bridge) {
        backupData.database.bridge = {
          chatMappings: {},
          userMappings: {},
          contactMappings: {},
          filters: [],
        }
      }

      // Create backup of current database before restore
      const currentBackupPath = path.join(process.cwd(), `pre_restore_backup_${Date.now()}.json`)
      await fsPromises.writeFile(currentBackupPath, JSON.stringify(global.db, null, 2), "utf8") // Using fsPromises.writeFile

      try {
        // Restore database
        global.db = backupData.database

        // Save restored database
        if (this.bridge.database && typeof this.bridge.database.save === "function") {
          await this.bridge.database.save(global.db)
        }

        // Reload bridge mappings
        await this.bridge.loadMappingsFromDb()

        // Get restore statistics
        const stats = {
          users: global.db.users?.length || 0,
          groups: global.db.groups?.length || 0,
          chats: global.db.chats?.length || 0,
          contacts: Object.keys(global.db.bridge?.contactMappings || {}).length,
          chatMappings: Object.keys(global.db.bridge?.chatMappings || {}).length,
        }

        await this.bridge.telegramBot.editMessageText(
          `✅ **Database Restored Successfully!**\n\n` +
            `📅 **Backup Date:** ${backupData.timestamp ? new Date(backupData.timestamp).toLocaleString() : "Unknown"}\n` +
            `📊 **Restored Data:**\n` +
            `├ Users: ${stats.users}\n` +
            `├ Groups: ${stats.groups}\n` +
            `├ Chats: ${stats.chats}\n` +
            `├ Contacts: ${stats.contacts}\n` +
            `└ Mappings: ${stats.chatMappings}\n\n` +
            `🔄 **Bridge mappings reloaded**\n` +
            `💾 **Pre-restore backup saved locally**\n\n` +
            `⚠️ **Note:** Bot restart recommended for full effect`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
          },
        )
        logger.debug(`Edited initial restore message with ID: ${messageId} to success.`)

        logger.info(
          `Database restored from Telegram backup. Stats: ${JSON.stringify(stats)}. Pre-restore backup: ${currentBackupPath}`,
        )

        // Clean up pre-restore backup after some time
        setTimeout(async () => {
          try {
            await fsPromises.unlink(currentBackupPath) // Using fsPromises.unlink
            logger.debug("Cleaned up pre-restore backup file")
          } catch (error) {
            logger.warn("Failed to clean up pre-restore backup:", error.message)
          }
        }, 300000) // Delete after 5 minutes
      } catch (restoreError) {
        // If restore fails, try to restore from pre-restore backup
        try {
          const preRestoreData = await fsPromises.readFile(currentBackupPath, "utf8") // Using fsPromises.readFile
          global.db = JSON.parse(preRestoreData)
          await this.bridge.database.save(global.db)
          logger.warn("Restored from pre-restore backup due to restore failure")
        } catch (rollbackError) {
          logger.error("Failed to rollback after restore failure:", rollbackError)
        }
        throw restoreError
      }
    } catch (error) {
      logger.error("Error restoring database:", error)
      const errorMessage =
        `❌ **Restore Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\n` +
        `Please check:\n` +
        `• File is a valid backup JSON\n` +
        `• File is not corrupted\n` +
        `• You have sufficient permissions\n\n` +
        `If the error persists, check the bot logs.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited initial restore message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleUpdateTopics(chatId) {
    let messageId // To store the message ID of the initial processing message
    try {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Updating topic names...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.debug(`Sent initial update topics message with ID: ${messageId}`)

      // First sync contacts to get latest data
      await this.bridge.syncContacts()

      const telegramChatId = this.bridge.config.telegram.chatId
      if (!telegramChatId || telegramChatId.includes("YOUR_CHAT_ID")) {
        throw new Error("Invalid telegram chat ID configuration")
      }

      let updatedCount = 0
      let skippedCount = 0
      let errorCount = 0
      const results = []

      for (const [jid, topicId] of this.bridge.chatMappings.entries()) {
        try {
          let newName = null
          let topicType = "Unknown"

          if (jid === "status@broadcast") {
            newName = "📊 Status Updates"
            topicType = "Status"
          } else if (jid === "call@broadcast") {
            newName = "📞 Call Logs"
            topicType = "Calls"
          } else if (jid.endsWith("@g.us")) {
            // Group chat
            try {
              const groupMeta = await this.bridge.whatsappClient.groupMetadata(jid)
              newName = groupMeta.subject
              topicType = "Group"
            } catch (error) {
              newName = "Group Chat"
              topicType = "Group"
              logger.warn(`Could not fetch group metadata for ${jid}:`, error.message)
            }
          } else {
            // Individual contact
            const phone = jid.split("@")[0]
            const contactName = this.bridge.contactMappings.get(phone)

            if (contactName && contactName !== phone && !contactName.startsWith("+")) {
              newName = contactName
              topicType = "Contact"
            } else {
              newName = `+${phone}`
              topicType = "Contact"
            }
          }

          if (newName) {
            await this.bridge.telegramBot.editForumTopic(telegramChatId, topicId, {
              name: newName,
            })

            results.push(`✅ ${topicType}: ${newName}`)
            updatedCount++
            logger.debug(`Updated topic ${topicId} to "${newName}" for ${jid}`)
          } else {
            results.push(`⏭️ Skipped: ${jid}`)
            skippedCount++
          }

          // Add small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200))
        } catch (error) {
          const errorMsg = error.response?.data?.description || error.message
          results.push(`❌ Error updating ${jid}: ${this.sanitizeOutput(errorMsg)}`)
          errorCount++
          logger.error(`Failed to update topic ${topicId} for ${jid}:`, errorMsg)
        }
      }

      // Create summary message
      const summary =
        `✅ **Topic Update Complete!**\n\n` +
        `📊 **Summary:**\n` +
        `├ Updated: ${updatedCount}\n` +
        `├ Skipped: ${skippedCount}\n` +
        `├ Errors: ${errorCount}\n` +
        `└ Total: ${this.bridge.chatMappings.size}\n\n`

      // If there are results to show, create detailed report
      if (results.length > 0) {
        const maxResults = 20 // Limit results to avoid message length issues
        const displayResults = results.slice(0, maxResults)
        const hasMore = results.length > maxResults

        const detailedReport =
          summary +
          `📋 **Details:**\n` +
          displayResults.join("\n") +
          (hasMore ? `\n\n... and ${results.length - maxResults} more` : "")

        // Split message if too long
        if (detailedReport.length > 4000) {
          await this.bridge.telegramBot.editMessageText(summary, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
          })
          logger.debug(`Edited initial update topics message with ID: ${messageId} to summary.`)

          // Send results in chunks
          const chunks = this.chunkArray(results, 15)
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]
            const chunkMessage = `📋 **Details (${i + 1}/${chunks.length}):**\n` + chunk.join("\n")
            await this.bridge.telegramBot.sendMessage(chatId, chunkMessage, { parse_mode: "Markdown" })
            await new Promise((resolve) => setTimeout(resolve, 1000)) // Delay between chunks
          }
        } else {
          await this.bridge.telegramBot.editMessageText(detailedReport, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
          })
          logger.debug(`Edited initial update topics message with ID: ${messageId} to detailed report.`)
        }
      } else {
        await this.bridge.telegramBot.editMessageText(summary, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited initial update topics message with ID: ${messageId} to summary (no details).`)
      }

      logger.info(`Topic update completed: ${updatedCount} updated, ${skippedCount} skipped, ${errorCount} errors`)
    } catch (error) {
      logger.error("Error updating topics:", error)
      const errorMessage = `❌ **Update Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease try again or check the logs.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited initial update topics message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleRestart(chatId) {
    let messageId // To store the message ID of the initial processing message
    try {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Restarting bot...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.info(`Bot restart initiated by Telegram user ${chatId}`)

      // Save database before restarting to ensure data persistence
      if (this.bridge.database && typeof this.bridge.database.save === "function") {
        await this.bridge.database.save(global.db)
        logger.info("Database saved before restart.")
      }

      await this.bridge.telegramBot.editMessageText("✅ Bot is restarting now. Please wait a moment...", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
      })
      logger.debug(`Edited restart message with ID: ${messageId} to success.`)

      // Trigger process restart (this sends a message to the parent process, handled by index.js)
      process.send("reset")
    } catch (error) {
      logger.error("Error initiating bot restart:", error)
      const errorMessage = `❌ **Restart Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease try again or check the logs.`
      // If messageId is available, try to edit the message, otherwise send a new one
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited restart message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleUpdateBot(chatId) {
    let messageId // To store the message ID of the initial processing message
    try {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Fetching updates from GitHub...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.debug(`Sent initial update bot message with ID: ${messageId}`)

      // Check if it's a git repository
      const gitDir = path.join(process.cwd(), ".git")
      if (!fs.existsSync(gitDir)) {
        // Using synchronous fs.existsSync
        const errorMessage = `❌ **Update Failed**\n\nThis bot is not running in a Git repository. Automatic updates are not possible.\n\nTo enable updates, please clone the repository using \`git clone\` instead of just copying files.`
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.warn(`Update failed: Not a git repository at ${process.cwd()}`)
        return
      }

      const maxOutputLength = 1000 // Limit output length for Telegram message

      // Execute git pull
      exec("git pull", { cwd: process.cwd() }, async (error, stdout, stderr) => {
        if (error) {
          logger.error(`Git pull failed: ${error.message}`)
          const sanitizedStderr = this.sanitizeOutput(stderr).substring(0, maxOutputLength)
          const errorMessage = `❌ **Update Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\n\`\`\`\n${sanitizedStderr || "No stderr output."}\n\`\`\`\n\nPlease check the bot logs for details.`
          await this.bridge.telegramBot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
          })
          logger.debug(`Edited update bot message with ID: ${messageId} to error.`)
          // Do NOT restart on failure
          return
        }

        const sanitizedStdout = this.sanitizeOutput(stdout).substring(0, maxOutputLength)

        if (stdout.includes("Already up to date.")) {
          await this.bridge.telegramBot.editMessageText("✅ Bot is already up to date. No new updates found.", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
          })
          logger.debug(`Edited update bot message with ID: ${messageId} to "already up to date".`)
        } else {
          logger.info(`Git pull successful:\n${stdout}`)
          await this.bridge.telegramBot.editMessageText(
            `✅ **Bot Updated Successfully!**\n\n` +
              `\`\`\`\n${sanitizedStdout}\n\`\`\`\n` +
              `🔄 Please use /restart to apply the changes.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
            },
          )
          logger.debug(`Edited update bot message with ID: ${messageId} to success.`)
          // User will manually restart using /restart command
        }
      })
    } catch (error) {
      logger.error("Error initiating bot update:", error)
      const errorMessage = `❌ **Update Failed**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease try again or check the logs.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited update bot message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleJoinGroup(chatId, args) {
    let messageId
    try {
      if (args.length === 0) {
        return await this.bridge.telegramBot.sendMessage(
          chatId,
          "❌ Usage: /joingroup <WhatsApp_Group_Invite_Link>\nExample: /joingroup https://chat.whatsapp.com/ABCDEFGHIJKL",
          { parse_mode: "Markdown" },
        )
      }

      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, "🔄 Attempting to join WhatsApp group...", {
        parse_mode: "Markdown",
      })
      messageId = sentMessage.message_id
      logger.debug(`Sent initial join group message with ID: ${messageId}`)

      const link = args[0]
      const match = link.match(/chat.whatsapp.com\/([0-9A-Za-z]{20,24})/i)
      if (!match || !match[1]) {
        throw new Error("Invalid WhatsApp group invite link provided.")
      }
      const code = match[1]

      const groupId = await this.bridge.whatsappClient.groupAcceptInvite(code)

      if (!groupId || !groupId.endsWith("g.us")) {
        throw new Error("Failed to join the group. The link might be invalid or expired.")
      }

      const groupMetadata = await this.bridge.whatsappClient.groupMetadata(groupId)
      const groupName = groupMetadata?.subject || "Unknown Group"

      await this.bridge.telegramBot.editMessageText(`✅ Successfully joined WhatsApp group: *${groupName}*`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
      })
      logger.info(`Successfully joined WhatsApp group: ${groupName} (${groupId})`)
    } catch (error) {
      logger.error("Error joining WhatsApp group:", error)
      const errorMessage = `❌ **Failed to join group**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease ensure the link is valid and the bot is not already in the group.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited join group message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  async handleListGroups(chatId, page = 0, messageId = null) {
    try {
      const sentMessage = messageId
        ? null
        : await this.bridge.telegramBot.sendMessage(chatId, "🔄 Fetching joined WhatsApp groups...", {
            parse_mode: "Markdown",
          })
      messageId = messageId || sentMessage.message_id
      logger.debug(`Sent initial list groups message with ID: ${messageId}`)

      const groups = Object.values(await this.bridge.whatsappClient.groupFetchAllParticipating())
      if (groups.length === 0) {
        const noGroupsMessage = "⚠️ The bot has not joined any WhatsApp groups yet."
        if (messageId) {
          await this.bridge.telegramBot.editMessageText(noGroupsMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] }, // Clear buttons
          })
        } else {
          await this.bridge.telegramBot.sendMessage(chatId, noGroupsMessage, {
            parse_mode: "Markdown",
          })
        }
        return
      }

      const itemsPerPage = 10 // Number of groups per page
      const totalPages = Math.ceil(groups.length / itemsPerPage)
      const currentPage = Math.max(0, Math.min(page, totalPages - 1))

      const startIndex = currentPage * itemsPerPage
      const endIndex = Math.min(startIndex + itemsPerPage, groups.length)

      const groupList = groups
        .slice(startIndex, endIndex)
        .map((group, index) => {
          const name = group.subject || "Unknown Group"
          const participants = group.participants?.length || 0
          return `${startIndex + index + 1}. *${name}* (${participants} members)\n\`${group.id}\``
        })
        .join("\n\n")

      const message =
        `👥 *Joined WhatsApp Groups (${groups.length} total)*\n` +
        `📄 Page ${currentPage + 1} of ${totalPages}\n\n` +
        `${groupList}`

      // Create inline keyboard for pagination
      const keyboard = []
      const buttonRow = []

      if (currentPage > 0) {
        buttonRow.push({
          text: "Previous",
          callback_data: `listgroups_prev_${currentPage - 1}`,
        })
      }

      if (currentPage < totalPages - 1) {
        buttonRow.push({
          text: "Next",
          callback_data: `listgroups_next_${currentPage + 1}`,
        })
      }

      if (buttonRow.length > 0) {
        keyboard.push(buttonRow)
      }

      const options = {
        parse_mode: "Markdown",
        reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
      }

      await this.bridge.telegramBot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: options.reply_markup,
      })
      logger.debug(`Edited list groups message with ID: ${messageId} to show results.`)

      // Store pagination state
      this.paginationState.set(chatId, {
        type: "listgroups",
        currentPage: currentPage,
        totalPages: totalPages,
        totalItems: groups.length,
        messageId: messageId,
      })
    } catch (error) {
      logger.error("Error listing WhatsApp groups:", error)
      const errorMessage = `❌ **Failed to list groups**\n\nError: ${this.sanitizeOutput(error.message)}\n\nPlease try again or check the logs.`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(errorMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
        })
        logger.debug(`Edited list groups message with ID: ${messageId} to error.`)
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, errorMessage, { parse_mode: "Markdown" })
      }
    }
  }

  // Helper method to chunk arrays
  chunkArray(array, size) {
    const chunks = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  formatBytes(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"]
    if (bytes === 0) return "0 Bytes"
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
  }

  async handleSend(chatId, args) {
    if (args.length < 2) {
      return this.bridge.telegramBot.sendMessage(
        chatId,
        "❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!",
        { parse_mode: "Markdown" },
      )
    }

    const number = args[0].replace(/\D/g, "")
    const message = args.slice(1).join(" ")

    if (!/^\d{6,15}$/.test(number)) {
      return this.bridge.telegramBot.sendMessage(chatId, "❌ Invalid phone number format.", { parse_mode: "Markdown" })
    }

    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`

    try {
      const result = await this.bridge.whatsappClient.sendMessage(jid, { text: message })
      const response = result?.key?.id ? `✅ Message sent to ${number}` : `⚠️ Message sent, but no confirmation`
      await this.bridge.telegramBot.sendMessage(chatId, response, { parse_mode: "Markdown" })
    } catch (error) {
      logger.error(`Error sending message to ${number}:`, error)
      await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${this.sanitizeOutput(error.message)}`, {
        parse_mode: "Markdown",
      })
    }
  }

  async handleSearchContact(chatId, args, page = 0, messageId = null) {
    if (args.length === 0) {
      return this.bridge.telegramBot.sendMessage(
        chatId,
        "❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John",
        { parse_mode: "Markdown" },
      )
    }

    const query = args.join(" ").toLowerCase()
    const contacts = [...this.bridge.contactMappings.entries()]
    const matches = contacts.filter(([phone, name]) => phone.includes(query) || name?.toLowerCase().includes(query))

    if (matches.length === 0) {
      const noResultsMessage = `❌ No contacts found for "${query}"`
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(noResultsMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [] }, // Clear buttons
        })
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, noResultsMessage, {
          parse_mode: "Markdown",
        })
      }
      return
    }

    const itemsPerPage = 15
    const totalPages = Math.ceil(matches.length / itemsPerPage)
    const currentPage = Math.max(0, Math.min(page, totalPages - 1))

    const startIndex = currentPage * itemsPerPage
    const endIndex = Math.min(startIndex + itemsPerPage, matches.length)

    const result = matches
      .slice(startIndex, endIndex)
      .map(([phone, name], index) => `${startIndex + index + 1}. ${name || "Unknown"} (+${phone})`)
      .join("\n")

    const message =
      `🔍 *Search Results for "${query}"*\n` +
      `📊 Found ${matches.length} matches\n` +
      `📄 Page ${currentPage + 1} of ${totalPages}\n\n` +
      `${result}`

    // Create pagination buttons for search results
    const keyboard = []
    const buttonRow = []

    if (currentPage > 0) {
      buttonRow.push({
        text: "Previous",
        callback_data: `search_prev_${currentPage - 1}_${Buffer.from(query).toString("base64")}`,
      })
    }

    if (currentPage < totalPages - 1) {
      buttonRow.push({
        text: "Next",
        callback_data: `search_next_${currentPage + 1}_${Buffer.from(query).toString("base64")}`,
      })
    }

    if (buttonRow.length > 0) {
      keyboard.push(buttonRow)
    }

    const options = {
      parse_mode: "Markdown",
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    }

    if (messageId) {
      await this.bridge.telegramBot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: options.reply_markup,
      })
    } else {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, message, options)
      messageId = sentMessage.message_id
    }

    // Store pagination state
    this.paginationState.set(chatId, {
      type: "search",
      query: query,
      currentPage: currentPage,
      totalPages: totalPages,
      totalItems: matches.length,
      messageId: messageId, // Store message ID
    })
  }

  async handleAddFilter(chatId, args) {
    if (args.length === 0) {
      return this.bridge.telegramBot.sendMessage(chatId, "❌ Usage: /addfilter <word>", { parse_mode: "Markdown" })
    }

    const word = args.join(" ").toLowerCase()
    await this.bridge.addFilter(word)
    await this.bridge.telegramBot.sendMessage(chatId, `✅ Added filter: \`${word}\``, { parse_mode: "Markdown" })
  }

  async handleListFilters(chatId) {
    if (!this.bridge.filters?.size) {
      return this.bridge.telegramBot.sendMessage(chatId, "⚠️ No filters set.", { parse_mode: "Markdown" })
    }

    const list = [...this.bridge.filters].map((w) => `- \`${w}\``).join("\n")
    await this.bridge.telegramBot.sendMessage(chatId, `🛑 *Current Filters:*\n\n${list}`, { parse_mode: "Markdown" })
  }

  async handleClearFilters(chatId) {
    await this.bridge.clearFilters()
    await this.bridge.telegramBot.sendMessage(chatId, "🧹 All filters cleared.", { parse_mode: "Markdown" })
  }

  async handlePassword(chatId, args) {
    if (args.length === 0) {
      return this.bridge.telegramBot.sendMessage(chatId, "❌ Usage: /password <your_password>", {
        parse_mode: "Markdown",
      })
    }

    const password = args.join(" ")
    const userId = chatId // In private chat, chatId is the userId

    if (this.bridge.authenticateUser(userId, password)) {
      await this.bridge.telegramBot.sendMessage(
        chatId,
        "✅ Authentication successful! You can now use bot commands and reply to messages.",
        { parse_mode: "Markdown" },
      )
    } else {
      await this.bridge.telegramBot.sendMessage(chatId, "❌ Invalid password. Access denied.", {
        parse_mode: "Markdown",
      })
    }
  }

  async handleContacts(chatId, page = 0, messageId = null) {
    const contacts = [...this.bridge.contactMappings.entries()]
    if (contacts.length === 0) {
      const noContactsMessage = "⚠️ No contacts found."
      if (messageId) {
        await this.bridge.telegramBot.editMessageText(noContactsMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [] }, // Clear buttons
        })
      } else {
        await this.bridge.telegramBot.sendMessage(chatId, noContactsMessage, {
          parse_mode: "Markdown",
        })
      }
      return
    }

    const itemsPerPage = 20
    const totalPages = Math.ceil(contacts.length / itemsPerPage)
    const currentPage = Math.max(0, Math.min(page, totalPages - 1))

    const startIndex = currentPage * itemsPerPage
    const endIndex = Math.min(startIndex + itemsPerPage, contacts.length)

    const contactList = contacts
      .slice(startIndex, endIndex)
      .map(([phone, name], index) => `${startIndex + index + 1}. ${name || "Unknown"} (+${phone})`)
      .join("\n")

    const message =
      `📞 *Contacts (${contacts.length} total)*\n` +
      `📄 Page ${currentPage + 1} of ${totalPages}\n\n` +
      `${contactList}`

    // Create inline keyboard for pagination
    const keyboard = []
    const buttonRow = []

    if (currentPage > 0) {
      buttonRow.push({
        text: "Previous",
        callback_data: `contacts_prev_${currentPage - 1}`,
      })
    }

    if (currentPage < totalPages - 1) {
      buttonRow.push({
        text: "Next",
        callback_data: `contacts_next_${currentPage + 1}`,
      })
    }

    if (buttonRow.length > 0) {
      keyboard.push(buttonRow)
    }

    const options = {
      parse_mode: "Markdown",
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    }

    if (messageId) {
      await this.bridge.telegramBot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: options.reply_markup,
      })
    } else {
      const sentMessage = await this.bridge.telegramBot.sendMessage(chatId, message, options)
      messageId = sentMessage.message_id
    }

    // Store pagination state
    this.paginationState.set(chatId, {
      type: "contacts",
      currentPage: currentPage,
      totalPages: totalPages,
      totalItems: contacts.length,
      messageId: messageId, // Store message ID
    })
  }

  async handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id
    const messageId = callbackQuery.message.message_id
    const data = callbackQuery.data
    const userId = callbackQuery.from.id

    // Check authentication
    if (!this.bridge.isUserAuthenticated(userId)) {
      await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
        text: "🔒 Access denied. Use /password to authenticate.",
        show_alert: true,
      })
      return
    }

    try {
      if (data.startsWith("contacts_")) {
        const [action, direction, pageStr] = data.split("_")
        const page = Number.parseInt(pageStr)

        if (direction === "prev" || direction === "next") {
          await this.handleContacts(chatId, page, messageId)

          // Answer the callback query
          await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
            text: `📄 Page ${page + 1}`,
          })
        }
      } else if (data.startsWith("search_")) {
        const [action, direction, pageStr, encodedQuery] = data.split("_")
        const page = Number.parseInt(pageStr)
        const query = Buffer.from(encodedQuery, "base64").toString()

        if (direction === "prev" || direction === "next") {
          await this.handleSearchContact(chatId, [query], page, messageId)

          // Answer the callback query
          await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
            text: `📄 Page ${page + 1}`,
          })
        }
      } else if (data.startsWith("listgroups_")) {
        const [action, direction, pageStr] = data.split("_")
        const page = Number.parseInt(pageStr)

        if (direction === "prev" || direction === "next") {
          await this.handleListGroups(chatId, page, messageId)

          // Answer the callback query
          await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
            text: `📄 Page ${page + 1}`,
          })
        }
      }
    } catch (error) {
      logger.error("Error handling callback query:", error)
      await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Error occurred",
        show_alert: true,
      })
    }
  }

  async handleMenu(chatId) {
    const message =
      `ℹ️ *Available Commands*\n\n` +
      `/password <pass> - Authenticate to use bot\n` +
      `/start - Show bot info\n` +
      `/status - Show bridge status\n` +
      `/send <number> <msg> - Send WhatsApp message\n` +
      `/contacts [page] - List contacts (with pagination)\n` +
      `/searchcontact <name/phone> - Search WhatsApp contacts\n` +
      `/addfilter <word> - Block WA messages starting with it\n` +
      `/filters - Show current filters\n` +
      `/clearfilters - Remove all filters\n` +
      `/backup - Create database backup\n` +
      `/restore - Restore database from backup\n` +
      `/updatetopics - Update all topic names with latest contacts\n` +
      `/restart - Restart the bot\n` +
      `/updatebot - Update bot from GitHub\n` +
      `/joingroup <link> - Join a WhatsApp group via invite link\n` +
      `/listgroups [page] - List all joined WhatsApp groups\n\n` +
      `💡 *Tip:* Use the Previous/Next buttons to navigate through lists!`
    await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: "Markdown" })
  }

  async registerBotCommands() {
    try {
      await this.bridge.telegramBot.setMyCommands([
        { command: "start", description: "Show bot info" },
        { command: "status", description: "Show bridge status" },
        { command: "send", description: "Send WhatsApp message" },
        { command: "contacts", description: "List contacts" },
        { command: "searchcontact", description: "Search WhatsApp contacts" },
        { command: "addfilter", description: "Add blocked word" },
        { command: "filters", description: "Show blocked words" },
        { command: "clearfilters", description: "Clear all filters" },
        { command: "backup", description: "Create database backup" },
        { command: "restore", description: "Restore database from backup" },
        { command: "updatetopics", description: "Update all topic names" },
        { command: "restart", description: "Restart the bot" },
        { command: "updatebot", description: "Update bot from GitHub" },
        { command: "joingroup", description: "Join a WhatsApp group" },
        { command: "listgroups", description: "List all joined WhatsApp groups" },
        { command: "password", description: "Authenticate with password" },
      ])
      logger.debug("Telegram bot commands registered")
    } catch (error) {
      logger.error("Failed to register Telegram bot commands:", error)
    }
  }
}

module.exports = TelegramCommands
