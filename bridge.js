const TelegramBot = require("node-telegram-bot-api")
const TelegramCommands = require("./telegram-commands")
const logger = require("../system/logger")
const fs = require("fs").promises
const path = require("path")
const axios = require("axios")
const sharp = require("sharp")
const mime = require("mime-types")
const ffmpeg = require("fluent-ffmpeg")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const qrcode = require("qrcode")
const { downloadContentFromMessage } = require("@adiwajshing/baileys")
const FormData = require("form-data")

class TelegramBridge {
  constructor(whatsappClient, database) {
    this.whatsappClient = whatsappClient
    this.database = database
    this.telegramBot = null
    this.commands = null
    this.chatMappings = new Map()
    this.userMappings = new Map()
    this.contactMappings = new Map()
    this.profilePicCache = new Map()
    this.tempDir = path.join(__dirname, "../../temp")
    this.isProcessing = false
    this.activeCallNotifications = new Map()
    this.statusMessageMapping = new Map()
    this.presenceTimeout = null
    this.botChatId = null
    this.messageQueue = new Map()
    this.lastPresenceUpdate = new Map()
    this.topicVerificationCache = new Map()
    this.creatingTopics = new Map()
    this.filters = new Set()
    this.authenticatedUsers = new Map() // userId -> { authenticated: true, timestamp: Date }
    this.authTimeout = 24 * 60 * 60 * 1000 // 24 hours in milliseconds
    this.password = process.env.TELEGRAM_PASSWORD || "admin123"
    this.sudoUsers = new Set((process.env.TELEGRAM_SUDO_USERS || "").split(",").filter((id) => id.trim()))
    this.config = {
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || "",
        chatId: process.env.TELEGRAM_CHAT_ID || "",
        logChannel: process.env.TELEGRAM_LOG_CHANNEL || "",
        enabled: true,
        features: {
          presenceUpdates: true,
          readReceipts: true,
          sendOutgoingMessages: false,
          statusSync: true,
          callLogs: true,
          profilePicSync: true,
          welcomeMessage: process.env.TELEGRAM_WELCOME_MESSAGE !== "false", // Default true unless explicitly set to false
          autoViewStatus: true, // New feature flag
        },
      },
    }
  }

  async initialize() {
    const token = this.config.telegram.botToken
    const chatId = this.config.telegram.chatId

    if (!token || token.includes("YOUR_BOT_TOKEN") || !chatId || chatId.includes("YOUR_CHAT_ID")) {
      logger.warn("⚠️ Telegram bot token or chat ID not configured")
      return
    }

    try {
      await fs.mkdir(this.tempDir, { recursive: true })

      this.telegramBot = new TelegramBot(token, {
        polling: true,
        onlyFirstMatch: true,
      })

      this.commands = new TelegramCommands(this)
      await this.commands.registerBotCommands()
      await this.setupTelegramHandlers()
      await this.loadMappingsFromDb()
      await this.loadFiltersFromDb()

      // Wait for WhatsApp to be ready before syncing
      if (this.whatsappClient?.user) {
        await this.syncContacts()
        await this.updateTopicNames()
      }

      logger.info("✅ Telegram bridge initialized")
    } catch (error) {
      logger.error("❌ Failed to initialize Telegram bridge:", error)
    }
  }

  async loadMappingsFromDb() {
    try {
      if (!global.db.bridge) {
        global.db.bridge = {
          chatMappings: {},
          userMappings: {},
          contactMappings: {},
          filters: [],
        }
        logger.info("📊 Created new bridge data structure in database")
      }

      const bridgeData = global.db.bridge

      this.chatMappings = new Map()
      this.userMappings = new Map()
      this.contactMappings = new Map()
      this.filters = new Set()

      if (bridgeData.chatMappings && typeof bridgeData.chatMappings === "object") {
        for (const [jid, chatMapData] of Object.entries(bridgeData.chatMappings)) {
          // chatMapData is expected to be { telegramTopicId: number, profilePicUrl: string, lastActivity: Date }
          // Handle both new object format and old direct number format for topicId
          const topicId =
            typeof chatMapData === "object" && chatMapData !== null ? chatMapData.telegramTopicId : chatMapData // Fallback for old format

          if (jid && typeof topicId === "number") {
            this.chatMappings.set(jid, topicId)
            if (typeof chatMapData === "object" && chatMapData.profilePicUrl) {
              this.profilePicCache.set(jid, chatMapData.profilePicUrl)
            }
          }
        }
      }

      if (bridgeData.userMappings && typeof bridgeData.userMappings === "object") {
        for (const [jid, userData] of Object.entries(bridgeData.userMappings)) {
          if (jid && userData) {
            this.userMappings.set(jid, userData)
          }
        }
      }

      if (bridgeData.contactMappings && typeof bridgeData.contactMappings === "object") {
        for (const [phone, name] of Object.entries(bridgeData.contactMappings)) {
          if (phone && name) {
            this.contactMappings.set(phone, name)
          }
        }
      }

      if (Array.isArray(bridgeData.filters)) {
        bridgeData.filters.forEach((filter) => {
          if (filter && typeof filter === "string") {
            this.filters.add(filter)
          }
        })
      }

      logger.info(
        `📊 Loaded mappings from DB: ${this.chatMappings.size} chats, ${this.userMappings.size} users, ${this.contactMappings.size} contacts, ${this.filters.size} filters`,
      )
    } catch (error) {
      logger.error("❌ Failed to load mappings from database:", error)
      this.chatMappings = new Map()
      this.userMappings = new Map()
      this.contactMappings = new Map()
      this.filters = new Set()
    }
  }

  async saveMappingsToDb() {
    try {
      if (!global.db.bridge) {
        global.db.bridge = {}
      }

      const chatMappingsObj = {}
      const userMappingsObj = {}
      const contactMappingsObj = {}

      for (const [jid, topicId] of this.chatMappings.entries()) {
        if (jid && topicId && typeof topicId === "number") {
          chatMappingsObj[jid] = {
            telegramTopicId: topicId,
            profilePicUrl: this.profilePicCache.get(jid) || null,
            lastActivity: new Date(),
          }
        }
      }

      for (const [jid, userData] of this.userMappings.entries()) {
        if (jid && userData) {
          userMappingsObj[jid] = userData
        }
      }

      for (const [phone, name] of this.contactMappings.entries()) {
        if (phone && name) {
          contactMappingsObj[phone] = name
        }
      }

      global.db.bridge.chatMappings = chatMappingsObj
      global.db.bridge.userMappings = userMappingsObj
      global.db.bridge.contactMappings = contactMappingsObj
      global.db.bridge.filters = Array.from(this.filters).filter((f) => f && typeof f === "string")

      if (this.database && typeof this.database.save === "function") {
        await this.database.save(global.db)
      }

      logger.info(
        `✅ Saved bridge mappings: ${Object.keys(chatMappingsObj).length} chats, ${Object.keys(userMappingsObj).length} users, ${Object.keys(contactMappingsObj).length} contacts`,
      )
    } catch (error) {
      logger.error("❌ Failed to save mappings to database:", error)
    }
  }

  async loadFiltersFromDb() {
    try {
      const bridgeData = global.db.bridge || {}
      this.filters = new Set()
      if (Array.isArray(bridgeData.filters)) {
        bridgeData.filters.forEach((filter) => {
          if (filter && typeof filter === "string") {
            this.filters.add(filter)
          }
        })
      }
      logger.info(`✅ Loaded ${this.filters.size} filters from DB`)
    } catch (error) {
      logger.error("❌ Failed to load filters:", error)
      this.filters = new Set()
    }
  }

  async addFilter(word) {
    this.filters.add(word)
    await this.saveMappingsToDb()
  }

  async clearFilters() {
    this.filters.clear()
    await this.saveMappingsToDb()
  }

  isUserAuthenticated(userId) {
    // Check if user is sudo user
    if (this.sudoUsers.has(userId.toString())) {
      return true
    }

    // Check if user is authenticated and not expired
    const authData = this.authenticatedUsers.get(userId)
    if (!authData) return false

    const now = Date.now()
    if (now - authData.timestamp > this.authTimeout) {
      this.authenticatedUsers.delete(userId)
      return false
    }

    return authData.authenticated
  }

  authenticateUser(userId, password) {
    if (password === this.password) {
      this.authenticatedUsers.set(userId, {
        authenticated: true,
        timestamp: Date.now(),
      })
      return true
    }
    return false
  }

  async setupTelegramHandlers() {
    this.telegramBot.on(
      "message",
      this.wrapHandler(async (msg) => {
        logger.debug(
          `Received Telegram message. Chat ID: ${msg.chat.id}, Type: ${msg.chat.type}, Is Topic Message: ${msg.is_topic_message}, Message Keys: ${Object.keys(msg).join(", ")}`,
        )
        if (msg.chat.type === "private") {
          this.botChatId = msg.chat.id
          await this.commands.handleCommand(msg)
        } else if (msg.chat.type === "supergroup" && msg.is_topic_message) {
          await this.handleTelegramMessage(msg)
        }
      }),
    )

    this.telegramBot.on("polling_error", (error) => {
      logger.error("Telegram polling error:", error)
    })

    this.telegramBot.on("error", (error) => {
      logger.error("Telegram bot error:", error)
    })

    logger.info("📱 Telegram message handlers set up")
  }

  wrapHandler(handler) {
    return async (...args) => {
      try {
        await handler(...args)
      } catch (error) {
        logger.error("❌ Unhandled error in Telegram handler:", error)
      }
    }
  }

  async syncMessage(whatsappMsg, text) {
    if (!this.telegramBot || !this.config.telegram.enabled) {
      return
    }

    const sender = whatsappMsg.key.remoteJid
    const participant = whatsappMsg.key.participant || sender
    const isFromMe = whatsappMsg.key.fromMe

    if (sender === "status@broadcast") {
      await this.handleStatusMessage(whatsappMsg, text)
      return
    }

    if (isFromMe) {
      const existingTopicId = this.chatMappings.get(sender)
      if (existingTopicId) {
        await this.syncOutgoingMessage(whatsappMsg, text, existingTopicId, sender)
      }
      return
    }

    await this.createUserMapping(participant, whatsappMsg)
    const topicId = await this.getOrCreateTopic(sender, whatsappMsg)

    if (!topicId) {
      return
    }

    const messageContent = whatsappMsg.message || {}

    if (messageContent.stickerMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "sticker", topicId)
    } else if (messageContent.ptvMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "video_note", topicId)
    } else if (messageContent.videoMessage?.ptv) {
      await this.handleWhatsAppMedia(whatsappMsg, "video_note", topicId)
    } else if (messageContent.imageMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "image", topicId)
    } else if (messageContent.videoMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "video", topicId)
    } else if (messageContent.audioMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "audio", topicId)
    } else if (messageContent.documentMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "document", topicId)
    } else if (messageContent.locationMessage) {
      await this.handleWhatsAppLocation(whatsappMsg, topicId)
    } else if (messageContent.contactMessage) {
      await this.handleWhatsAppContact(whatsappMsg, topicId)
    } else if (messageContent.viewOnceMessage) {
      await this.handleWhatsAppMedia(whatsappMsg, "view_once", topicId)
    } else if (text) {
      let messageText = text
      if (sender.endsWith("@g.us") && participant !== sender) {
        const senderPhone = participant.split("@")[0]
        const senderName = this.contactMappings.get(senderPhone) || senderPhone
        messageText = `👤 ${senderName}:\n${text}`
      }

      await this.sendSimpleMessage(topicId, messageText, sender)
    }

    if (whatsappMsg.key?.id && this.config.telegram.features.readReceipts !== false) {
      this.queueMessageForReadReceipt(sender, whatsappMsg.key)
    }
  }

  async getOrCreateTopic(chatJid, whatsappMsg) {
    if (this.chatMappings.has(chatJid)) {
      const existingTopicId = this.chatMappings.get(chatJid)
      return existingTopicId
    }

    if (this.creatingTopics.has(chatJid)) {
      return await this.creatingTopics.get(chatJid)
    }

    const creationPromise = (async () => {
      const chatId = this.config.telegram.chatId
      if (!chatId || chatId.includes("YOUR_CHAT_ID")) {
        logger.error("❌ Telegram chat ID not configured")
        return null
      }

      try {
        const isGroup = chatJid.endsWith("@g.us")
        const isStatus = chatJid === "status@broadcast"
        const isCall = chatJid === "call@broadcast"

        let topicName,
          iconColor = 0x7aba3c

        if (isStatus) {
          topicName = `📊 Status Updates`
          iconColor = 0xff6b35
        } else if (isCall) {
          topicName = `📞 Call Logs`
          iconColor = 0xff4757
        } else if (isGroup) {
          try {
            const groupMeta = await this.whatsappClient.groupMetadata(chatJid)
            topicName = groupMeta.subject
          } catch {
            topicName = `Group Chat`
          }
          iconColor = 0x6fb9f0
        } else {
          const phone = chatJid.split("@")[0]
          const contactName = this.contactMappings.get(phone)
          topicName = contactName || `+${phone}`
        }

        const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
          icon_color: iconColor,
        })

        let profilePicUrl = null
        if (!isStatus && !isCall) {
          try {
            profilePicUrl = await this.whatsappClient.profilePictureUrl(chatJid, "image")
          } catch {}
        }

        this.chatMappings.set(chatJid, topic.message_thread_id)
        await this.saveMappingsToDb()

        logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for ${chatJid}`)

        if (!isStatus && !isCall && this.config.telegram.features.welcomeMessage) {
          await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, whatsappMsg, profilePicUrl)
        }

        return topic.message_thread_id
      } catch (error) {
        logger.error("❌ Failed to create Telegram topic:", error)
        return null
      } finally {
        this.creatingTopics.delete(chatJid)
      }
    })()

    this.creatingTopics.set(chatJid, creationPromise)
    return await creationPromise
  }

  async sendWelcomeMessage(topicId, jid, isGroup, whatsappMsg, initialProfilePicUrl = null) {
    try {
      const chatId = this.config.telegram.chatId
      const phone = jid.split("@")[0]
      const contactName = this.contactMappings.get(phone) || `+${phone}`
      const participant = whatsappMsg.key.participant || jid
      const userInfo = this.userMappings.get(participant)
      const handleName = whatsappMsg.pushName || userInfo?.name || "Unknown"

      let welcomeText = ""

      if (isGroup) {
        try {
          const groupMeta = await this.whatsappClient.groupMetadata(jid)
          welcomeText =
            `🏷️ **Group Information**\n\n` +
            `📝 **Name:** ${groupMeta.subject}\n` +
            `👥 **Participants:** ${groupMeta.participants.length}\n` +
            `🆔 **Group ID:** \`${jid}\`\n` +
            `📅 **Created:** ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\n` +
            `💬 Messages from this group will appear here`
        } catch (error) {
          welcomeText = `🏷️ **Group Chat**\n\n💬 Messages from this group will appear here`
          logger.warn(`Could not fetch group metadata for ${jid}:`, error)
        }
      } else {
        let userStatus = ""
        try {
          const status = await this.whatsappClient.fetchStatus(jid)
          if (status?.status) {
            userStatus = `📝 **Status:** ${status.status}\n`
          }
        } catch (error) {
          logger.debug(`Could not fetch status for ${jid}:`, error)
        }

        welcomeText =
          `👤 **Contact Information**\n\n` +
          `📝 **Name:** ${contactName}\n` +
          `📱 **Phone:** +${phone}\n` +
          `🖐️ **Handle:** ${handleName}\n` +
          userStatus +
          `🆔 **WhatsApp ID:** \`${jid}\`\n` +
          `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n` +
          `💬 Messages with this contact will appear here`
      }

      let sentMessage

      // If profile picture exists, send it with welcome text as caption
      if (initialProfilePicUrl) {
        sentMessage = await this.telegramBot.sendPhoto(chatId, initialProfilePicUrl, {
          message_thread_id: topicId,
          caption: welcomeText,
          parse_mode: "Markdown",
        })

        // Cache the profile picture URL
        this.profilePicCache.set(jid, initialProfilePicUrl)
        await this.saveMappingsToDb()
      } else {
        // No profile picture, send just the welcome text
        sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
          message_thread_id: topicId,
          parse_mode: "Markdown",
        })
      }

      await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id)
    } catch (error) {
      logger.error("❌ Failed to send welcome message:", error)
    }
  }

  async sendSimpleMessage(topicId, text, sender) {
    const chatId = this.config.telegram.chatId

    try {
      const sentMessage = await this.telegramBot.sendMessage(chatId, text, {
        message_thread_id: topicId,
      })
      return sentMessage.message_id
    } catch (error) {
      const desc = error.response?.data?.description || error.message

      if (desc.includes("message thread not found")) {
        logger.warn(`🗑️ Topic ID ${topicId} for sender ${sender} is missing. Recreating...`)

        const jidEntry = [...this.chatMappings.entries()].find(([jid, tId]) => tId === topicId)
        const jid = jidEntry?.[0]

        if (jid) {
          this.chatMappings.delete(jid)
          this.profilePicCache.delete(jid)
          await this.saveMappingsToDb()

          // Simple recreation without dummy message
          const newTopicId = await this.getOrCreateTopic(jid, { key: { remoteJid: jid } })

          if (newTopicId) {
            try {
              const retryMessage = await this.telegramBot.sendMessage(chatId, text, {
                message_thread_id: newTopicId,
              })
              return retryMessage.message_id
            } catch (retryErr) {
              logger.error("❌ Retry failed after topic recreation:", retryErr)
              return null
            }
          }
        } else {
          logger.warn(`⚠️ Could not find WhatsApp JID for topic ID ${topicId}`)
        }
      }

      logger.error("❌ Failed to send message to Telegram:", desc)
      return null
    }
  }

  async handleTelegramMessage(msg) {
    try {
      const topicId = msg.message_thread_id
      const whatsappJid = this.findWhatsAppJidByTopic(topicId)

      if (!whatsappJid) {
        logger.warn("⚠️ Could not find WhatsApp chat for Telegram message")
        return
      }

      // Check authentication for topic messages
      const userId = msg.from.id
      if (!this.isUserAuthenticated(userId)) {
        await this.telegramBot.sendMessage(
          msg.chat.id,
          "🔒 Access denied. Use /password [your_password] to authenticate.",
          {
            message_thread_id: topicId,
          },
        )
        return
      }

      await this.sendTypingPresence(whatsappJid)

      if (whatsappJid === "status@broadcast" && msg.reply_to_message) {
        await this.handleStatusReply(msg)
        return
      }

      if (msg.photo) {
        await this.handleTelegramPhoto(msg, whatsappJid)
      } else if (msg.video) {
        await this.handleTelegramVideo(msg, whatsappJid)
      } else if (msg.animation) {
        await this.handleTelegramVideo(msg, whatsappJid) // Telegram animations are videos
      } else if (msg.video_note) {
        await this.handleTelegramVideoNote(msg, whatsappJid)
      } else if (msg.voice) {
        await this.handleTelegramVoice(msg, whatsappJid)
      } else if (msg.audio) {
        await this.handleTelegramAudio(msg, whatsappJid)
      } else if (msg.document) {
        await this.handleTelegramDocument(msg, whatsappJid)
      } else if (msg.sticker) {
        await this.handleTelegramSticker(msg, whatsappJid)
      } else if (msg.location) {
        await this.handleTelegramLocation(msg, whatsappJid)
      } else if (msg.contact) {
        await this.handleTelegramContact(msg, whatsappJid)
      } else if (msg.text) {
        await this.handleTelegramText(msg, whatsappJid)
      }

      setTimeout(async () => {
        await this.sendPresence(whatsappJid, "available")
      }, 2000)
    } catch (error) {
      logger.error("❌ Failed to handle Telegram message:", error.message, error.stack, error.response?.data)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramText(msg, whatsappJid) {
    const originalText = msg.text.trim()
    const textLower = originalText.toLowerCase()

    for (const word of this.filters || []) {
      if (textLower.startsWith(word)) {
        logger.info(`🛑 Blocked Telegram ➝ WhatsApp message due to filter "${word}": ${originalText}`)
        await this.setReaction(msg.chat.id, msg.message_id, "🚫")
        return
      }
    }

    const messageOptions = { text: originalText }
    if (msg.entities && msg.entities.some((entity) => entity.type === "spoiler")) {
      messageOptions.text = `🫥 ${originalText}`
    }

    const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

    if (sendResult?.key?.id) {
      await this.setReaction(msg.chat.id, msg.message_id, "👍")

      setTimeout(async () => {
        await this.queueMessageForReadReceipt(whatsappJid, sendResult.key)
      }, 1000)
    }
  }

  async handleTelegramPhoto(msg, whatsappJid) {
    try {
      const photo = msg.photo[msg.photo.length - 1]
      const buffer = await this.downloadTelegramMedia(photo.file_id)

      if (buffer) {
        const messageOptions = {
          image: buffer,
          caption: msg.caption || "",
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward photo to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramVideo(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.video?.file_id || msg.animation?.file_id)

      if (buffer) {
        const messageOptions = {
          video: buffer,
          caption: msg.caption || "",
          mimetype: "video/mp4",
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward video to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramVideoNote(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.video_note.file_id)

      if (buffer) {
        const messageOptions = {
          video: buffer,
          caption: "🎥 Video Note",
          mimetype: "video/mp4",
          ptv: true,
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward video note to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramVoice(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.voice.file_id)

      if (buffer) {
        const messageOptions = {
          audio: buffer,
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward voice to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramAudio(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.audio.file_id)

      if (buffer) {
        const messageOptions = {
          audio: buffer,
          mimetype: "audio/mp4",
          ptt: false,
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward audio to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramDocument(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.document.file_id)

      if (buffer) {
        const messageOptions = {
          document: buffer,
          mimetype: msg.document.mime_type || "application/octet-stream",
          fileName: msg.document.file_name || "document",
          caption: msg.caption || "",
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward document to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramSticker(msg, whatsappJid) {
    try {
      const buffer = await this.downloadTelegramMedia(msg.sticker.file_id)

      if (buffer) {
        const sticker = new Sticker(buffer, {
          pack: "Telegram Bridge",
          author: "Neoxr Bot",
          type: StickerTypes.FULL,
          quality: 50,
        })

        const stickerBuffer = await sticker.toBuffer()

        const messageOptions = {
          sticker: stickerBuffer,
        }

        const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

        if (sendResult?.key?.id) {
          await this.setReaction(msg.chat.id, msg.message_id, "👍")
        }
      }
    } catch (error) {
      logger.error("❌ Failed to forward sticker to WhatsApp:", error.message, error.stack)
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async handleTelegramLocation(msg, whatsappJid) {
    try {
      const messageOptions = {
        location: {
          degreesLatitude: msg.location.latitude,
          degreesLongitude: msg.location.longitude,
        },
      }

      const sendResult = await this.whatsappClient.sendMessage(whatsappJid, messageOptions)

      if (sendResult?.key?.id) {
        await this.setReaction(msg.chat.id, msg.message_id, "👍")
      }
    } catch (error) {
      logger.error("❌ Failed to forward location to WhatsApp:", error.message, error.stack)
    }
  }

  async handleTelegramContact(msg, whatsappJid) {
    const sendContact = async (finalTopicId) => {
      try {
        const chatId = this.config.telegram.chatId
        const contactMsg = msg.message.contactMessage

        const participant = msg.key.participant || msg.key.remoteJid
        const phone = participant.split("@")[0]
        const senderName = this.contactMappings.get(phone) || `+${phone}`
        const isGroup = msg.key.remoteJid.endsWith("@g.us")

        let phoneNumber = ""
        if (contactMsg.vcard) {
          const phoneMatch = contactMsg.vcard.match(/TEL[^:]*:([^\n\r]+)/i)
          if (phoneMatch) {
            phoneNumber = phoneMatch[1].trim().replace(/[^\d+]/g, "")
          }
        }

        // Send as Telegram contact if we have a phone number
        if (phoneNumber) {
          await this.telegramBot.sendContact(chatId, phoneNumber, contactMsg.displayName || "Contact", {
            message_thread_id: finalTopicId,
          })
        } else {
          // Fallback to text message if no phone number
          let caption = `👤 Contact: ${contactMsg.displayName}`
          if (isGroup && participant !== msg.key.remoteJid) {
            caption = `👤 ${senderName} shared a contact:\n${contactMsg.displayName}`
          }
          await this.telegramBot.sendMessage(chatId, caption, {
            message_thread_id: finalTopicId,
          })
        }
      } catch (error) {
        const desc = error.response?.data?.description || error.message
        if (desc.includes("message thread not found")) {
          logger.warn(`🗑️ Contact topic deleted. Recreating...`)
          const sender = msg.key.remoteJid
          this.chatMappings.delete(sender)
          this.profilePicCache.delete(sender)
          await this.saveMappingsToDb()
          const newTopicId = await this.getOrCreateTopic(sender, msg)
          if (newTopicId) {
            await sendContact(newTopicId)
          }
        } else {
          logger.error("❌ Failed to handle contact:", desc)
        }
      }
    }
    const topicId = msg.message_thread_id
    await sendContact(topicId)
  }

  async handleStatusMessage(whatsappMsg, text) {
    try {
      if (!this.config.telegram.features.statusSync) return

      const participant = whatsappMsg.key.participant
      const phone = participant.split("@")[0]
      const contactName = this.contactMappings.get(phone) || `+${phone}`

      const topicId = await this.getOrCreateTopic("status@broadcast", whatsappMsg)
      if (!topicId) return

      let statusText = `📱 *Status from ${contactName}* (+${phone})`

      if (text) {
        statusText += `\n\n${text}`
      }

      const chatId = this.config.telegram.chatId

      const mediaType = this.getMediaType(whatsappMsg)
      if (mediaType && mediaType !== "text") {
        await this.forwardStatusMedia(whatsappMsg, topicId, statusText, mediaType)
      } else {
        const sentMsg = await this.telegramBot.sendMessage(chatId, statusText, {
          message_thread_id: topicId,
          parse_mode: "Markdown",
        })

        this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key)
      }

      if (this.config.telegram.features.autoViewStatus) {
        await this.whatsappClient.readMessages([whatsappMsg.key])
      }
    } catch (error) {
      const desc = error.response?.data?.description || error.message
      if (desc.includes("message thread not found")) {
        logger.warn(`🗑️ Status topic deleted. Recreating and retrying...`)

        this.chatMappings.delete("status@broadcast")
        this.profilePicCache.delete("status@broadcast")
        await this.saveMappingsToDb()

        // Use existing recreation pattern - just retry the function
        await this.handleStatusMessage(whatsappMsg, text)
      } else {
        logger.error("❌ Error handling status message:", error)
      }
    }
  }

  async forwardStatusMedia(whatsappMsg, topicId, caption, mediaType) {
    try {
      const mediaData = await this._downloadWhatsAppMediaContent(whatsappMsg)
      if (!mediaData || !mediaData.buffer) throw new Error("Failed to download media content from WhatsApp.")

      const { buffer, mimetype, filename } = mediaData
      const chatId = this.config.telegram.chatId

      let sentMsg
      switch (mediaType) {
        case "image":
          sentMsg = await this.telegramBot.sendPhoto(chatId, buffer, {
            message_thread_id: topicId,
            caption: caption,
            parse_mode: "Markdown",
          })
          break
        case "video":
          sentMsg = await this.telegramBot.sendVideo(chatId, buffer, {
            message_thread_id: topicId,
            caption: caption,
            parse_mode: "Markdown",
          })
          break
        case "audio":
          sentMsg = await this.telegramBot.sendAudio(chatId, buffer, {
            message_thread_id: topicId,
            caption: caption,
            parse_mode: "Markdown",
          })
          break
      }

      if (sentMsg) {
        this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key)
      }
    } catch (error) {
      const desc = error.response?.data?.description || error.message
      if (desc.includes("message thread not found")) {
        logger.warn(`🗑️ Status media topic deleted. Recreating and retrying...`)

        this.chatMappings.delete("status@broadcast")
        this.profilePicCache.delete("status@broadcast")
        await this.saveMappingsToDb()

        const newTopicId = await this.getOrCreateTopic("status@broadcast", whatsappMsg)
        if (newTopicId) {
          // Retry with new topic ID
          await this.forwardStatusMedia(whatsappMsg, newTopicId, caption, mediaType)
        }
      } else {
        logger.error("❌ Error forwarding status media:", error)
        await this.telegramBot.sendMessage(
          this.config.telegram.chatId,
          `❌ Failed to forward status media from ${caption.split("*")[1].split("*")[0]}`,
          {
            message_thread_id: topicId,
            parse_mode: "Markdown",
          },
        )
      }
    }
  }

  getMediaType(msg) {
    if (msg.message?.imageMessage) return "image"
    if (msg.message?.videoMessage) return "video"
    if (msg.message?.audioMessage) return "audio"
    if (msg.message?.documentMessage) return "document"
    if (msg.message?.stickerMessage) return "sticker"
    if (msg.message?.locationMessage) return "location"
    if (msg.message?.contactMessage) return "contact"
    return "text"
  }

  async syncOutgoingMessage(whatsappMsg, text, topicId, sender) {
    if (!this.config.telegram.features.sendOutgoingMessages) return
    try {
      const messageContent = whatsappMsg.message || {}

      if (messageContent.stickerMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "sticker", topicId, true)
      } else if (messageContent.ptvMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "video_note", topicId, true)
      } else if (messageContent.videoMessage?.ptv) {
        await this.handleWhatsAppMedia(whatsappMsg, "video_note", topicId, true)
      } else if (messageContent.imageMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "image", topicId, true)
      } else if (messageContent.videoMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "video", topicId, true)
      } else if (messageContent.audioMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "audio", topicId, true)
      } else if (messageContent.documentMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "document", topicId, true)
      } else if (messageContent.locationMessage) {
        await this.handleWhatsAppLocation(whatsappMsg, topicId, true)
      } else if (messageContent.contactMessage) {
        await this.handleWhatsAppContact(whatsappMsg, topicId, true)
      } else if (messageContent.viewOnceMessage) {
        await this.handleWhatsAppMedia(whatsappMsg, "view_once", topicId, true)
      } else if (text) {
        const messageText = `📤 You: ${text}`
        await this.sendSimpleMessage(topicId, messageText, sender)
      }
    } catch (error) {
      logger.error("❌ Failed to sync outgoing message:", error)
    }
  }

  queueMessageForReadReceipt(chatJid, messageKey) {
    if (!this.config.telegram.features.readReceipts) return

    if (!this.messageQueue.has(chatJid)) {
      this.messageQueue.set(chatJid, [])
    }

    this.messageQueue.get(chatJid).push(messageKey)

    setTimeout(() => {
      this.processReadReceipts(chatJid)
    }, 2000)
  }

  async processReadReceipts(chatJid) {
    try {
      const messages = this.messageQueue.get(chatJid)
      if (!messages || messages.length === 0) return

      if (this.whatsappClient) {
        await this.whatsappClient.readMessages(messages)
        logger.debug(`📖 Marked ${messages.length} messages as read in ${chatJid}`)
      }

      this.messageQueue.set(chatJid, [])
    } catch (error) {
      logger.warn("Failed to send read receipts:", error)
    }
  }

  async createUserMapping(participant, whatsappMsg) {
    if (this.userMappings.has(participant)) {
      const userData = this.userMappings.get(participant)
      userData.messageCount = (userData.messageCount || 0) + 1
      this.userMappings.set(participant, userData)
      await this.saveMappingsToDb()
      return
    }

    let userName = null
    const userPhone = participant.split("@")[0]

    try {
      if (this.contactMappings.has(userPhone)) {
        userName = this.contactMappings.get(userPhone)
      }
    } catch (error) {
      logger.debug("Could not fetch contact info:", error)
    }

    const userData = {
      name: userName,
      phone: userPhone,
      firstSeen: new Date(),
      messageCount: 1,
    }

    this.userMappings.set(participant, userData)
    await this.saveMappingsToDb()
    logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`)
  }

  async sendProfilePicture(topicId, jid, isUpdate = false) {
    try {
      if (!this.config.telegram.features.profilePicSync) {
        logger.debug(`📸 Profile pic sync disabled for ${jid}`)
        return
      }

      logger.debug(`📸 Checking profile picture for ${jid} (update: ${isUpdate})`)

      let currentProfilePicUrl = null
      try {
        currentProfilePicUrl = await this.whatsappClient.profilePictureUrl(jid, "image")
        logger.debug(`📸 Current profile pic URL for ${jid}: ${currentProfilePicUrl || "none"}`)
      } catch (error) {
        logger.debug(`📸 No profile picture found for ${jid}: ${error.message}`)
      }

      const cachedProfilePicUrl = this.profilePicCache.get(jid)
      logger.debug(`📸 Cached profile pic URL for ${jid}: ${cachedProfilePicUrl || "none"}`)

      if (currentProfilePicUrl === cachedProfilePicUrl) {
        logger.debug(`📸 ⏭️ Profile picture URL unchanged for ${jid}, skipping send`)
        return
      }

      if (currentProfilePicUrl) {
        const caption = isUpdate ? "📸 Profile picture updated" : "📸 Profile Picture"

        logger.info(`📸 Sending ${isUpdate ? "updated" : "initial"} profile picture for ${jid}`)

        await this.telegramBot.sendPhoto(this.config.telegram.chatId, currentProfilePicUrl, {
          message_thread_id: topicId,
          caption: caption,
        })

        this.profilePicCache.set(jid, currentProfilePicUrl)
        await this.saveMappingsToDb()
        logger.info(`📸 ✅ Profile picture ${isUpdate ? "update" : "sent"} for ${jid}`)
      } else {
        logger.debug(`📸 No profile picture available for ${jid}`)
      }
    } catch (error) {
      logger.error(`📸 ❌ Could not send profile picture for ${jid}:`, error)
    }
  }

  async sendProfilePictureWithUrl(topicId, jid, profilePicUrl, isUpdate = false) {
    try {
      if (!this.config.telegram.features.profilePicSync) {
        logger.debug(`📸 Profile pic sync disabled for ${jid}`)
        return
      }

      if (!profilePicUrl) {
        logger.debug(`📸 No profile picture URL provided for ${jid}`)
        return
      }

      const caption = isUpdate ? "📸 Profile picture updated" : "📸 Profile Picture"

      logger.info(`📸 Sending ${isUpdate ? "updated" : "initial"} profile picture for ${jid}`)

      await this.telegramBot.sendPhoto(this.config.telegram.chatId, profilePicUrl, {
        message_thread_id: topicId,
        caption: caption,
      })

      this.profilePicCache.set(jid, profilePicUrl)
      await this.saveMappingsToDb()
      logger.info(`📸 ✅ Profile picture ${isUpdate ? "update" : "sent"} for ${jid}`)
    } catch (error) {
      logger.error(`📸 ❌ Could not send profile picture for ${jid}:`, error)
    }
  }

  async handleCallNotification(callEvent) {
    if (!this.telegramBot || !this.config.telegram.features.callLogs) return

    const callerId = callEvent.from
    const callKey = `${callerId}_${callEvent.id}`

    if (this.activeCallNotifications.has(callKey)) return

    this.activeCallNotifications.set(callKey, true)
    setTimeout(() => {
      this.activeCallNotifications.delete(callKey)
    }, 30000)

    try {
      const phone = callerId.split("@")[0]
      const callerName = this.contactMappings.get(phone) || `+${phone}`

      const topicId = await this.getOrCreateTopic("call@broadcast", {
        key: { remoteJid: "call@broadcast", participant: callerId },
      })

      if (!topicId) {
        logger.error("❌ Could not create call topic")
        return
      }

      const callMessage =
        `📞 **Incoming Call**\n\n` +
        `👤 **From:** ${callerName}\n` +
        `📱 **Number:** +${phone}\n` +
        `⏰ **Time:** ${new Date().toLocaleString()}\n` +
        `📋 **Status:** ${callEvent.status || "Incoming"}`

      await this.telegramBot.sendMessage(this.config.telegram.chatId, callMessage, {
        message_thread_id: topicId,
        parse_mode: "Markdown",
      })

      logger.info(`📞 Sent call notification from ${callerName}`)
    } catch (error) {
      const desc = error.response?.data?.description || error.message
      if (desc.includes("message thread not found")) {
        logger.warn(`🗑️ Call topic deleted. Recreating and retrying...`)

        this.chatMappings.delete("call@broadcast")
        this.profilePicCache.delete("call@broadcast")
        await this.saveMappingsToDb()

        const newTopicId = await this.getOrCreateTopic("call@broadcast", {
          key: { remoteJid: "call@broadcast", participant: callerId },
        })

        if (newTopicId) {
          // Retry sending the call notification with new topic
          const phone = callerId.split("@")[0]
          const callerName = this.contactMappings.get(phone) || `+${phone}`

          const callMessage =
            `📞 **Incoming Call**\n\n` +
            `👤 **From:** ${callerName}\n` +
            `📱 **Number:** +${phone}\n` +
            `⏰ **Time:** ${new Date().toLocaleString()}\n` +
            `📋 **Status:** ${callEvent.status || "Incoming"}`

          await this.telegramBot.sendMessage(this.config.telegram.chatId, callMessage, {
            message_thread_id: newTopicId,
            parse_mode: "Markdown",
          })

          logger.info(`📞 Sent call notification from ${callerName} after topic recreation`)
        }
      } else {
        logger.error("❌ Error handling call notification:", error)
      }
    }
  }

  async handleStatusReply(msg) {
    try {
      const originalStatusKey = this.statusMessageMapping.get(msg.reply_to_message.message_id)
      if (!originalStatusKey) {
        await this.telegramBot.sendMessage(msg.chat.id, "❌ Cannot find original status to reply to", {
          message_thread_id: msg.message_thread_id,
        })
        return
      }

      const statusJid = originalStatusKey.participant
      const phone = statusJid.split("@")[0]
      const contactName = this.contactMappings.get(phone) || `+${phone}`

      const messageOptions = {
        text: msg.text,
        contextInfo: {
          quotedMessage: originalStatusKey.message,
          stanzaId: originalStatusKey.id,
          participant: originalStatusKey.participant,
          remoteJid: "status@broadcast",
        },
      }

      const sendResult = await this.whatsappClient.sendMessage(statusJid, messageOptions)

      if (sendResult?.key?.id) {
        await this.telegramBot.sendMessage(msg.chat.id, `✅ Status reply sent to ${contactName}`, {
          message_thread_id: msg.message_thread_id,
        })
        await this.setReaction(msg.chat.id, msg.message_id, "✅")
        logger.info(`✅ Sent status reply to ${statusJid} for ${contactName}`)
      } else {
        throw new Error("Failed to send status reply")
      }
    } catch (error) {
      logger.error("❌ Failed to handle status reply:", error)
      await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send reply to ${contactName || "contact"}`, {
        message_thread_id: msg.message_thread_id,
      })
      await this.setReaction(msg.chat.id, msg.message_id, "❌")
    }
  }

  async sendPresence(jid, presenceType = "available") {
    try {
      if (!this.whatsappClient || !this.config.telegram.features.presenceUpdates) return

      const now = Date.now()
      const lastUpdate = this.lastPresenceUpdate.get(jid) || 0

      if (now - lastUpdate < 1000) return

      this.lastPresenceUpdate.set(jid, now)

      await this.whatsappClient.sendPresenceUpdate(presenceType, jid)
      logger.debug(`👁️ Sent presence update: ${presenceType} to ${jid}`)
    } catch (error) {
      logger.debug("Failed to send presence:", error)
    }
  }

  async sendTypingPresence(jid) {
    try {
      if (!this.whatsappClient || !this.config.telegram.features.presenceUpdates) return

      await this.sendPresence(jid, "composing")

      if (this.presenceTimeout) {
        clearTimeout(this.presenceTimeout)
      }

      this.presenceTimeout = setTimeout(async () => {
        try {
          await this.sendPresence(jid, "paused")
        } catch (error) {
          logger.debug("Failed to send paused presence:", error)
        }
      }, 3000)
    } catch (error) {
      logger.debug("Failed to send typing presence:", error)
    }
  }

  async recreateMissingTopics() {
    try {
      logger.info("🔄 Checking for missing topics...")
      const toRecreate = []

      for (const [jid, topicId] of this.chatMappings.entries()) {
        const exists = await this.verifyTopicExists(topicId)
        if (!exists) {
          logger.warn(`🗑️ Topic ${topicId} for ${jid} was deleted, will recreate...`)
          toRecreate.push(jid)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      for (const jid of toRecreate) {
        this.chatMappings.delete(jid)
        this.profilePicCache.delete(jid)
        await this.saveMappingsToDb()

        const dummyMsg = {
          key: {
            remoteJid: jid,
            participant: jid.endsWith("@g.us") ? jid : jid,
          },
        }
        await this.getOrCreateTopic(jid, dummyMsg)

        logger.info(`✅ Recreated topic for ${jid}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      if (toRecreate.length > 0) {
        logger.info(`✅ Recreated ${toRecreate.length} missing topics`)
      }
    } catch (error) {
      logger.error("❌ Error recreating missing topics:", error)
    }
  }

  async verifyTopicExists(topicId) {
    if (this.topicVerificationCache.has(topicId)) {
      return this.topicVerificationCache.get(topicId)
    }

    try {
      const chatId = this.config.telegram.chatId
      // Attempt to get chat info for the topic. If it fails, the topic doesn't exist.
      await this.telegramBot.getForumTopic(chatId, topicId)
      this.topicVerificationCache.set(topicId, true)
      return true
    } catch (error) {
      if (
        error.response &&
        error.response.data &&
        error.response.data.description.includes("message thread not found")
      ) {
        this.topicVerificationCache.set(topicId, false)
        return false
      }
      logger.error(`❌ Error verifying topic ${topicId}:`, error.message)
      this.topicVerificationCache.set(topicId, false)
      return false
    }
  }

  async sendQRCode(qrData) {
    if (!this.telegramBot) {
      throw new Error("Telegram bot not initialized")
    }

    const chatId = this.config.telegram.chatId
    if (!chatId) {
      throw new Error("Telegram chat ID not configured")
    }

    try {
      const qrImagePath = path.join(this.tempDir, `qr_${Date.now()}.png`)
      await qrcode.toFile(qrImagePath, qrData, {
        width: 512,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      })

      await this.telegramBot.sendPhoto(chatId, qrImagePath, {
        caption:
          "📱 *WhatsApp QR Code*\n\n" +
          "🔄 Scan this QR code with WhatsApp to connect\n" +
          "⏰ QR code expires in 30 seconds\n\n" +
          "💡 Open WhatsApp → Settings → Linked Devices → Link a Device",
        parse_mode: "Markdown",
      })

      setTimeout(async () => {
        try {
          await fs.unlink(qrImagePath)
        } catch (error) {
          logger.warn("QR code file cleanup error:", error)
        }
      }, 60000)

      logger.info("✅ QR code sent to Telegram successfully")
    } catch (error) {
      logger.error("❌ Error sending QR code to Telegram:", error)
      throw error
    }
  }

  async sendQRCodeToChannel(qrData, channelId) {
    if (!this.telegramBot) {
      throw new Error("Telegram bot not initialized")
    }

    try {
      const qrImagePath = path.join(this.tempDir, `qr_channel_${Date.now()}.png`)
      await qrcode.toFile(qrImagePath, qrData, {
        width: 512,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      })

      await this.telegramBot.sendPhoto(channelId, qrImagePath, {
        caption:
          "📱 *WhatsApp QR Code (Log Channel)*\n\n" +
          "🔄 Scan this QR code with WhatsApp to connect\n" +
          "⏰ QR code expires in 30 seconds",
        parse_mode: "Markdown",
      })

      setTimeout(async () => {
        try {
          await fs.unlink(qrImagePath)
        } catch (error) {
          logger.warn("QR code file cleanup error:", error)
        }
      }, 60000)

      logger.info("✅ QR code sent to Telegram log channel successfully")
    } catch (error) {
      logger.error("❌ Error sending QR code to log channel:", error)
      throw error
    }
  }

  async sendStartMessage() {
    try {
      if (!this.telegramBot) return

      const chatId = this.config.telegram.chatId
      const logChannel = this.config.telegram.logChannel

      const startMessage =
        `🚀 *Neoxr WhatsApp Bridge Started!*\n\n` +
        `✅ WhatsApp: Connected\n` +
        `✅ Telegram Bridge: Active\n` +
        `📞 Contacts: ${this.contactMappings.size} synced\n` +
        `💬 Chats: ${this.chatMappings.size} mapped\n` +
        `🔗 Ready to bridge messages!\n\n` +
        `⏰ Started at: ${new Date().toLocaleString()}`

      if (chatId && !chatId.includes("YOUR_CHAT_ID")) {
        await this.telegramBot.sendMessage(chatId, startMessage, {
          parse_mode: "Markdown",
        })
      }

      if (logChannel && !logChannel.includes("YOUR_LOG_CHANNEL")) {
        await this.telegramBot.sendMessage(logChannel, startMessage, {
          parse_mode: "Markdown",
        })
      }

      logger.info("🚀 Start message sent to Telegram")
    } catch (error) {
      logger.error("❌ Failed to send start message to Telegram:", error)
    }
  }

  extractText(msg) {
    return (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      msg.message?.audioMessage?.caption ||
      ""
    )
  }

  async streamToBuffer(stream) {
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async setupWhatsAppHandlers() {
    if (!this.whatsappClient) {
      logger.warn("⚠️ WhatsApp client not available for setting up handlers")
      return
    }

    // Enhanced contact sync and topic name update handlers
    this.whatsappClient.ev.on("contacts.update", async (contacts) => {
      try {
        let updatedCount = 0
        for (const contact of contacts) {
          if (contact.id && contact.name) {
            const phone = contact.id.split("@")[0]
            const oldName = this.contactMappings.get(phone)

            // Only update if it's a real contact name (not handle name)
            if (
              contact.name !== phone &&
              !contact.name.startsWith("+") &&
              contact.name.length > 2 &&
              oldName !== contact.name
            ) {
              this.contactMappings.set(phone, contact.name)
              logger.info(`📞 Updated contact: ${phone} -> ${contact.name}`)
              updatedCount++

              // Update topic name immediately
              const jid = contact.id
              if (this.chatMappings.has(jid)) {
                const topicId = this.chatMappings.get(jid)
                try {
                  logger.debug(`📝 Updating topic ${topicId} name from "${oldName || "unknown"}" to "${contact.name}"`)

                  await this.telegramBot.editForumTopic(this.config.telegram.chatId, topicId, {
                    name: contact.name,
                  })

                  logger.info(`📝 ✅ Updated topic name for ${phone}: "${contact.name}"`)
                } catch (error) {
                  logger.error(`📝 ❌ Could not update topic name for ${phone}:`, error.message)
                }
              }
            }
          }

          // Check for profile picture updates
          if (contact.id && this.chatMappings.has(contact.id)) {
            const topicId = this.chatMappings.get(contact.id)
            await this.sendProfilePicture(topicId, contact.id, true)
          }
        }
        if (updatedCount > 0) {
          logger.info(`✅ Processed ${updatedCount} contact updates`)
          await this.saveMappingsToDb()
        }
      } catch (error) {
        logger.error("❌ Failed to process contact updates:", error)
      }
    })

    this.whatsappClient.ev.on("contacts.upsert", async (contacts) => {
      try {
        let newCount = 0
        for (const contact of contacts) {
          if (contact.id && contact.name) {
            const phone = contact.id.split("@")[0]
            // Only save real contact names
            if (
              contact.name !== phone &&
              !contact.name.startsWith("+") &&
              contact.name.length > 2 &&
              !this.contactMappings.has(phone)
            ) {
              this.contactMappings.set(phone, contact.name)
              logger.info(`📞 New contact: ${phone} -> ${contact.name}`)
              newCount++

              // Update topic name if topic exists
              const jid = contact.id
              if (this.chatMappings.has(jid)) {
                const topicId = this.chatMappings.get(jid)
                try {
                  logger.debug(`📝 Updating new contact topic ${topicId} to "${contact.name}"`)

                  await this.telegramBot.editForumTopic(this.config.telegram.chatId, topicId, {
                    name: contact.name,
                  })

                  logger.info(`📝 ✅ Updated new contact topic name for ${phone}: "${contact.name}"`)
                } catch (error) {
                  logger.error(`📝 ❌ Could not update new contact topic name for ${phone}:`, error.message)
                }
              }
            }
          }
        }
        if (newCount > 0) {
          logger.info(`✅ Added ${newCount} new contacts`)
          await this.saveMappingsToDb()
        }
      } catch (error) {
        logger.error("❌ Failed to process new contacts:", error)
      }
    })

    this.whatsappClient.ev.on("call", async (callEvents) => {
      for (const callEvent of callEvents) {
        await this.handleCallNotification(callEvent)
      }
    })

    logger.info("📱 WhatsApp event handlers set up for Telegram bridge")
  }

  async shutdown() {
    logger.info("🛑 Shutting down Telegram bridge...")

    try {
      await this.saveMappingsToDb()
      logger.info("💾 Bridge mappings saved before shutdown")
    } catch (error) {
      logger.error("❌ Failed to save mappings during shutdown:", error)
    }

    if (this.presenceTimeout) {
      clearTimeout(this.presenceTimeout)
    }

    if (this.telegramBot) {
      try {
        await this.telegramBot.stopPolling()
        logger.info("📱 Telegram bot polling stopped.")
      } catch (error) {
        logger.warn("Error stopping Telegram polling:", error)
      }
    }

    try {
      const tmpFiles = await fs.readdir(this.tempDir)
      for (const file of tmpFiles) {
        await fs.unlink(path.join(this.tempDir, file))
      }
      logger.info("🧹 Temp directory cleaned.")
    } catch (error) {
      logger.warn("Could not clean temp directory:", error)
    }

    logger.info("✅ Telegram bridge shutdown complete.")
  }
}

module.exports = TelegramBridge
