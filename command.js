const logger = require("../system/logger")

class TelegramCommands {
  constructor(bridge) {
    this.bridge = bridge
    this.paginationState = new Map() // Add this line to track pagination state
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
      await this.bridge.telegramBot.sendMessage(
        msg.chat.id,
        "🔒 Access denied. Use /password [your_password] to authenticate.",
        { parse_mode: "Markdown" },
      )
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
        case "/sync":
          await this.handleSync(msg.chat.id)
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
        default:
          await this.handleMenu(msg.chat.id)
      }
    } catch (error) {
      logger.error(`Error handling command ${command}:`, error)
      await this.bridge.telegramBot.sendMessage(msg.chat.id, `❌ Command error: ${error.message}`, {
        parse_mode: "Markdown",
      })
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
    const whatsapp = this.bridge.whatsappClient
    const userName = whatsapp?.user?.name || "Unknown"

    const status =
      `📊 *Bridge Status*\n\n` +
      `🔗 WhatsApp: ${whatsapp ? "✅ Connected" : "❌ Disconnected"}\n` +
      `👤 User: ${userName}\n` +
      `💬 Chats: ${this.bridge.chatMappings?.size || 0}\n` +
      `👥 Users: ${this.bridge.userMappings?.size || 0}\n` +
      `📞 Contacts: ${this.bridge.contactMappings?.size || 0}`
    await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: "Markdown" })
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
      await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: "Markdown" })
    }
  }

  async handleSync(chatId) {
    // This function is now handled in telegram-bridge.js to allow message editing
    // It's kept here for completeness but the actual logic is in the bridge
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
      .map(([phone, name], index) => `${startIndex + index + 1}. 📱 ${name || "Unknown"} (+${phone})`)
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
        text: "⬅️ Previous",
        callback_data: `search_prev_${currentPage - 1}_${Buffer.from(query).toString("base64")}`,
      })
    }

    if (currentPage < totalPages - 1) {
      buttonRow.push({
        text: "Next ➡️",
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
      .map(([phone, name], index) => `${startIndex + index + 1}. 📱 ${name || "Unknown"} (+${phone})`)
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
        text: "⬅️ Previous",
        callback_data: `contacts_prev_${currentPage - 1}`,
      })
    }

    if (currentPage < totalPages - 1) {
      buttonRow.push({
        text: "Next ➡️",
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
      `/sync - Sync WhatsApp contacts\n` +
      `/contacts [page] - List contacts (with pagination)\n` +
      `/searchcontact <name/phone> - Search contacts (with pagination)\n` +
      `/addfilter <word> - Block WA messages starting with it\n` +
      `/filters - Show current filters\n` +
      `/clearfilters - Remove all filters\n\n` +
      `💡 *Tip:* Use the Previous/Next buttons to navigate through contacts!`
    await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: "Markdown" })
  }

  async registerBotCommands() {
    try {
      await this.bridge.telegramBot.setMyCommands([
        { command: "password", description: "Authenticate with password" },
        { command: "start", description: "Show bot info" },
        { command: "status", description: "Show bridge status" },
        { command: "send", description: "Send WhatsApp message" },
        { command: "sync", description: "Sync WhatsApp contacts" },
        { command: "contacts", description: "List contacts" },
        { command: "searchcontact", description: "Search WhatsApp contacts" },
        { command: "addfilter", description: "Add blocked word" },
        { command: "filters", description: "Show blocked words" },
        { command: "clearfilters", description: "Clear all filters" },
      ])
      logger.debug("Telegram bot commands registered")
    } catch (error) {
      logger.error("Failed to register Telegram bot commands:", error)
    }
  }
}

module.exports = TelegramCommands
