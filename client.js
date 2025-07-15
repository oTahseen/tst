// process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
require("./error"), (require("events").EventEmitter.defaultMaxListeners = 500)
const { Component } = require("@neoxr/wb")
const { Baileys, Function: Func, Config: env } = new Component()
require("./lib/system/functions"), require("./lib/system/scraper"), require("./lib/system/config")
const cron = require("node-cron")
const fs = require("fs")
const colors = require("@colors/colors")
// REMOVED: const { NodeCache } = require("@cacheable/node-cache")
// REMOVED: const cache = new NodeCache({ stdTTL: env.cooldown })

// Add at the top with other requires
const TelegramBridge = require("./lib/bridge/telegram-bridge")

// Add this variable after other declarations
let telegramBridge = null

const connect = async () => {
  try {
    // Documentation : https://github.com/neoxr/session
    const session =
      process?.env?.DATABASE_URL && /mongo/.test(process.env.DATABASE_URL)
        ? require("@session/mongo").useMongoAuthState
        : process?.env?.DATABASE_URL && /postgres/.test(process.env.DATABASE_URL)
          ? require("@session/postgres").usePostgresAuthState
          : null

    // Documentation : https://github.com/neoxr/database
    const database = await (process?.env?.DATABASE_URL && /mongo/.test(process.env.DATABASE_URL)
      ? require("@database/mongo").createDatabase(process.env.DATABASE_URL, env.database, "database")
      : process?.env?.DATABASE_URL && /postgres/.test(process.env.DATABASE_URL)
        ? require("@database/postgres").createDatabase(process.env.DATABASE_URL, env.database)
        : require("@database/local").createDatabase(env.database))

    const client = new Baileys(
      {
        type: "--neoxr-v1",
        plugsdir: "plugins",
        session: session ? session(process.env.DATABASE_URL, "session") : "session",
        online: true,
        bypass_disappearing: true,
        bot: (id) => {
          // Detect message from bot by message ID, you can add another logic here
          return id && ((id.startsWith("3EB0") && id.length === 40) || id.startsWith("BAE") || /[-]/.test(id))
        },
        code: "", // Custom pairing code 8 chars (e.g: NEOXRBOT)
        version: [2, 3000, 1022545672], // To see the latest version : https://wppconnect.io/whatsapp-versions/
      },
      {
        browser: ["Windows", "Chrome", "137.0.7151.107"],
        shouldIgnoreJid: (jid) => {
          return /(newsletter|bot)/.test(jid)
        },
      },
    )

    /* starting to connect */
    client.once("connect", async (res) => {
      /* load database */
      global.db = {
        users: [],
        chats: [],
        groups: [],
        statistic: {},
        sticker: {},
        setting: {},
        bridge: {
          chatMappings: {},
          userMappings: {},
          contactMappings: {},
          filters: [],
        },
        processedMessages: {}, // Initialize new field
        antiDeleteSpam: {}, // Initialize new field
        ...((await database.fetch()) || {}),
      }

      // Ensure bridge object exists
      if (!global.db.bridge) {
        global.db.bridge = {
          chatMappings: {},
          userMappings: {},
          contactMappings: {},
          filters: [],
        }
      }
      // Ensure new fields exist (redundant if initialized above, but good for safety)
      if (!global.db.processedMessages) {
        global.db.processedMessages = {}
      }
      if (!global.db.antiDeleteSpam) {
        global.db.antiDeleteSpam = {}
      }

      /* save database */
      await database.save(global.db)

      /* write connection log */
      if (res && typeof res === "object" && res.message) Func.logFile(res.message)
    })

    /* print error */
    client.once("error", async (error) => {
      console.error(colors.red(error.message))
      if (error && typeof error === "object" && error.message) Func.logFile(error.message)
    })

    /* bot is connected */
    client.once("ready", async () => {
      // telegram bridge initialization - wait a bit for database to be fully ready
      await new Promise((resolve) => setTimeout(resolve, 2000))

      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        try {
          telegramBridge = new TelegramBridge(client.sock, database)
          global.telegramBridge = telegramBridge // Set global reference immediately

          await telegramBridge.initialize()

          // Force reload mappings after initialization to ensure they're current
          await telegramBridge.loadMappingsFromDb()
          await telegramBridge.setupWhatsAppHandlers() // Setup WhatsApp handlers for the bridge

          await telegramBridge.sendStartMessage()
        } catch (error) {
          console.error(colors.red("❌ Failed to start Telegram bridge:"), error)
          global.telegramBridge = null // Clear global reference on error
        }
      } else {
        console.warn(colors.yellow("⚠️ Telegram bridge disabled - missing environment variables"))
        global.telegramBridge = null
      }

      /* auto restart if ram usage is over */
      const ramCheck = setInterval(() => {
        var ramUsage = process.memoryUsage().rss
        if (ramUsage >= require("bytes")(env.ram_limit)) {
          clearInterval(ramCheck)
          process.send("reset")
        }
      }, 60 * 1000) // check ram usage every 1 min

      /* create temp directory if doesn't exists */
      if (!fs.existsSync("./temp")) fs.mkdirSync("./temp")

      /* clear temp folder every 10 minutes */
      setInterval(
        async () => {
          try {
            const tmpFiles = fs.readdirSync("./temp")
            if (tmpFiles.length > 0) {
              tmpFiles.filter((v) => !v.endsWith(".file")).map((v) => fs.unlinkSync("./temp/" + v))
            }
          } catch {}
        },
        60 * 1000 * 10,
      ) // clear ./temp folder every 10 mins

      /* save database every 5 mins */
      setInterval(
        async () => {
          if (global.db) {
            await database.save(global.db)
            // Also save bridge mappings if bridge exists
            if (global.telegramBridge) {
              await global.telegramBridge.saveMappingsToDb()
            }
          }
        },
        60 * 1000 * 5,
      )

      // New: Cleanup for processedMessages (e.g., older than 10 minutes)
      setInterval(
        async () => {
          const now = new Date().getTime()
          const tenMinutesAgo = now - 10 * 60 * 1000 // 10 minutes in milliseconds

          let cleanedCount = 0
          for (const msgId in global.db.processedMessages) {
            if (global.db.processedMessages[msgId] < tenMinutesAgo) {
              delete global.db.processedMessages[msgId]
              cleanedCount++
            }
          }
          if (cleanedCount > 0) {
            console.log(colors.cyan(`🧹 Cleaned up ${cleanedCount} old processed message IDs from database.`))
            await database.save(global.db) // Save after cleanup
          }
        },
        5 * 60 * 1000,
      ) // Run cleanup every 5 minutes

      // New: Cleanup for antiDeleteSpam (based on env.cooldown, which is 1 second)
      setInterval(async () => {
        const now = new Date().getTime()
        const cooldownMs = env.cooldown * 1000 // Convert seconds to milliseconds

        let cleanedCount = 0
        for (const senderJid in global.db.antiDeleteSpam) {
          if (global.db.antiDeleteSpam[senderJid] < now - cooldownMs) {
            delete global.db.antiDeleteSpam[senderJid]
            cleanedCount++
          }
        }
        if (cleanedCount > 0) {
          console.log(colors.cyan(`🧹 Cleaned up ${cleanedCount} old anti-delete spam entries from database.`))
          await database.save(global.db) // Save after cleanup
        }
      }, env.cooldown * 1000) // Run cleanup every `cooldown` seconds

      /* backup database every day at 12:00 PM (send .json file to owner) */
      cron.schedule("0 12 * * *", async () => {
        if (global?.db?.setting?.autobackup) {
          await database.save(global.db)
          fs.writeFileSync(env.database + ".json", JSON.stringify(global.db, null, 3), "utf-8")
          await client.sock.sendFile(
            env.owner + "@s.whatsapp.net",
            fs.readFileSync("./" + env.database + ".json"),
            env.database + ".json",
            "",
            null,
          )
        }
      })
    })

    /* print all message object */
    client.register("message", (ctx) => {
      require("./handler")(client.sock, { ...ctx, database })
      require("./lib/system/baileys")(client.sock)
    })

    /* stories reaction */
    client.register("stories", async (ctx) => {
      if (ctx.message.key && ctx.sender !== client.sock.decodeJid(client.sock.user.id))
        await client.sock.sendMessage(
          "status@broadcast",
          {
            react: {
              text: Func.random(["🤣", "🥹", "😂", "😋", "😎", "🤓", "🤪", "🥳", "😠", "😱", "🤔"]),
              key: ctx.message.key,
            },
          },
          {
            statusJidList: [ctx.sender],
          },
        )
    })

    /* print deleted message object */
    client.register("message.delete", (ctx) => {
      const sock = client.sock
      if (!ctx || ctx.message?.key?.fromMe || ctx.message?.isBot || !ctx.message?.sender) return
      // Use database for anti-delete spam check
      if (global.db.antiDeleteSpam[ctx.message.sender]) {
        // If sender is already in antiDeleteSpam, it means they recently triggered it
        // or a message from them was recently deleted and we're preventing multiple responses.
        return
      }
      // Mark sender as active for anti-delete for the cooldown period
      global.db.antiDeleteSpam[ctx.message.sender] = new Date().getTime()

      if (Object.keys(ctx.message) < 1) return
      if (
        ctx.message.isGroup &&
        global.db &&
        global.db.groups &&
        global.db.groups.some((v) => v.jid == ctx.message.chat) &&
        global.db.groups.find((v) => v.jid == ctx.message.chat).antidelete
      )
        return sock.copyNForward(ctx.message.chat, ctx.message)
    })

    /* AFK detector */
    client.register("presence.update", (update) => {
      if (!update) return
      const sock = client.sock
      const { id, presences } = update
      if (id.endsWith("g.us")) {
        for (const jid in presences) {
          if (!presences[jid] || jid == sock.decodeJid(sock.user.id)) continue
          if (
            (presences[jid].lastKnownPresence === "composing" || presences[jid].lastKnownPresence === "recording") &&
            global.db &&
            global.db.users &&
            global.db.users.find((v) => v.jid == jid) &&
            global.db.users.find((v) => v.jid == jid).afk > -1
          ) {
            sock.reply(
              id,
              `System detects activity from @${jid.replace(/@.+/, "")} after being offline for : ${Func.texted("bold", Func.toTime(new Date() - global.db.users.find((v) => v.jid == jid).afk))}\n\n➠ ${Func.texted("bold", "Reason")} : ${global.db.users.find((v) => v.jid == jid).afkReason ? global.db.users.find((v) => v.jid == jid).afkReason : "-"}`,
              global.db.users.find((v) => v.jid == jid).afkObj,
            )
            global.db.users.find((v) => v.jid == jid).afk = -1
            global.db.users.find((v) => v.jid == jid).afkReason = ""
            global.db.users.find((v) => v.jid == jid).afkObj = {}
          }
        }
      } else {
      }
    })

    client.register("group.add", async (ctx) => {
      const sock = client.sock
      const text = `Thanks +tag for joining into +grup group.`
      const groupSet = global.db.groups.find((v) => v.jid == ctx.jid)
      if (!global.db || !global.db.groups) return
      let pic
      try {
        pic = await sock.profilePictureUrl(ctx.member, "image")
        if (!pic) {
          pic = fs.readFileSync("./media/image/default.jpg")
        }
      } catch {
        pic = fs.readFileSync("./media/image/default.jpg")
      }

      /* localonly to remove new member when the number not from indonesia */
      if (groupSet && groupSet.localonly) {
        if (
          (global.db.users.some((v) => v.jid == ctx.member) &&
            !global.db.users.find((v) => v.jid == ctx.member).whitelist &&
            !ctx.member.startsWith("62")) ||
          !ctx.member.startsWith("62")
        ) {
          sock.reply(
            ctx.jid,
            Func.texted(
              "bold",
              `Sorry @${ctx.member.split("@")[0]}, this group is only for indonesian people and you will removed automatically.`,
            ),
          )
          sock.updateBlockStatus(ctx.member, "block")
          return await Func.delay(2000).then(() => sock.groupParticipantsUpdate(ctx.jid, [ctx.member], "remove"))
        }
      }

      const txt = (groupSet && groupSet.text_welcome ? groupSet.text_welcome : text)
        .replace("+tag", `@${ctx.member.split("@")[0]}`)
        .replace("+grup", `${ctx.subject}`)
      if (groupSet && groupSet.welcome)
        sock.sendMessageModify(ctx.jid, txt, null, {
          largeThumb: true,
          thumbnail: pic,
          url: global.db.setting.link,
        })
    })

    client.register("group.remove", async (ctx) => {
      const sock = client.sock
      const text = `Good bye +tag :)`
      if (!global.db || !global.db.groups) return
      const groupSet = global.db.groups.find((v) => v.jid == ctx.jid)
      let pic
      try {
        pic = await sock.profilePictureUrl(ctx.member, "image")
        if (!pic) {
          pic = fs.readFileSync("./media/image/default.jpg")
        }
      } catch {
        pic = fs.readFileSync("./media/image/default.jpg")
      }
      const txt = (groupSet && groupSet.text_left ? groupSet.text_left : text)
        .replace("+tag", `@${ctx.member.split("@")[0]}`)
        .replace("+grup", `${ctx.subject}`)
      if (groupSet && groupSet.left)
        sock.sendMessageModify(ctx.jid, txt, null, {
          largeThumb: true,
          thumbnail: pic,
          url: global.db.setting.link,
        })
    })

    client.register("caller", (ctx) => {
      if (typeof ctx === "boolean") return
      client.sock.updateBlockStatus(ctx.jid, "block")
    })

    // client.on('group.promote', ctx => console.log(ctx))
    // client.on('group.demote', ctx => console.log(ctx))
  } catch (e) {
    throw new Error(e)
  }
}

connect().catch(() => connect())
