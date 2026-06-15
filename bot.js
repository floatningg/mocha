process.stdout.write("\x1Bc");
process.on("uncaughtException", err => {
  console.error("uncaught exception")
  console.error(err)
})

process.on("unhandledRejection", err => {
  console.error("unhandled rejection")
  console.error(err)
})

const webServer = require("./server");

const logBuffer = [];
const MAX_LOGS = 200;

// real console output (never intercepted)
const rawLog = console.log;

// capture-only logger
function log(...args) {
  const msg = args.join(" ");
  logBuffer.push(msg);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  rawLog(msg);
}

// UI renderer (DO NOT feed into buffer)
function ui(str) {
  process.stdout.write(str + "\n");
}

require("dotenv").config({ path: __dirname + '/.env' })
// Ensure ADMIN_PASSWORD is set
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = 'floatn-pp96';
}

const {
  Client,
  GatewayIntentBits,
  Partials,
  Options,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js")

const sqlite3 = require("sqlite3").verbose()

const OWNER_ID = process.env.OWNER_ID || "338401360137551874"

if (!process.env.TOKEN) {
  console.error("TOKEN missing in .env")
  process.exit(1)
} else {
  console.log("token exists");
}
const db = new sqlite3.Database("./economy.db")
const intervals = [];

console.log("initializing");
const { runMyntax } = require("./myntax");
console.log("myntax init");
db.serialize(() => {
  // Build master table with level system and inventory
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      wallet INTEGER DEFAULT 5,
      bank INTEGER DEFAULT 0,
      bankspace INTEGER DEFAULT 5000,
      multiplier REAL DEFAULT 1,
      lastwork INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      inventory TEXT DEFAULT '[]',
      current_job TEXT DEFAULT 'fast_food',
      spouse_id TEXT DEFAULT NULL,
      marriage_date INTEGER DEFAULT 0,
      trivia_streak INTEGER DEFAULT 0,
      businesses TEXT DEFAULT '{}',
      quests TEXT DEFAULT '{}',
      last_channel TEXT DEFAULT NULL,
      prefix TEXT DEFAULT NULL
    )
  `)

  // Safely execute alterations to support legacy tables gracefully
  db.run("ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0", () => {})
  db.run("ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 0", () => {})
  db.run("ALTER TABLE users ADD COLUMN inventory TEXT DEFAULT '[]'", () => {})
  db.run("ALTER TABLE users ADD COLUMN current_job TEXT DEFAULT 'fast_food'", () => {})
  db.run("ALTER TABLE users ADD COLUMN spouse_id TEXT DEFAULT NULL", () => {})
  db.run("ALTER TABLE users ADD COLUMN marriage_date INTEGER DEFAULT 0", () => {})
  db.run("ALTER TABLE users ADD COLUMN trivia_streak INTEGER DEFAULT 0", () => {})
  db.run("ALTER TABLE users ADD COLUMN businesses TEXT DEFAULT '{}'", () => {})
  db.run("ALTER TABLE users ADD COLUMN quests TEXT DEFAULT '{}'", () => {})
  db.run("ALTER TABLE users ADD COLUMN last_channel TEXT DEFAULT NULL", () => {})
  db.run("ALTER TABLE users ADD COLUMN prefix TEXT DEFAULT NULL", () => {})

  // Speed optimization: index the user wealth search to make leaderboard queries lightning fast
  db.run("CREATE INDEX IF NOT EXISTS idx_users_wealth ON users (wallet, bank)", () => {})
  db.run("CREATE INDEX IF NOT EXISTS idx_users_level ON users (level)", () => {})

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)

  db.run(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('prefix', '!')
  `)

  db.run(`
    INSERT OR IGNORE INTO settings(key,value)
    VALUES('status_mode','none')
  `)

  db.run(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('inflation', '1.00')
  `)

  db.run(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('general_bank', '500000000')
  `)

  db.run(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('rotating_statuses', '{"statuses":["with the economy","with fire","with code"],"duration":15}')
  `)

  db.run(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('static_status', 'with the economy')
  `)
})

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],

  partials: [Partials.Channel],

  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    VoiceStateManager: 0
  }),

  sweepers: {
    messages: {
      interval: 30,
      lifetime: 60
    }
  },

  failIfNotExists: false
})

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err)
      else resolve(row)
    })
  })
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

async function getPrefix(userId) {
  if (userId) {
    const user = await get(`SELECT prefix FROM users WHERE id=?`, [userId])
    if (user?.prefix) return user.prefix
  }
  const row = await get(`SELECT value FROM settings WHERE key='prefix'`)
  return row?.value || "!"
}

async function getInflation() {
  const row = await get(
    `SELECT value FROM settings WHERE key='inflation'`
  )
  return parseFloat(row?.value || "1")
}

async function setInflation(value) {
  await run(
    `UPDATE settings SET value=? WHERE key='inflation'`,
    [value.toFixed(2)]
  )
}

async function getGeneralBank() {
  const row = await get(
    `SELECT value FROM settings WHERE key='general_bank'`
  )
  return parseInt(row?.value || "0")
}

async function addToGeneralBank(amount) {
  await run(
    `UPDATE settings SET value = CAST(value AS INTEGER) + ? WHERE key='general_bank'`,
    [amount]
  )
}

async function ensureUser(id) {
  await run(
    `INSERT OR IGNORE INTO users (id) VALUES (?)`,
    [id]
  )
}

async function getUser(id) {
  return await get(
    `SELECT * FROM users WHERE id=?`,
    [id]
  )
}

function formatMoney(amount) {
  if (amount === undefined || amount === null || isNaN(amount)) return "$0"
  const isNegative = amount < 0
  const absAmount = Math.abs(amount)
  return (isNegative ? "-$" : "$") + absAmount.toLocaleString('en-US')
}

function getRoman(num) {
  const map = { C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
  let str = ''
  for (let i in map) {
    while (num >= map[i]) {
      str += i
      num -= map[i]
    }
  }
  return str || "I"
}

// Decode helper to handle common HTML entities returned from Open Trivia DB API
function decodeHtml(str) {
  if (!str) return ""
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&deg;/g, '°')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&rsquo;/g, '’')
    .replace(/&hellip;/g, '…')
    .replace(/&acute;/g, '´')
    .replace(/&Ocirc;/g, 'Ô')
    .replace(/&eacute;/g, 'é')
    .replace(/&aacute;/g, 'á')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
}

// Shuffle implementation for randomized trivia buttons
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getSocialClass(level) {
  if (level === 0) return "Bum"

  if (level >= 1 && level < 5) {
    return `Hustler ${getRoman(level)}`
  }
  if (level >= 5 && level < 10) {
    return `Lower Class ${getRoman(level - 4)}`
  }
  if (level >= 10 && level < 20) {
    return `Middle Class ${getRoman(level - 9)}`
  }
  if (level >= 20 && level < 30) {
    return `Upper Class ${getRoman(level - 19)}`
  }
  if (level >= 30 && level < 40) {
    return `Businessman ${getRoman(level - 29)}`
  }
  if (level >= 40 && level < 50) {
    return `Investor ${getRoman(level - 39)}`
  }
  if (level >= 50 && level < 60) {
    return `Senior Investor ${getRoman(level - 49)}`
  }
  if (level >= 60 && level < 80) {
    return `Elite Investor ${getRoman(level - 59)}`
  }
  if (level >= 80 && level < 100) {
    return `Capitalist ${getRoman(level - 79)}`
  }
  if (level >= 100 && level < 150) {
    return `Tycoon ${getRoman(level - 99)}`
  }
  if (level >= 150 && level < 200) {
    return `Magnate ${getRoman(level - 149)}`
  }
  if (level >= 200 && level < 300) {
    return `Industrial Lord ${getRoman(level - 199)}`
  }
  if (level >= 300 && level < 400) {
    return `Mogul ${getRoman(level - 299)}`
  }
  if (level >= 400 && level < 500) {
    return `Plutocrat ${getRoman(level - 399)}`
  }
  if (level >= 500 && level < 600) {
    return `Oligarch ${getRoman(level - 499)}`
  }
  if (level >= 600 && level < 700) {
    return `Federal Administrator ${getRoman(level - 599)}`
  }
  if (level >= 700 && level < 800) {
    return `Senate Authority ${getRoman(level - 699)}`
  }
  if (level >= 800 && level < 900) {
    return `Governor General ${getRoman(level - 799)}`
  }
  if (level >= 900 && level <= 999) {
    return `Presidential Council ${getRoman(level - 899)}`
  }

  return "Freemason"
}

async function addXp(msg, userId, amount) {
  const user = await getUser(userId)
  const currentXp = user.xp + amount
  const neededXp = (user.level + 1) * 120 // Curated scaling XP requirement

  if (currentXp >= neededXp) {
    const nextLevel = user.level + 1
    const leftoverXp = currentXp - neededXp
    const newClass = getSocialClass(nextLevel)

    await run(
      `UPDATE users SET level = ?, xp = ? WHERE id = ?`,
      [nextLevel, leftoverXp, userId]
    )

    // Modernized Level Up notification embed
    const levelUpEmbed = new EmbedBuilder()
      .setTitle("🚀 ECONOMIC LEVEL UP!")
      .setDescription(`Status update! <@${userId}> has climbed to new elite heights!`)
      .addFields(
        { name: "✨ New Level", value: `\`${nextLevel}\``, inline: true },
        { name: "👑 Social Rank Status", value: `\`${newClass}\``, inline: true }
      )
      .setColor(0x00ffcc)
      .setThumbnail(msg.author.displayAvatarURL({ dynamic: true }) || null)
      .setFooter({ text: "Excel and level up to unlock professional corporate careers!" })

    msg.channel.send({ embeds: [levelUpEmbed] })
  } else {
    await run(
      `UPDATE users SET xp = ? WHERE id = ?`,
      [currentXp, userId]
    )
  }
}

const JOBS = {
  fast_food: {
    name: "Fast Food Worker",
    pay: 10,
    cooldown: 30000, // 30 seconds
    reqs: "None (Default)"
  },
  delivery_driver: {
    name: "Delivery Driver",
    pay: 85,
    cooldown: 60000, // 1 minute
    reqs: "Bicycle (Direct Hire)"
  },
  software_developer: {
    name: "Software Developer",
    pay: 800,
    cooldown: 300000, // 5 minutes
    reqs: "Computer (Requires Technical Interview)"
  },
  day_trader: {
    name: "Day Trader",
    pay: 2500,
    cooldown: 300000, // 10 minutes
    reqs: "Computer & Internet Router (Requires Financial Assessment)"
  }
}

const DEV_INTERVIEW = [
  { q: "What HTML tag is used to write client-side JavaScript? (e.g. script, div)", a: "script" },
  { q: "Which keyword declares a constant block-scoped variable in JS?", a: "const" },
  { q: "What does CSS stand for? (cascading style sheets, creative style sheets)", a: "cascading style sheets" },
  { q: "What syntax structure allows storing multiple values in a single ordered variable?", a: "array" },
  { q: "What data type represents true or false values?", a: "boolean" }
]

const TRADER_INTERVIEW = [
  { q: "What does IPO stand for?", a: "initial public offering" },
  { q: "What market condition is characterized by rising stock prices? (bull or bear)", a: "bull" },
  { q: "What market condition is characterized by falling stock prices? (bull or bear)", a: "bear" },
  { q: "What does ROI stand for?", a: "return on investment" }
]

const SHOP_ITEMS = {
  bicycle: {
    name: "Bicycle",
    price: 200,
    desc: "Unlocks the Delivery Driver job instantly!"
  },
  router: {
    name: "Internet Router",
    price: 500,
    desc: "Unlocks the advanced Day Trader job when combined with a Computer!"
  },
  computer: {
    name: "Computer",
    price: 1200,
    desc: "Unlocks the software development job!"
  },
  gun: {
    name: "Tactical Gun",
    price: 1500,
    desc: "Adds +20% success rate to !rob and increases success cap to 80%!"
  },
  briefcase: {
    name: "Golden Briefcase",
    price: 3000,
    desc: "Upgrades Bank Storage Space by +10,000"
  },
  mansion: {
    name: "Luxury Mansion",
    price: 25000,
    desc: "The ultimate prestige icon. Grants a permanent +0.50x payout multiplier!"
  },
  sprinkler: {
    name: "Sprinkler",
    price: 100,
    desc: "Essential for growing weed"
  },
  growhouse: {
    name: "Growhouse",
    price: 200,
    desc: "Housing for your weed plants"
  },
  soil: {
    name: "Soil",
    price: 50,
    desc: "Nutrient-rich soil for growing"
  },
  weed_seeds: {
    name: "Weed Seeds",
    price: 75,
    desc: "High-quality cannabis seeds (each supports 4 pots)"
  },
  pots: {
    name: "Pots",
    price: 30,
    desc: "Holds 4 weed plants each"
  }
}

const QUESTS = [
  {
    id: 'business_supplies',
    name: 'Make a Business',
    preview: 'buy a sprinkler, a growhouse, some soil, and weed seeds.',
    tasks: ['sprinkler', 'growhouse', 'soil', 'weed_seeds'],
    xp: 100,
    minLevel: 1
  }
]

function getShopEmbed(page) {
  const itemKeys = Object.keys(SHOP_ITEMS)
  const totalPages = Math.ceil(itemKeys.length / 3)
  const start = (page - 1) * 3
  const pageItems = itemKeys.slice(start, start + 3)

  const embed = new EmbedBuilder()
    .setTitle("🛒 The Career & Wealth Shop")
    .setDescription("Use `!buy [item]` to buy a specific shop item (e.g. `!buy computer` or `!buy comp`).")
    .setColor(0x3498db)
    .setFooter({ text: `Page ${page} of ${totalPages}` })

  pageItems.forEach(key => {
    const item = SHOP_ITEMS[key]
    embed.addFields({
      name: `🔹 ${item.name} (\`${key}\`)`,
      value: `💵 Price: **${formatMoney(item.price)}**\n📝 *${item.desc}*`
    })
  })

  return embed
}

function getJobsEmbed(page, currentJobKey) {
  const jobKeys = Object.keys(JOBS)
  const totalPages = Math.ceil(jobKeys.length / 2)
  const start = (page - 1) * 2
  const pageJobs = jobKeys.slice(start, start + 2)

  const embed = new EmbedBuilder()
    .setTitle("📂 Available Careers")
    .setDescription("Apply with `!apply [job]` (e.g. `!apply software_developer` or `!apply dev`)")
    .setColor(0x9b59b6)
    .setFooter({ text: `Page ${page} of ${totalPages}` })

  pageJobs.forEach(key => {
    const j = JOBS[key]
    const status = currentJobKey === key ? "👉 **Active Job**" : "Available"
    embed.addFields({
      name: `💼 ${j.name} (\`${key}\`)`,
      value: `💵 Wage: **${formatMoney(j.pay)}** per work cycle\n⌛ Cooldown: **${j.cooldown / 1000}s**\n📋 Requirements: *${j.reqs}*\n📌 Status: **${status}**`
    })
  })

  return embed
}

function getHelpEmbed(category, prefix, page = 1) {
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)

  if (!category) {
    embed.setTitle("🛠️ Mocha Bot")
    embed.setDescription(
      `Welcome to the **Help Center**!\n` +
      `Please use the dropdown select menu below to filter command documentation by categories.`
    )
    embed.addFields({
      name: "Available Categories",
      value: `• **Utility** - Diagnostic and informative commands\n• **Economy & Banking** - Wealth building, items, bank reserves & trading\n• **Fun** - Memes, Trivia, Magic 8 Ball, and virtual Marriages\n• **Admin** - High-clearance database management controls\n• **Owner** - Bot owner commands`
    })
    embed.setFooter({ text: "Interactive Menu Systems active." })
    return { embed, totalPages: 1 }
  }

  const categoryName = category === "economy_banking" ? "Economy & Banking" : category.toUpperCase()
  embed.setTitle(`🛠️ Mocha Bot: ${categoryName}`)

  const categoryCommands = [...commands.values()].filter(cmd => cmd.category === category)
  const totalPages = Math.ceil(categoryCommands.length / 6) || 1
  const start = (page - 1) * 6
  const pageCommands = categoryCommands.slice(start, start + 6)

  if (pageCommands.length === 0) {
    embed.addFields({ name: "No Commands", value: "No active commands registered in this section." })
  } else {
    pageCommands.forEach(cmd => {
      const aliasStr = cmd.aliases?.length ? ` (\`${cmd.aliases.join('\`, \`')}\`)` : ''
      embed.addFields({
        name: `\`${prefix}${cmd.name}\`${aliasStr}`,
        value: `*${cmd.description}*`
      })
    })
  }

  embed.setFooter({ text: `Page ${page} of ${totalPages}` })
  return { embed, totalPages }
}

const commands = new Map()

function addCommand(data) {
  commands.set(data.name, data)
}

addCommand({
  name: "help",
  description: "shows all commands with an interactive selection catalog",
  category: "utility",

  execute: async (msg) => {
    const prefix = await getPrefix()
    const isAdmin = msg.member?.permissions.has(PermissionsBitField.Flags.Administrator) || msg.author.id === OWNER_ID
    const isOwner = msg.author.id === OWNER_ID

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("help_category")
      .setPlaceholder("Filter commands by category...")
      .addOptions([
        { label: "Overview", value: "overview", description: "Return to the help catalog hub" },
        { label: "Utility Commands", value: "utility", description: "View developer, response latency, and system checks" },
        { label: "Economy & Banking", value: "economy_banking", description: "View careers, trading, levels, savings & shopping" },
        { label: "Fun Category", value: "fun", description: "View games, trivia, marriages, and memes" }
      ])

    if (isAdmin) {
      selectMenu.addOptions([
        { label: "Admin Commands", value: "admin", description: "Clearance command module for managers" }
      ])
    }

    if (isOwner) {
      selectMenu.addOptions([
        { label: "Owner Commands", value: "owner", description: "Bot owner controls and utilities" }
      ])
    }

    const dropdownRow = new ActionRowBuilder().addComponents(selectMenu)

    let currentCategory = null
    let currentPage = 1

    const helpMsg = await msg.reply({
      embeds: [getHelpEmbed(null, prefix).embed],
      components: [dropdownRow]
    })

    const collector = helpMsg.createMessageComponentCollector({
      filter: i => i.user.id === msg.author.id,
      time: 120000
    })

    const updateHelpMsg = async (interaction) => {
      const { embed, totalPages } = getHelpEmbed(currentCategory, prefix, currentPage)
      const rows = [dropdownRow]

      if (currentCategory && totalPages > 1) {
        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("help_prev")
            .setLabel("⬅️ Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 1),
          new ButtonBuilder()
            .setCustomId("help_next")
            .setLabel("Next ➡️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalPages)
        )
        rows.push(buttonRow)
      }

      await interaction.update({
        embeds: [embed],
        components: rows
      })
    }

    collector.on("collect", async (interaction) => {
      if (interaction.isStringSelectMenu()) {
        const selected = interaction.values[0]
        currentCategory = selected === "overview" ? null : selected
        currentPage = 1
        await updateHelpMsg(interaction)
      } else if (interaction.isButton()) {
        if (interaction.customId === "help_prev") {
          currentPage = Math.max(1, currentPage - 1)
        } else if (interaction.customId === "help_next") {
          currentPage = currentPage + 1
        }
        await updateHelpMsg(interaction)
      }
    })

    collector.on("end", async () => {
      await helpMsg.edit({ components: [] }).catch(() => {})
    })
  }
})

addCommand({
  name: "ping",
  description: "shows latency",
  category: "utility",

  execute: async (msg) => {
    const sent = await msg.reply("pinging...")
    const latency = sent.createdTimestamp - msg.createdTimestamp
    const apiPing = Math.round(client.ws.ping)
    sent.edit(`pong\nclient: ${latency}ms\napi: ${apiPing}ms`)
  }
})

addCommand({
  name: "balance",
  aliases: ["bal"],
  description: "shows balance and status statistics",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const social = getSocialClass(user.level)
    const activeJob = JOBS[user.current_job]?.name || "Unemployed"
    const xpNeeded = (user.level + 1) * 120

    msg.reply(
      `💳 **Profile Details:** <@${user.id}>\n` +
      `**Social Class:** \`${social}\` (Level ${user.level})\n` +
      `**XP Progress:** \`${user.xp}/${xpNeeded} XP\`\n` +
      `**Current Job:** \`${activeJob}\`\n\n` +
      `💵 **Wallet:** ${formatMoney(user.wallet)}\n` +
      `🏦 **Bank:** ${formatMoney(user.bank)} / ${formatMoney(user.bankspace)}`
    )
  }
})

addCommand({
  name: "level",
  aliases: ["lvl", "rank"],
  description: "shows your current level, experience points, social class, and tier progress via an embedded interface",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const social = getSocialClass(user.level)
    const neededXp = (user.level + 1) * 120
    const percentage = Math.min(100, Math.floor((user.xp / neededXp) * 100))

    // Build a clean ASCII progression gauge
    const barLength = 10
    const filledLength = Math.round((percentage / 100) * barLength)
    const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength)

    const embed = new EmbedBuilder()
      .setTitle("⭐ Class Progression Card")
      .setDescription(`Detailed economic profile stats for <@${user.id}>`)
      .setColor(0xf1c40f)
      .setThumbnail(msg.author.displayAvatarURL({ dynamic: true }) || null)
      .addFields(
        { name: "✨ Level", value: `\`${user.level}\``, inline: true },
        { name: "👑 Social Class / Tier", value: `\`${social}\``, inline: true },
        { name: "💰 Payout Multiplier", value: `\`${user.multiplier.toFixed(2)}x\``, inline: true },
        { name: "📊 XP Progress", value: `\`[${bar}] ${percentage}%\` (${user.xp} / ${neededXp} XP)` }
      )
      .setFooter({ text: "Excel and level up to apply for elite corporate occupations!" })

    msg.reply({ embeds: [embed] })
  }
})
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}
addCommand({
  name: "work",
  description: "earn money with live cooldown timers, interactive day trading, and random beggar encounters",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const now = Date.now()
    const currentJobKey = user.current_job || 'fast_food'
    const job = JOBS[currentJobKey]
    const inflation = await getInflation()

    // Check Job Cooldown
    const timeSpent = now - user.lastwork
    if (timeSpent < job.cooldown) {
      const remainingMs = job.cooldown - timeSpent
      const timeLeft = formatTime(remainingMs)

      const statusMsg = await msg.reply(
        `You're tired and need to wait **${timeLeft}** before working at \`${job.name}\` again.`
      )

      return
    }

    // SPECIAL DAY TRADER LOGIC
    if (currentJobKey === 'day_trader') {
      const stocks = ["AMD", "NVIDIA", "MCDONALDS", "BURGER KING", "APPLE", "GOOGLE", "TESLA", "MICROSOFT", "AMAZON", "NETFLIX"]
      const chosenStock = stocks[Math.floor(Math.random() * stocks.length)]
      const tradeSize = Math.floor(Math.random() * 2000) + 1000 // $1000 - $3000

      const tradeEmbed = new EmbedBuilder()
        .setTitle("📈 Day Trading Opportunity!")
        .setDescription(
          `An opportunity to trade **${formatMoney(tradeSize)}** worth of **${chosenStock}** shares has appeared!\n` +
          `Would you like to execute this high-risk transaction or pass on the offer?`
        )
        .setColor(0x00ae86)
        .setFooter({ text: "Warning: Getting rugpulled can put your balances in negative debt!" })

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("trade_buy")
          .setLabel("Trade / Buy")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("trade_pass")
          .setLabel("Pass / Skip")
          .setStyle(ButtonStyle.Secondary)
      )

      const tradeMsg = await msg.reply({ embeds: [tradeEmbed], components: [row] })

      const filter = i => i.user.id === msg.author.id
      try {
        const interaction = await tradeMsg.awaitMessageComponent({ filter, time: 30000 })

        if (interaction.customId === 'trade_buy') {
          const win = Math.random() < 0.45 // 45% win rate
          let freshState = await getUser(msg.author.id) // Refreshed database context

          if (win) {
            const profitBonus = Math.floor(tradeSize * (Math.random() * 0.4 + 0.1)) // 10% to 50% profit
            const totalEarnings = Math.floor((job.pay + profitBonus) * freshState.multiplier / inflation)
            const xpGained = Math.floor(Math.random() * 25) + 20

            await run(
              `UPDATE users SET wallet = wallet + ?, lastwork = ? WHERE id = ?`,
              [totalEarnings, now, msg.author.id]
            )
            await addXp(msg, msg.author.id, xpGained)

            const winEmbed = new EmbedBuilder()
              .setTitle("🚀 Trade Successful!")
              .setDescription(`Your trade on **${chosenStock}** was extremely profitable!\n\n💰 **Net Earnings:** +${formatMoney(totalEarnings)} (${formatMoney(job.pay)} base + ${formatMoney(profitBonus)} profit bonus)\n✨ **XP Gained:** +${xpGained}`)
              .setColor(0x00ff00)

            await interaction.update({ embeds: [winEmbed], components: [] })
          } else {
            const lossAmount = Math.floor(tradeSize * (Math.random() * 1.2 + 0.5)) // Loss range 50% to 170% of trade size
            const xpGained = 10

            // Subtract directly from wallet (can go deep into debt / negative levels)
            let newWallet = freshState.wallet - lossAmount

            await run(
              `UPDATE users SET wallet = ?, lastwork = ? WHERE id = ?`,
              [newWallet, now, msg.author.id]
            )
            await addXp(msg, msg.author.id, xpGained)

            const lossEmbed = new EmbedBuilder()
              .setTitle("🚨 Rugpulled!")
              .setDescription(`Devastating blow! You got **rugpulled** on your **${chosenStock}** trade!\n\n💸 **Net Losses:** -${formatMoney(lossAmount)}\n✨ **XP Gained:** +${xpGained}\n\n*If your total capital is negative, your high-value assets are subject to foreclosure. You can use \`!apply fast_food\` to get working again.*`)
              .setColor(0xff0000)

            await interaction.update({ embeds: [lossEmbed], components: [] })
          }
        } else {
          await run(`UPDATE users SET lastwork = ? WHERE id = ?`, [now, msg.author.id])
          const passEmbed = new EmbedBuilder()
            .setTitle("🚶 Trade Skipped")
            .setDescription(`You passed on the **${chosenStock}** market play. Work cooldown triggered.`)
            .setColor(0x808080)
          await interaction.update({ embeds: [passEmbed], components: [] })
        }
      } catch (err) {
        await run(`UPDATE users SET lastwork = ? WHERE id = ?`, [now, msg.author.id])
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⌛ Opportunity Missed")
          .setDescription(`Your trading ticket expired before decision execution. Work cooldown triggered.`)
          .setColor(0x808080)
        await tradeMsg.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {})
      }
      return
    }

    // Beggar Random Interaction Check (25% chance if wallet has at least $15)
    if (user.wallet >= 15 && Math.random() < 0.25) {
      const askMsg = await msg.reply(
        `👴 **Interaction Encounter!** While going to work, you encounter a poor beggar.\n` +
        `Do you give them **$15**? (Type \`yes\` or \`no\` in chat within 15 seconds)`
      )

      const filter = m => m.author.id === msg.author.id && ['yes', 'no'].includes(m.content.toLowerCase())
      try {
        const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 15000, errors: ['time'] })
        const choice = collected.first().content.toLowerCase()

        if (choice === 'yes') {
          // Find the poorest user in database that is NOT the current user
          const poorest = await get(`SELECT * FROM users WHERE id != ? ORDER BY (wallet + bank) ASC LIMIT 1`, [msg.author.id])

          if (poorest) {
            await run(`UPDATE users SET wallet = wallet + 15 WHERE id = ?`, [poorest.id])
            await askMsg.edit(`💖 **Generous!** You gave $15 to the beggar. This money was automatically sent to someone poorer than you (<@${poorest.id}>)! You gained **60 XP**.`)
          } else {
            // Give to user's bank if there is no other user
            const bankSpaceLeft = user.bankspace - user.bank
            const depositAmount = Math.min(15, bankSpaceLeft)
            if (depositAmount > 0) {
              await run(`UPDATE users SET bank = bank + ? WHERE id = ?`, [depositAmount, msg.author.id])
            }
            await askMsg.edit(`💖 **Generous!** Since there are no other citizens in the economy, your $15 was deposited directly to your bank! You gained **60 XP**.`)
          }

          // Deduct $15 and award XP
          await run(`UPDATE users SET wallet = wallet - 15 WHERE id = ?`, [msg.author.id])
          await addXp(msg, msg.author.id, 60)

          // Refresh user cache state
          user = await getUser(msg.author.id)
        } else {
          await askMsg.edit(`🚶 You walked right past the beggar. No charity, no XP.`)
        }
      } catch (e) {
        await askMsg.edit(`⌛ You didn't reply in time. You walked past the beggar.`)
      }
    }

    // Standard Job Payout
    const rawPay = job.pay
    const earned = Math.floor(rawPay * user.multiplier / inflation)
    const earnedXp = Math.floor((Math.random() * 15) + 10)

    await run(
      `
      UPDATE users
      SET wallet = wallet + ?,
          lastwork = ?
      WHERE id=?
      `,
      [earned, now, msg.author.id]
    )

    await addXp(msg, msg.author.id, earnedXp)
    msg.reply(`💼 Worked as **${job.name}** and earned **${formatMoney(earned)}** and **${earnedXp} XP**!`)
  }
})

addCommand({
  name: "shop",
  description: "shows items available to purchase in paginated format",
  category: "economy_banking",

  execute: async (msg) => {
    let currentPage = 1
    const totalPages = Math.ceil(Object.keys(SHOP_ITEMS).length / 3)

    const getRow = (page) => {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("shop_prev")
          .setLabel("⬅️ Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId("shop_next")
          .setLabel("Next ➡️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === totalPages)
      )
    }

    const shopMsg = await msg.reply({
      embeds: [getShopEmbed(currentPage)],
      components: [getRow(currentPage)]
    })

    const collector = shopMsg.createMessageComponentCollector({
      filter: i => i.user.id === msg.author.id,
      time: 60000
    })

    collector.on("collect", async (interaction) => {
      if (interaction.customId === "shop_prev") {
        currentPage = Math.max(1, currentPage - 1)
      } else if (interaction.customId === "shop_next") {
        currentPage = Math.min(totalPages, currentPage + 1)
      }

      await interaction.update({
        embeds: [getShopEmbed(currentPage)],
        components: [getRow(currentPage)]
      })
    })

    collector.on("end", async () => {
      await shopMsg.edit({ components: [] }).catch(() => {})
    })
  }
})

const BIZ_ITEMS = ['sprinkler', 'growhouse', 'soil', 'weed_seeds', 'pots']

function resolveItem(input) {
  return Object.keys(SHOP_ITEMS).find(k =>
    k.startsWith(input) || SHOP_ITEMS[k].name.toLowerCase().startsWith(input) || k.includes(input)
  )
}

addCommand({
  name: "buy",
  description: "buy items from the shop (!buy item1,item2,...)",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    if (!args[0]) return msg.reply("❌ Usage: `!buy item1,item2,...` e.g. `!buy sprinkler,growhouse`")

    const raw = args.join(' ')
    const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const keys = names.map(n => resolveItem(n))
    const invalid = keys.findIndex(k => !k)
    if (invalid !== -1) return msg.reply(`❌ Invalid item: \`${names[invalid]}\`. Use \`!shop\` to see stock.`)

    const items = keys.map(k => SHOP_ITEMS[k])
    const totalCost = items.reduce((s, i) => s + i.price, 0)
    if (user.wallet < totalCost) return msg.reply(`❌ You need **${formatMoney(totalCost)}** but only have **${formatMoney(user.wallet)}**`)

    let inventory = JSON.parse(user.inventory || "[]")
    let businesses = JSON.parse(user.businesses || '{}')
    if (!businesses.weed) businesses.weed = { sprinkler: 0, growhouse: 0, soil: 0, buds: 0, pots: 0, weed_seeds: 0, plants: [] }

    // Check pot limit for weed seeds
    const seedsBought = keys.filter(k => k === 'weed_seeds').length
    const currentSeeds = businesses.weed.weed_seeds || 0
    const currentPots = businesses.weed.pots || 0
    if (currentSeeds + seedsBought > currentPots * 4) {
      const max = currentPots * 4
      return msg.reply(`❌ You can only have **${max}** weed seeds with **${currentPots}** pot(s). Buy more pots first.`)
    }

    let replies = []
    const userQuests = JSON.parse(user.quests || '{}')
    let bankSpaceInc = 0
    let multInc = 0
    let questComplete = false

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const item = items[i]

      if (BIZ_ITEMS.includes(key)) {
        businesses.weed[key] = (businesses.weed[key] || 0) + 1
        replies.push(`**${item.name}**`)

        const q = userQuests['business_supplies']
        if (q?.status === 'active' && !q.progress.includes(key)) {
          q.progress.push(key)
          if (q.progress.length >= QUESTS.find(x => x.id === 'business_supplies').tasks.length) {
            q.status = 'completed'
            questComplete = true
          }
        }
      } else {
        if (['computer', 'router', 'bicycle', 'gun'].includes(key) && inventory.includes(key)) {
          return msg.reply(`❌ You already own a **${item.name}**!`)
        }
        inventory.push(key)
        replies.push(`**${item.name}**`)
        if (key === 'briefcase') bankSpaceInc += 10000
        else if (key === 'mansion') multInc += 0.50
      }
    }

    await run(`UPDATE users SET wallet = wallet - ?, inventory = ?, businesses = ?, bankspace = bankspace + ?, multiplier = multiplier + ? WHERE id = ?`,
      [totalCost, JSON.stringify(inventory), JSON.stringify(businesses), bankSpaceInc, multInc, msg.author.id])
    await addToGeneralBank(totalCost)
    await run(`UPDATE users SET quests=? WHERE id=?`, [JSON.stringify(userQuests), msg.author.id])

    if (questComplete) {
      const questXp = QUESTS.find(x => x.id === 'business_supplies').xp
      await run(`UPDATE users SET last_channel=? WHERE id=?`, [msg.channel.id, msg.author.id])
      const redeemRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`quest_redeem_${msg.author.id}`).setLabel(`REDEEM ${questXp} XP`).setStyle(ButtonStyle.Secondary)
      )
      msg.reply({ content: `🎉 **Quest Complete!** You finished \`Make a Business\`! Redeem your **${questXp} XP**!`, components: [redeemRow] })
      return
    }

    msg.reply(`🎉 Bought ${replies.join(', ')} for **${formatMoney(totalCost)}**!`)
  }
})

addCommand({
  name: "jobs",
  description: "lists job specifications across paginated sections",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    let currentPage = 1
    const totalPages = Math.ceil(Object.keys(JOBS).length / 2)

    const getRow = (page) => {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("jobs_prev")
          .setLabel("⬅️ Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId("jobs_next")
          .setLabel("Next ➡️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === totalPages)
      )
    }

    const jobsMsg = await msg.reply({
      embeds: [getJobsEmbed(currentPage, user.current_job)],
      components: [getRow(currentPage)]
    })

    const collector = jobsMsg.createMessageComponentCollector({
      filter: i => i.user.id === msg.author.id,
      time: 60000
    })

    collector.on("collect", async (interaction) => {
      if (interaction.customId === "jobs_prev") {
        currentPage = Math.max(1, currentPage - 1)
      } else if (interaction.customId === "jobs_next") {
        currentPage = Math.min(totalPages, currentPage + 1)
      }

      await interaction.update({
        embeds: [getJobsEmbed(currentPage, user.current_job)],
        components: [getRow(currentPage)]
      })
    })

    collector.on("end", async () => {
      await jobsMsg.edit({ components: [] }).catch(() => {})
    })
  }
})

addCommand({
  name: "donate",
  aliases: ["give", "pay"],
  description: "donate cash to another user",
  category: "economy",

  execute: async (msg, args) => {
    const target =
      msg.mentions.users.first() ||
      client.users.cache.get(args[0])

    const amount = parseInt(args[1])

    if (!target)
      return msg.reply("Mention a user.")

    if (target.id === msg.author.id)
      return msg.reply("You cannot donate to yourself.")

    if (target.bot)
      return msg.reply("You cannot donate to bots.")

    if (!amount || amount < 1)
      return msg.reply("Enter a valid amount.")

    if (amount > 50000)
      return msg.reply("Maximum donation is $50,000.")

    await ensureUser(msg.author.id)
    await ensureUser(target.id)

    const sender = await getUser(msg.author.id)

    if (sender.wallet < amount)
      return msg.reply("You do not have enough cash.")

    await run(
      "UPDATE users SET wallet = wallet - ? WHERE id = ?",
      [amount, msg.author.id]
    )

    await run(
      "UPDATE users SET wallet = wallet + ? WHERE id = ?",
      [amount, target.id]
    )

    const receiver = await getUser(target.id)

    const embed = new EmbedBuilder()
      .setTitle("💸 Donation")
      .setDescription(
        `**${msg.author.username}** donated **$${amount.toLocaleString()}** to **${target.username}**`
      )
      .addFields(
        {
          name: "Donor Balance",
          value: `$${(sender.wallet - amount).toLocaleString()}`,
          inline: true
        },
        {
          name: "Recipient Balance",
          value: `$${receiver.wallet.toLocaleString()}`,
          inline: true
        }
      )

    msg.reply({ embeds: [embed] })
  }
})

addCommand({
  name: "apply",
  description: "apply for high-paying occupations with academic testing (supports shortened career queries)",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const inputArg = args[0]?.toLowerCase()
    if (!inputArg) {
      return msg.reply("❌ Please specify a career! e.g. `!apply software_developer` or `!apply dev`")
    }

    // Match career paths query with support for shortening / partial strings
    const jobKey = Object.keys(JOBS).find(k =>
      k.startsWith(inputArg) ||
      JOBS[k].name.toLowerCase().startsWith(inputArg) ||
      k.includes(inputArg)
    )

    if (!jobKey || !JOBS[jobKey]) {
      return msg.reply("❌ Invalid job! Use `!jobs` to view career paths.")
    }

    if (user.current_job === jobKey) {
      return msg.reply("❌ You are already employed in this job!")
    }

    const inventory = JSON.parse(user.inventory || "[]")

    if (jobKey === 'delivery_driver') {
      if (!inventory.includes('bicycle')) {
        return msg.reply("❌ You need to purchase a **Bicycle** from the `!shop` first!")
      }

      await run(`UPDATE users SET current_job = 'delivery_driver' WHERE id = ?`, [msg.author.id])
      msg.reply(`🚲 **Hired!** You are now a **Delivery Driver** earning ${formatMoney(85)}.`)

    } else if (jobKey === 'software_developer') {
      if (!inventory.includes('computer')) {
        return msg.reply("❌ You need to purchase a **Computer** from the `!shop` before you can apply to be a Developer!")
      }

      // Generate a random Technical Interview question
      const randomQ = DEV_INTERVIEW[Math.floor(Math.random() * DEV_INTERVIEW.length)]
      const testMsg = await msg.reply(
        `💻 **Software Dev Technical Interview!**\n` +
        `Answer this question correctly to get hired (lowercase, answer within 30 seconds):\n\n` +
        `📝 **Question:** \`${randomQ.q}\``
      )

      const filter = m => m.author.id === msg.author.id
      try {
        const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
        const answer = collected.first().content.trim().toLowerCase()

        if (answer === randomQ.a) {
          await run(`UPDATE users SET current_job = 'software_developer' WHERE id = ?`, [msg.author.id])
          await testMsg.edit(`🎉 **Hired!** Your interview answers were immaculate. You are now a **Software Developer** earning ${formatMoney(800)}!`)
        } else {
          await testMsg.edit(`❌ **Rejected!** Your answer (\`${answer}\`) was incorrect. Try again later!`)
        }
      } catch (e) {
        await testMsg.edit(`⌛ **Interview Over!** You ran out of time. Interview rejected.`)
      }

    } else if (jobKey === 'day_trader') {
      if (!inventory.includes('computer') || !inventory.includes('router')) {
        return msg.reply("❌ You need to purchase both a **Computer** and an **Internet Router** from the `!shop` first!")
      }

      // Generate a random Trading Placement Assessment question
      const randomQ = TRADER_INTERVIEW[Math.floor(Math.random() * TRADER_INTERVIEW.length)]
      const testMsg = await msg.reply(
        `📈 **Day Trader Financial Assessment!**\n` +
        `Answer this question correctly to get hired (lowercase, answer within 30 seconds):\n\n` +
        `📝 **Question:** \`${randomQ.q}\``
      )

      const filter = m => m.author.id === msg.author.id
      try {
        const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
        const answer = collected.first().content.trim().toLowerCase()

        if (answer === randomQ.a || answer.includes(randomQ.a)) {
          await run(`UPDATE users SET current_job = 'day_trader' WHERE id = ?`, [msg.author.id])
          await testMsg.edit(`🎉 **Hired!** Your financial intelligence is remarkable. You are now a **Day Trader** earning ${formatMoney(2500)}!`)
        } else {
          await testMsg.edit(`❌ **Rejected!** Your answer (\`${answer}\`) was incorrect. Try again later!`)
        }
      } catch (e) {
        await testMsg.edit(`⌛ **Assessment Over!** You ran out of time. Placement test rejected.`)
      }

    } else if (jobKey === 'fast_food') {
      await run(`UPDATE users SET current_job = 'fast_food' WHERE id = ?`, [msg.author.id])
      msg.reply("🍔 You transitioned to working at the **Fast Food Restaurant**.")
    }
  }
})

addCommand({
  name: "rob",
  description: "Attempt to rob another user. Chance is proportionate to wealth difference.",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const target = msg.mentions.users.first() || client.users.cache.get(args[0])
    if (!target) {
      return msg.reply("❌ You must mention a valid user to rob!")
    }
    if (target.id === msg.author.id) {
      return msg.reply("❌ You cannot rob yourself!")
    }

    await ensureUser(target.id)
    const targetUser = await getUser(target.id)

    if (targetUser.wallet <= 0) {
      return msg.reply("❌ This citizen has absolutely no cash in their wallet to rob!")
    }

    const robberTotal = user.wallet + user.bank
    const victimTotal = targetUser.wallet + targetUser.bank

    if (robberTotal <= 0) {
      return msg.reply("❌ You must have at least some cash (or stored savings) to plan a heist!")
    }

    const inventory = JSON.parse(user.inventory || "[]")
    const hasGun = inventory.includes("gun")

    // Rob success rate is calculated based on: (robberTotal / victimTotal) * 100
    // Gun grants passive +20% success and increases the success cap to 80% instead of 60%
    const baseChance = (robberTotal / victimTotal) * 100
    let finalChance = Math.round(baseChance)

    if (hasGun) {
      finalChance += 20
    }

    const cap = hasGun ? 80 : 60
    finalChance = Math.min(cap, Math.max(1, finalChance))

    const roll = Math.random() * 100
    const win = roll < finalChance

    if (win) {
      // Steals 20% to 50% of the victim's wallet cash on a successful heist
      const stealPercentage = Math.random() * 0.3 + 0.2
      const stolen = Math.floor(targetUser.wallet * stealPercentage) || 1

      await run(`UPDATE users SET wallet = wallet + ? WHERE id = ?`, [stolen, msg.author.id])
      await run(`UPDATE users SET wallet = wallet - ? WHERE id = ?`, [stolen, target.id])

      return msg.reply(
        `🔫 **Heist Successful!** (Chance: \`${finalChance}%\`)\n` +
        `You successfully robbed <@${target.id}> and stole **${formatMoney(stolen)}** cash from their wallet!`
      )
    } else {
      // Caught by authorities! 10% of robber's total assets is charged as a fine
      const fine = Math.floor(robberTotal * 0.1) || 100

      await run(`UPDATE users SET wallet = wallet - ? WHERE id = ?`, [fine, msg.author.id])
      await run(`UPDATE users SET wallet = wallet + ? WHERE id = ?`, [fine, target.id])

      return msg.reply(
        `🚨 **Busted!** (Chance: \`${finalChance}%\`)\n` +
        `You got caught attempting to rob <@${target.id}>! The court fined you **${formatMoney(fine)}**, which was automatically transferred to the victim.`
      )
    }
  }
})

addCommand({
  name: "gamble",
  description: "gamble money",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const amount = parseInt(args[0])

    if (!amount || amount <= 0) {
      return msg.reply("invalid amount")
    }

    if (user.wallet < amount) {
      return msg.reply("too broke")
    }

    const win = Math.random() < 0.45

    if (win) {
      await run(
        `
        UPDATE users
        SET wallet = wallet + ?
        WHERE id=?
        `,
        [amount, msg.author.id]
      )

      return msg.reply(`you won ${formatMoney(amount)}`)
    }

    await run(
      `
      UPDATE users
      SET wallet = wallet - ?
      WHERE id=?
      `,
      [amount, msg.author.id]
    )

    msg.reply(`you lost ${formatMoney(amount)}`)
  }
})

addCommand({
  name: "deposit",
  aliases: ["dep"],
  description: "deposit money",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const amount = parseInt(args[0])

    if (!amount || amount <= 0) {
      return msg.reply("invalid amount")
    }

    if (user.wallet < amount) {
      return msg.reply("not enough money")
    }

    if (user.bank + amount > user.bankspace) {
      return msg.reply("bank full")
    }

    await run(
      `
      UPDATE users
      SET wallet = wallet - ?,
          bank = bank + ?
      WHERE id=?
      `,
      [amount, amount, msg.author.id]
    )

    msg.reply(`deposited ${formatMoney(amount)}`)
  }
})

addCommand({
  name: "withdraw",
  aliases: ["with"],
  description: "withdraw money",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const amount = parseInt(args[0])

    if (!amount || amount <= 0) {
      return msg.reply("invalid amount")
    }

    if (user.bank < amount) {
      return msg.reply("not enough bank money")
    }

    await run(
      `
      UPDATE users
      SET wallet = wallet + ?,
          bank = bank - ?
      WHERE id=?
      `,
      [amount, amount, msg.author.id]
    )

    msg.reply(`withdrew ${formatMoney(amount)}`)
  }
})

addCommand({
  name: "economy",
  description: "shows economy stats",
  category: "economy_banking",

  execute: async (msg) => {
    const inflation = await getInflation()
    const generalBank = await getGeneralBank()

    const rows = await all(
      `SELECT wallet, bank FROM users`
    )

    const totalMoney = rows.reduce(
      (a, b) => a + b.wallet + b.bank,
      0
    )

    msg.reply(
`📊 **Central Economy Statistics**

🔹 **Inflation Multiplier:** ${inflation.toFixed(2)}x
🏦 **General Bank Reserve:** ${formatMoney(generalBank)} *(Funded via purchases)*
💰 **Circulating Money Supply:** ${formatMoney(totalMoney)}
👥 **Registered Citizens:** ${rows.length}`
    )
  }
})

addCommand({
  name: "leaderboard",
  aliases: ["lb"],
  description: "shows richest users in a fully optimized, cached embed layout",
  category: "economy_banking",

  execute: async (msg) => {
    // Highly optimized DB Query with indexed sorting
    const rows = await all(`
      SELECT id, wallet, bank, level
      FROM users
      ORDER BY (wallet + bank) DESC
      LIMIT 10
    `)

    const embed = new EmbedBuilder()
      .setTitle("🏆 Central Wealth Leaderboard")
      .setDescription("The elite citizens with the largest capital assets across the system.")
      .setColor(0xd1a119)
      .setTimestamp()

    let descText = ""

    // Execute cached fetches or tag fallbacks to keep execution blazing fast
    for (let i = 0; i < rows.length; i++) {
      const dbUser = rows[i]
      const cachedUser = client.users.cache.get(dbUser.id)
      let name = cachedUser ? cachedUser.tag : null

      if (!name) {
        // Fallback to fetch only if cached object is missing to optimize performance
        try {
          const fetched = await client.users.fetch(dbUser.id)
          name = fetched.tag
        } catch (_) {
          name = `Citizen ${dbUser.id.slice(0, 6)}`
        }
      }

      const totalWealth = dbUser.wallet + dbUser.bank
      const socialClass = getSocialClass(dbUser.level)
      const rankBadge = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `\`#${i + 1}\``

      descText += `${rankBadge} **${name}** - ${formatMoney(totalWealth)}\n↳ *Level ${dbUser.level} (${socialClass})*\n\n`
    }

    embed.setDescription(descText || "No active registered citizens found.")
    msg.reply({ embeds: [embed] })
  }
})

addCommand({
  name: "trivia",
  description: "test your general knowledge with family friendly trivia questions for dynamic coin rewards",
  category: "fun",

  execute: async (msg, args, user) => {
    try {
      const res = await fetch("https://opentdb.com/api.php?amount=1&type=multiple")
      const data = await res.json()

      if (!data?.results || data.results.length === 0) {
        return msg.reply("❌ The Trivia server is currently fully loaded. Please try again in a few seconds!")
      }

      const questData = data.results[0]
      const question = decodeHtml(questData.question)
      const correctAnswer = decodeHtml(questData.correct_answer)
      const incorrectAnswers = questData.incorrect_answers.map(ans => decodeHtml(ans))

      // Combine answers and shuffle dynamically
      const choices = shuffleArray([correctAnswer, ...incorrectAnswers])

      const triviaEmbed = new EmbedBuilder()
        .setTitle(`🧠 TRIVIA: ${questData.category}`)
        .setDescription(`**${question}**\n\n*Difficulty: ${questData.difficulty.toUpperCase()}*\n*Reward: ${formatMoney(150)}*`)
        .setColor(0x3498db)
        .setFooter({ text: "You have 30 seconds to answer correctly by pressing a button!" })

      // Generate buttons dynamically for answers
      const row = new ActionRowBuilder()
      choices.forEach((choice, index) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`trivia_ans_${index}`)
            .setLabel(choice.slice(0, 80)) // Max limit of 80 characters for button labels
            .setStyle(ButtonStyle.Secondary)
        )
      })

      const triviaMsg = await msg.reply({ embeds: [triviaEmbed], components: [row] })

      const filter = i => i.user.id === msg.author.id
      const collector = triviaMsg.createMessageComponentCollector({ filter, time: 30000, max: 1 })

      collector.on("collect", async (interaction) => {
        const buttonId = interaction.customId
        const chosenIndex = parseInt(buttonId.replace("trivia_ans_", ""))
        const chosenAnswer = choices[chosenIndex]

        if (chosenAnswer === correctAnswer) {
          await run(`UPDATE users SET wallet = wallet + 150, trivia_streak = trivia_streak + 1 WHERE id = ?`, [msg.author.id])
          await addXp(msg, msg.author.id, 40)

          const u = await getUser(msg.author.id)

          const winEmbed = new EmbedBuilder()
            .setTitle("🎉 Correct Answer!")
            .setDescription(`Sensational! You answered **${correctAnswer}** correctly.\n\n💰 **Reward:** +${formatMoney(150)}\n✨ **XP Gained:** +40 XP\n🔥 **Trivia Streak:** ${u.trivia_streak}`)
            .setColor(0x00ff00)

          await interaction.update({ embeds: [winEmbed], components: [] })
        } else {
          await run(`UPDATE users SET trivia_streak = 0 WHERE id = ?`, [msg.author.id])

          const loseEmbed = new EmbedBuilder()
            .setTitle("❌ Incorrect Answer!")
            .setDescription(`Incorrect! You chose **${chosenAnswer}**.\nThe correct answer was **${correctAnswer}**.`)
            .setColor(0xff0000)

          await interaction.update({ embeds: [loseEmbed], components: [] })
        }
      })

      collector.on("end", async (collected, reason) => {
        if (reason === "time") {
          const timeoutEmbed = new EmbedBuilder()
            .setTitle("⌛ Out of Time!")
            .setDescription(`You ran out of time! The correct answer was **${correctAnswer}**.`)
            .setColor(0xffa500)

          await triviaMsg.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {})
        }
      })
    } catch (err) {
      console.error(err)
      msg.reply("❌ Unable to fetch trivia question. Please try again later!")
    }
  }
})

addCommand({
  name: "triviastreak",
  aliases: ["tstreak", "triviastreaks"],
  description: "check your trivia answer streak",
  category: "fun",

  execute: async (msg, args, user) => {
    msg.reply(`🔥 **Trivia Streak:** ${user.trivia_streak || 0} correct answers in a row!`)
  }
})

addCommand({
  name: "marry",
  description: "marry another server member and track your virtual anniversary together",
  category: "fun",

  execute: async (msg, args, user) => {
    const target = msg.mentions.users.first() || client.users.cache.get(args[0])

    if (!target) {
      return msg.reply("❌ You must mention a valid user to propose to!")
    }
    if (target.id === msg.author.id) {
      return msg.reply("❌ You cannot marry yourself!")
    }
    if (target.bot) {
      return msg.reply("❌ You cannot marry bots, as they do not have legal standing inside the database.")
    }

    await ensureUser(target.id)
    const targetUser = await getUser(target.id)

    // Check if either user is already married
    if (user.spouse_id) {
      return msg.reply(`❌ You are already married to <@${user.spouse_id}>! Use \`!divorce\` first.`)
    }
    if (targetUser.spouse_id) {
      return msg.reply(`❌ <@${target.id}> is already married to someone else!`)
    }

    const proposalEmbed = new EmbedBuilder()
      .setTitle("💍 Marriage Proposal!")
      .setDescription(`💝 <@${msg.author.id}> has proposed to you, <@${target.id}>!\n\nDo you accept this proposal and pledge your digital heart?`)
      .setColor(0xff69b4)
      .setFooter({ text: "You have 60 seconds to decide." })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("marry_accept")
        .setLabel("I Do (Accept)")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("marry_reject")
        .setLabel("No (Reject)")
        .setStyle(ButtonStyle.Secondary)
    )

    const propMsg = await msg.channel.send({ content: `<@${target.id}>`, embeds: [proposalEmbed], components: [row] })

    const filter = i => i.user.id === target.id
    try {
      const interaction = await propMsg.awaitMessageComponent({ filter, time: 60000 })

      if (interaction.customId === "marry_accept") {
        const now = Date.now()

        await run(`UPDATE users SET spouse_id = ?, marriage_date = ? WHERE id = ?`, [target.id, now, msg.author.id])
        await run(`UPDATE users SET spouse_id = ?, marriage_date = ? WHERE id = ?`, [msg.author.id, now, target.id])

        const acceptedEmbed = new EmbedBuilder()
          .setTitle("🎉 Congratulations!")
          .setDescription(`💞 <@${msg.author.id}> and <@${target.id}> are now happily married!\nMay your digital household flourish and your wallets multiply!`)
          .setColor(0xff1493)
          .setTimestamp()

        await interaction.update({ embeds: [acceptedEmbed], components: [] })
      } else {
        const rejectedEmbed = new EmbedBuilder()
          .setTitle("💔 Proposal Rejected")
          .setDescription(`Ouch! <@${target.id}> has politely declined the proposal. Better luck next time!`)
          .setColor(0x808080)

        await interaction.update({ embeds: [rejectedEmbed], components: [] })
      }
    } catch (err) {
      const expireEmbed = new EmbedBuilder()
        .setTitle("⌛ Proposal Expired")
        .setDescription(`There was no answer from <@${target.id}>. The proposal expired.`)
        .setColor(0x808080)

      await propMsg.edit({ embeds: [expireEmbed], components: [] }).catch(() => {})
    }
  }
})

addCommand({
  name: "divorce",
  description: "divorce your virtual partner (costs 15% of your bank reserves in legal fees)",
  category: "fun",

  execute: async (msg, args, user) => {
    if (!user.spouse_id) {
      return msg.reply("❌ You are currently single. There is no one to divorce!")
    }

    const spouseId = user.spouse_id
    const legalFees = Math.floor(user.bank * 0.15) || 50

    await run(`UPDATE users SET spouse_id = NULL, marriage_date = 0 WHERE id = ?`, [msg.author.id])
    await run(`UPDATE users SET spouse_id = NULL, marriage_date = 0 WHERE id = ?`, [spouseId])
    await run(`UPDATE users SET bank = bank - ? WHERE id = ?`, [legalFees, msg.author.id])

    // Transfer the legal fees to the general bank economy reserves
    await addToGeneralBank(legalFees)

    msg.reply(`💔 You divorced <@${spouseId}>. The legal fees cost you **${formatMoney(legalFees)}** and were added to the General Bank reserves.`)
  }
})

addCommand({
  name: "marriage",
  aliases: ["anniversary", "spouse"],
  description: "check your virtual marriage profile and wedding anniversary",
  category: "fun",

  execute: async (msg, args, user) => {
    if (!user.spouse_id) {
      return msg.reply("❌ You are currently single! Propose to someone using `!marry <@user>`.")
    }

    const mDate = new Date(user.marriage_date)
    const elapsedDays = Math.floor((Date.now() - user.marriage_date) / (1000 * 60 * 60 * 24))

    const embed = new EmbedBuilder()
      .setTitle("💟 Virtual Marriage profile")
      .setDescription(`A look into your virtual bond.`)
      .addFields(
        { name: "👤 Spouse", value: `<@${user.spouse_id}>`, inline: true },
        { name: "📅 Wedding Date", value: `\`${mDate.toLocaleDateString()}\``, inline: true },
        { name: "💍 Together For", value: `\`${elapsedDays} Days\``, inline: true }
      )
      .setColor(0xff69b4)
      .setTimestamp()

    msg.reply({ embeds: [embed] })
  }
})

addCommand({
  name: "memeoftheday",
  aliases: ["motd", "meme"],
  description: "Fetch a random family-friendly meme from Reddit",
  category: "fun",

  execute: async (msg) => {
    try {
      const res = await fetch("https://meme-api.com/gimme/memes")
      const data = await res.json()

      if (!data || data.nsfw) {
        // Fallback retry once if NSFW meme fetched
        const retryRes = await fetch("https://meme-api.com/gimme/memes")
        const retryData = await retryRes.json()
        if (!retryData || retryData.nsfw) {
          return msg.reply("❌ Could not retrieve a family-friendly meme. Please try again!")
        }
        const embed = new EmbedBuilder()
          .setTitle(retryData.title)
          .setImage(retryData.url)
          .setColor(0x00ae86)
          .setFooter({ text: `Source: r/${retryData.subreddit} | Author: u/${retryData.author}` })
        return msg.reply({ embeds: [embed] })
      }

      const embed = new EmbedBuilder()
        .setTitle(data.title)
        .setImage(data.url)
        .setColor(0x00ae86)
        .setFooter({ text: `Source: r/${data.subreddit} | Author: u/${data.author}` })

      msg.reply({ embeds: [embed] })
    } catch (err) {
      console.error(err)
      msg.reply("❌ The meme database could not be reached. Try again in a minute!")
    }
  }
})

addCommand({
  name: "8ball",
  description: "magic 8 ball answers yes or no questions funny or cryptically",
  category: "fun",

  execute: async (msg, args) => {
    const question = args.join(" ")
    if (!question) {
      return msg.reply("❌ Please ask a question for the Magic 8 Ball! e.g. `!8ball will I become a billionaire?`")
    }

    const responses = [
      "🔮 It is certain.",
      "🔮 Without a doubt.",
      "🔮 You may rely on it.",
      "🔮 Yes, definitely.",
      "🔮 Signs point to yes.",
      "🔮 Reply hazy, try again later.",
      "🔮 Ask again later.",
      "🔮 Better not tell you now.",
      "🔮 Cannot predict now.",
      "🔮 Concentrate and ask again.",
      "🔮 Don't count on it.",
      "🔮 My reply is no.",
      "🔮 My sources say no.",
      "🔮 Outlook not so good.",
      "🔮 Very doubtful.",
      "🔮 Absolute zero percent chance, get back to work.",
      "🔮 Only if you give $100 to a beggar.",
      "🔮 The stars are laughing at your request.",
      "🔮 Highly likely if the general bank doesn't foreclose on you first."
    ]

    const randomAns = responses[Math.floor(Math.random() * responses.length)]

    const embed = new EmbedBuilder()
      .setTitle("🔮 Magic 8 Ball")
      .addFields(
        { name: "❓ Question", value: `*${question}*` },
        { name: "💬 Prediction", value: `**${randomAns}**` }
      )
      .setColor(0x8a2be2)
      .setThumbnail("https://i.imgur.com/8ball.png") // Fallback design styling

    msg.reply({ embeds: [embed] })
  }
})

addCommand({
  name: "setprefix",
  description: "set your personal prefix",
  category: "utility",

  execute: async (msg, args, user) => {
    const newPrefix = args[0]

    if (!newPrefix) {
      return msg.reply(`your prefix is \`${user.prefix || await getPrefix()}\``)
    }

    await run(`UPDATE users SET prefix=? WHERE id=?`, [newPrefix, msg.author.id])

    msg.reply(`prefix set to ${newPrefix}`)
  }
})

addCommand({
  name: "sm",
  aliases: ["statsmodify"],
  description: "modify user stats",
  category: "owner",

  execute: async (msg, args) => {
    if (msg.author.id !== OWNER_ID) return

    const field = args[0]?.toLowerCase()
    const target = msg.mentions.users.first() || client.users.cache.get(args[1])
    const amount = parseInt(args[2])

    if (!field || !target || isNaN(amount)) {
      return msg.reply("Usage: !sm cash/level/bank @user amount")
    }

    await ensureUser(target.id)

    if (field === "cash") {
      await run(
        "UPDATE users SET wallet=? WHERE id=?",
        [amount, target.id]
      )
    } else if (field === "level") {
      await run(
        "UPDATE users SET level=? WHERE id=?",
        [amount, target.id]
      )
    } else if (field === "bank") {
      await run(
        "UPDATE users SET bank=? WHERE id=?",
        [amount, target.id]
      )
    } else {
      return msg.reply("Valid fields: cash, level, bank")
    }

    msg.reply(`✅ Updated ${field} for <@${target.id}> to ${amount}`)
  }
})

addCommand({
  name: "confession",
  description: "Set up anonymous confessions in this channel (Admin Only)",
  category: "admin",

  execute: async (msg) => {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator) && msg.author.id !== OWNER_ID) {
      return
    }

    const embed = new EmbedBuilder()
      .setTitle("🤫 Anonymous Confessions")
      .setDescription("Click the button below to make an anonymous confession. Your identity will remain completely secret!")
      .setColor(0x9b59b6)

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("confess_btn")
        .setLabel("✍️ Confess")
        .setStyle(ButtonStyle.Secondary)
    )

    await msg.channel.send({ embeds: [embed], components: [row] })
    if (msg.deletable) await msg.delete().catch(() => {})
  }
})

addCommand({
  name: "servers",
  description: "shows all servers",
  category: "owner",

  execute: async (msg) => {
    if (msg.author.id !== OWNER_ID) return

    const guilds = client.guilds.cache.sort((a, b) => b.memberCount - a.memberCount)
    const totalMembers = guilds.reduce((s, g) => s + g.memberCount, 0)
    const nf = n => n.toLocaleString()

    const embed = new EmbedBuilder()
      .setTitle(`${nf(guilds.size)} servers, ${nf(totalMembers)} members total`)
      .setColor(0x2ecc71)

    guilds.first(5).forEach(g => {
      embed.addFields({ name: g.name, value: `${nf(g.memberCount)} members`, inline: true })
    })

    msg.reply({ embeds: [embed] })
  }
})

const statusConfig = {
  status: 'online',
  activityType: 'none',
  rotatingStatuses: { statuses: ['with the economy', 'with fire', 'with code'], duration: 15 },
  staticStatus: 'with the economy',
  rotationIndex: 0,
  rotationInterval: null
}

async function loadStatusConfig() {
  const r = await get(
    "SELECT value FROM settings WHERE key='rotating_statuses'"
  )

  const s = await get(
    "SELECT value FROM settings WHERE key='static_status'"
  )

  const m = await get(
    "SELECT value FROM settings WHERE key='status_mode'"
  )

  if (r) {
    try {
      statusConfig.rotatingStatuses = JSON.parse(r.value)
    } catch {}
  }

  if (s)
    statusConfig.staticStatus = s.value

  if (m)
    statusConfig.activityType = m.value.toLowerCase()
}

async function saveRotatingStatuses() {
  await run(`UPDATE settings SET value=? WHERE key='rotating_statuses'`, [JSON.stringify(statusConfig.rotatingStatuses)])
}

async function saveStaticStatus() {
  await run(`UPDATE settings SET value=? WHERE key='static_status'`, [statusConfig.staticStatus])
}

function applyStatus() {
  const { status, activityType, staticStatus } = statusConfig
  const { statuses, duration } = statusConfig.rotatingStatuses
  if (activityType === 'none') {
    client.user.setPresence({ status, activities: [] })
    return
  }
  if (activityType === 'static') {
    client.user.setPresence({ status, activities: [{ name: staticStatus }] })
    return
  }
  if (activityType === 'rotating' || activityType === 'random') {
    if (!statuses || statuses.length === 0) {
      client.user.setPresence({ status, activities: [] })
      return
    }
    const pool = activityType === 'random'
      ? [...statuses].sort(() => Math.random() - 0.5)
      : statuses
    let idx = 0
    const act = { name: pool[idx] }
    client.user.setPresence({ status, activities: [act] })
    if (statusConfig.rotationInterval) clearInterval(statusConfig.rotationInterval)
    if (pool.length > 1) {
      statusConfig.rotationInterval = setInterval(() => {
        idx = (idx + 1) % pool.length
        client.user.setPresence({ status, activities: [{ name: pool[idx] }] })
      }, duration * 1000)
    }
    return
  }
}

addCommand({
  name: "status",
  description: "change bot presence: !status [online/idle/dnd/invisible] [rotating/random/none/static]",
  category: "owner",

  execute: async (msg, args) => {
    if (msg.author.id !== OWNER_ID) return

    const statusArg = args[0]?.toLowerCase()
    const activityArg = args[1]?.toLowerCase()
    const validStatuses = ['online', 'idle', 'dnd', 'invisible']
    const validActivities = ['rotating', 'random', 'none', 'static']

    if (!statusArg || !validStatuses.includes(statusArg)) {
      return msg.reply(`❌ Usage: \`!status [${validStatuses.join('/')}] [${validActivities.join('/')}]\``)
    }
    if (!activityArg || !validActivities.includes(activityArg)) {
      return msg.reply(`❌ Usage: \`!status [${validStatuses.join('/')}] [${validActivities.join('/')}]\``)
    }

    if (statusConfig.rotationInterval) {
      clearInterval(statusConfig.rotationInterval)
      statusConfig.rotationInterval = null
    }

    statusConfig.status = statusArg === 'invisible' ? 'invisible' : statusArg
    statusConfig.activityType = activityArg
    applyStatus()
    await run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES('status_mode',?)",
      [activityArg]
    )

    msg.reply(`✅ Status set to **${statusArg}** with **${activityArg}** activity.`)
  }
})

addCommand({
  name: "settings",
  aliases: ["s"],
  description: "configure bot settings (owner only)",
  category: "owner",

  execute: async (msg) => {
    if (msg.author.id !== OWNER_ID) return

    const filter = i => i.user.id === msg.author.id
    let currentCategory = null
    let settingsMsg

    function getOverviewEmbed() {
      return {
        embeds: [new EmbedBuilder()
          .setTitle("⚙️ Bot Settings")
          .setDescription("Select a category below to configure bot settings.")
          .setColor(0x2ecc71)
          .addFields({ name: "Available Categories", value: "• **Status** - Edit the rotating/static status for the bot." })
          .setFooter({ text: "Settings Panel" })],
        components: [overviewRow()]
      }
    }

    function overviewRow() {
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("settings_cat")
          .setPlaceholder("Choose a category...")
          .addOptions([
            { label: "Status", value: "status", description: "Edit the rotating/static status for the bot." }
          ])
      )
    }

    function statusRow() {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("settings_back")
          .setLabel("⬅️ Back")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("settings_rotating")
          .setLabel("Rotating Statuses")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("settings_static")
          .setLabel("Static Status")
          .setStyle(ButtonStyle.Secondary)
      )
    }

    function getStatusEmbed() {
      const { statuses, duration } = statusConfig.rotatingStatuses
      const fmt = arr => arr.map(s => '`' + s + '`').join(', ')
      return new EmbedBuilder()
        .setTitle("⚙️ Status Settings")
        .setDescription("Edit the rotating/static status for the bot.")
        .setColor(0x2ecc71)
        .addFields(
          { name: "Current Mode", value: `\`${statusConfig.activityType}\``, inline: true },
          { name: "Status Type", value: `\`${statusConfig.status}\``, inline: true },
          { name: "Rotation Interval", value: `\`${duration}s\``, inline: true },
          { name: "Rotating Statuses", value: fmt(statuses || []) || 'None' },
          { name: "Static Status", value: `\`${statusConfig.staticStatus}\`` }
        )
        .setFooter({ text: "Select an option below to edit." })
    }

    const sendUpdate = async (interaction) => {
      if (!currentCategory) {
        await interaction.update(getOverviewEmbed())
      } else if (currentCategory === 'status') {
        await interaction.update({ embeds: [getStatusEmbed()], components: [statusRow()] })
      }
    }

    settingsMsg = await msg.reply(getOverviewEmbed())

    const settingsCollector = settingsMsg.createMessageComponentCollector({ filter, time: 120000 })

    settingsCollector.on('collect', async (interaction) => {
      if (interaction.isStringSelectMenu() && interaction.customId === 'settings_cat') {
        currentCategory = interaction.values[0]
        await sendUpdate(interaction)
        return
      }

      if (!interaction.isButton()) return
      const id = interaction.customId

      if (id === 'settings_back') {
        currentCategory = null
        await sendUpdate(interaction)
        return
      }

      if (id === 'settings_rotating') {
        const modal = new ModalBuilder()
          .setCustomId("s_rotating_modal")
          .setTitle("Rotating Statuses")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("s_rotating_input")
                .setLabel("JSON: {statuses:[...],duration:N}")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('{"statuses":["with the economy","with fire","with code"],"duration":15}')
                .setValue(JSON.stringify(statusConfig.rotatingStatuses, null, 2))
                .setRequired(true)
            )
          )

        await interaction.showModal(modal)
        try {
          const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 60000 })
          const raw = modalSubmit.fields.getTextInputValue("s_rotating_input").trim()
          let parsed
          try {
            parsed = JSON.parse(raw)
            if (!parsed.statuses || !Array.isArray(parsed.statuses)) throw new Error('missing statuses array')
            parsed.statuses = parsed.statuses.filter(s => typeof s === 'string' && s.trim())
            parsed.duration = parseInt(parsed.duration)
            if (!parsed.duration || parsed.duration < 3 || parsed.duration > 3600) throw new Error('invalid duration')
          } catch {
            await modalSubmit.reply({ content: '❌ Invalid format. Use: `{"statuses":["msg1","msg2"],"duration":15}`', ephemeral: true })
            return
          }
          statusConfig.rotatingStatuses = parsed
          await saveRotatingStatuses()
          if (statusConfig.activityType === 'rotating' || statusConfig.activityType === 'random') {
            if (statusConfig.rotationInterval) {
              clearInterval(statusConfig.rotationInterval)
              statusConfig.rotationInterval = null
            }
            applyStatus()
          }
          await modalSubmit.reply({ content: `✅ Rotating statuses updated (${parsed.statuses.length} items, ${parsed.duration}s interval)`, ephemeral: true })
          await settingsMsg.edit({ embeds: [getStatusEmbed()], components: [statusRow()] }).catch(() => {})
        } catch (e) {}
        return
      }

      if (id === 'settings_static') {
        const modal = new ModalBuilder()
          .setCustomId("s_static_modal")
          .setTitle("Static Status")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("s_static_input")
                .setLabel("Status text")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("with the economy")
                .setValue(statusConfig.staticStatus)
                .setRequired(true)
            )
          )

        await interaction.showModal(modal)
        try {
          const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 60000 })
          const text = modalSubmit.fields.getTextInputValue("s_static_input")
          statusConfig.staticStatus = text
          await saveStaticStatus()
          if (statusConfig.activityType === 'static') {
            if (statusConfig.rotationInterval) {
              clearInterval(statusConfig.rotationInterval)
              statusConfig.rotationInterval = null
            }
            applyStatus()
          }
          await modalSubmit.reply({ content: `✅ Static status set to \`${text}\``, ephemeral: true })
          await settingsMsg.edit({ embeds: [getStatusEmbed()], components: [statusRow()] }).catch(() => {})
        } catch (e) {}
        return
      }
    })

    settingsCollector.on('end', async () => {
      await settingsMsg.edit({ components: [] }).catch(() => {})
    })
  }
})

addCommand({
  name: "quests",
  description: "view and accept quests",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const userQuests = JSON.parse(user.quests || '{}')

    function getQuestStatus(q) {
      const uq = userQuests[q.id]
      if (uq?.status === 'active') return 'active'
      if (uq?.status === 'completed') return 'completed'
      if (uq?.status === 'redeemed') return 'redeemed'
      if (!uq && user.level >= (q.minLevel || 0)) return 'available'
      return 'locked'
    }

    function getMainEmbed() {
      const all = QUESTS.map(q => ({ ...q, status: getQuestStatus(q) }))
      const active = all.filter(q => q.status === 'active')
      const available = all.filter(q => q.status === 'available')
      const completed = all.filter(q => q.status === 'completed' || q.status === 'redeemed')

      const embed = new EmbedBuilder()
        .setTitle("📋 Quest Log")
        .setColor(0x9b59b6)
        .setFooter({ text: "Select a quest below to view details." })

      const desc = []
      if (active.length) desc.push(`**▶ Active**\n${active.map(q => `${q.name} (${(userQuests[q.id]?.progress?.length || 0)}/${q.tasks.length})`).join('\n')}`)
      if (available.length) desc.push(`**○ Available**\n${available.map(q => `${q.name}`).join('\n')}`)
      if (completed.length) desc.push(`**✅ Completed**\n${completed.map(q => `${q.name}`).join('\n')}`)
      embed.setDescription(desc.join('\n\n') || 'No quests available right now.')

      const opts = []
      active.forEach(q => {
        const p = userQuests[q.id]?.progress?.length || 0
        opts.push({ label: `▶ ${q.name} (${p}/${q.tasks.length})`, value: q.id })
      })
      available.forEach(q => opts.push({ label: `○ ${q.name}`, value: q.id }))
      completed.forEach(q => {
        const redeemed = userQuests[q.id]?.status === 'redeemed'
        opts.push({ label: `✅ ${q.name}${redeemed ? '' : ' [REDEEM]'}`, value: q.id })
      })
      if (!opts.length) opts.push({ label: 'No quests available', value: '_none' })

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("quest_pick")
          .setPlaceholder("Select a quest...")
          .addOptions(opts)
      )

      return { embeds: [embed], components: [row] }
    }

    function getDetailEmbed(q) {
      const status = getQuestStatus(q)
      const uq = userQuests[q.id]
      const embed = new EmbedBuilder()
        .setTitle(`📋 ${q.name}`)
        .setColor(0x9b59b6)

      if (status === 'active') {
        const done = uq?.progress?.length || 0
        embed.setDescription(`**${q.preview}**\nProgress: **${done}/${q.tasks.length}**`)
        q.tasks.forEach(t => {
          const d = uq?.progress?.includes(t)
          embed.addFields({ name: `${d ? '✅' : '⬜'} ${t}`, value: d ? 'Purchased' : 'Not yet bought', inline: true })
        })
      } else if (status === 'completed') {
        embed.setDescription(`**${q.preview}**\n🎉 All tasks complete! Redeem your **${q.xp} XP** reward.`)
        q.tasks.forEach(t => embed.addFields({ name: `✅ ${t}`, value: 'Purchased', inline: true }))
      } else if (status === 'redeemed') {
        embed.setDescription(`**${q.preview}**\n✅ Already redeemed for **${q.xp} XP**.`)
      } else {
        embed.setDescription(`*${q.preview}*\n\n🎯 **Rewards:** ${q.xp} XP\n📋 **Tasks:** ${q.tasks.length} items to buy`)
      }

      const row = new ActionRowBuilder()
      if (status === 'available') {
        row.addComponents(
          new ButtonBuilder().setCustomId("q_accept").setLabel("Accept").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("q_back").setLabel("Back").setStyle(ButtonStyle.Secondary)
        )
      } else if (status === 'completed') {
        row.addComponents(
          new ButtonBuilder().setCustomId("q_redeem").setLabel(`REDEEM ${q.xp} XP`).setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("q_back").setLabel("Back").setStyle(ButtonStyle.Secondary)
        )
      } else {
        row.addComponents(new ButtonBuilder().setCustomId("q_back").setLabel("Back").setStyle(ButtonStyle.Secondary))
      }

      return { embeds: [embed], components: [row] }
    }

    async function saveQuests() {
      await run(`UPDATE users SET quests=? WHERE id=?`, [JSON.stringify(userQuests), msg.author.id])
    }

    let currentQuest = null
    const questMsg = await msg.reply(getMainEmbed())
    const col = questMsg.createMessageComponentCollector({ filter: i => i.user.id === msg.author.id, time: 120000 })

    col.on('collect', async (interaction) => {
      if (interaction.isStringSelectMenu()) {
        const val = interaction.values[0]
        if (val === '_none') {
          await interaction.deferUpdate()
          return
        }
        currentQuest = QUESTS.find(q => q.id === val)
        if (currentQuest) await interaction.update(getDetailEmbed(currentQuest))
        return
      }

      if (!interaction.isButton()) return
      if (interaction.customId === 'q_back') {
        currentQuest = null
        await interaction.update(getMainEmbed())
        return
      }
      if (interaction.customId === 'q_accept' && currentQuest) {
        if (!userQuests[currentQuest.id]) {
          userQuests[currentQuest.id] = { status: 'active', progress: [] }
          await saveQuests()
        }
        currentQuest = null
        await interaction.update(getMainEmbed())
        return
      }
      if (interaction.customId === 'q_redeem' && currentQuest) {
        const uq = userQuests[currentQuest.id]
        if (uq?.status === 'completed') {
          uq.status = 'redeemed'
          await run(`UPDATE users SET xp = xp + ?, quests = ? WHERE id=?`, [currentQuest.xp, JSON.stringify(userQuests), msg.author.id])
          await addXp(msg, msg.author.id, 0)
          const biz = JSON.parse(user.businesses || '{}')
          if (!biz.weed) {
            biz.weed = { sprinkler: 0, growhouse: 0, soil: 0, buds: 0, pots: 0, weed_seeds: 0, plants: [] }
            await run(`UPDATE users SET businesses=? WHERE id=?`, [JSON.stringify(biz), msg.author.id])
          }
          await interaction.update(getDetailEmbed(currentQuest))
        }
        return
      }
    })

    col.on('end', async () => {
      await questMsg.edit({ components: [] }).catch(() => {})
    })
  }
})

addCommand({
  name: "inventory",
  description: "view your purchased items",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const inv = JSON.parse(user.inventory || '[]')
    const embed = new EmbedBuilder()
      .setTitle("🎒 Inventory")
      .setColor(0x3498db)

    if (inv.length === 0) {
      embed.setDescription("Your inventory is empty. Buy items from `!shop`!")
    } else {
      inv.forEach(key => {
        const item = SHOP_ITEMS[key]
        if (item) {
          embed.addFields({ name: item.name, value: item.desc, inline: true })
        }
      })
    }
    msg.reply({ embeds: [embed] })
  }
})

addCommand({
  name: "businesses",
  description: "view your owned businesses",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const biz = JSON.parse(user.businesses || '{}')
    const keys = Object.keys(biz)
    const embed = new EmbedBuilder()
      .setTitle("🏢 Your Businesses")
      .setColor(0x00ae86)

    if (keys.length === 0) {
      embed.setDescription("You don't own any businesses yet. Complete quests to unlock them!")
    } else {
      keys.forEach(key => {
        if (key === 'weed') {
          const w = biz.weed
          const plants = w.plants || []
          const ready = plants.filter(p => Date.now() >= p.readyAt).length
          const active = plants.length - ready
          embed.addFields({
            name: "🌿 Weed Business",
            value: `Bud: **${(w.buds || 0).toFixed(1)}g**\nPots: ${w.pots || 0} | Seeds: ${w.weed_seeds || 0}\nPlants: ${active} growing, ${ready} ready\nSprinklers: ${w.sprinkler || 0} | Soil: ${w.soil || 0} | Growhouses: ${w.growhouse || 0}`,
            inline: true
          })
        }
      })
    }
    msg.reply({ embeds: [embed] })
  }
})




addCommand({
  name: "business",
  description: "manage your businesses: !business weed",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const sub = args[0]?.toLowerCase()
    const biz = JSON.parse(user.businesses || '{}')

    if (!sub || sub === 'weed') {
      if (!biz.weed) {
        return msg.reply("❌ You don't own a weed business. Complete the `Make a Business` quest to unlock it!")
      }
      msg.reply({ embeds: [getWeedEmbed(biz.weed)], components: [getWeedRow()] })
    }
  }
})

addCommand({
  name: "weed",
  description: "alias for !business weed",
  category: "economy_banking",

  execute: async (msg, args, user) => {
    const biz = JSON.parse(user.businesses || '{}')
    if (!biz.weed) {
      return msg.reply("❌ You don't own a weed business. Complete the `Make a Business` quest to unlock it!")
    }
    msg.reply({ embeds: [getWeedEmbed(biz.weed)], components: [getWeedRow()] })
  }
})
addCommand({
  name: "print",
  description: "Inject cash into the economy (Owner only)",
  category: "owner",
  execute: async (msg, args) => {
    if (msg.author.id !== OWNER_ID) return msg.reply("Only the bot owner can use this.")
    const raw = args.join(" ")
    const amount = parseInt(raw.replace(/,/g, ""), 10)
    if (!amount || amount <= 0) return msg.reply("Usage: `!print 200,000,000`")
    await run(`UPDATE settings SET value = CAST(value AS INTEGER) + ? WHERE key='general_bank'`, [amount])
    const bank = await getGeneralBank()
    msg.reply(`💵 Printed **${formatMoney(amount)}** into the economy.\n🏦 General Bank balance: **${formatMoney(bank)}**`)
  }
})

addCommand({
  name: "pair",
  description: "generate a pairing code to link this server to your web dashboard (Admin only)",
  category: "admin",
  execute: async (msg) => {
    if (!msg.guild) return msg.reply("This command can only be used in a server!")
    if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator) && msg.author.id !== OWNER_ID)
      return msg.reply("Only server administrators can generate pairing codes.")
    const code = Math.random().toString(36).substring(2, 8).toUpperCase()
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    db.run(`INSERT INTO pairing_codes (code, discord_id, guild_id, expires_at) VALUES (?, ?, ?, ?)`,
      [code, msg.author.id, msg.guild.id, expiresAt])
    msg.reply(`Your pairing code is: **${code}**\nEnter this on the web dashboard to link this server to your account.\nCode expires in 5 minutes.`)
  }
})

addCommand({
  name: "unlink",
  description: "unlink this server from your web dashboard account",
  category: "utility",
  execute: async (msg) => {
    if (!msg.guild) return msg.reply("This command can only be used in a server!")
    db.run(`DELETE FROM server_links WHERE guild_id=?`, [msg.guild.id])
    msg.reply("This server has been unlinked from all web dashboard accounts.")
  }
})

function line(left, fill, right, width) {
  return left + fill.repeat(Math.max(0, width - left.length - right.length)) + right;
}
client.once("ready", async (c) => {
  console.log(`logged in as ${c.user.username}`)
  await loadStatusConfig()

  if (
    ['rotating', 'random', 'static']
      .includes(statusConfig.activityType)
  ) {
    console.log(`Status: ${statusConfig.status} ${statusConfig.activityType}`)
    applyStatus()
  }

  webServer.init(client, db, commands, {
    statusConfig,
    saveRotatingStatuses,
    saveStaticStatus,
    applyStatus,
    run
  })

// Bank Interest Cycle (Every 3 minutes, based on total circulation vs 500B target)
intervals.push(setInterval(async () => {
  try {
      const rows = await all(`SELECT wallet, bank, bankspace FROM users LIMIT 5000`)
      const totalCash = rows.reduce((a, b) => a + (b.wallet || 0) + (b.bank || 0), 0)
      const TARGET = 500_000_000_000
      const ratio = totalCash / TARGET
      let multiplier
      if (ratio >= 1) {
        // deflationary: more than 500B, shrink bank values up to 0
        multiplier = Math.max(0, 1.0 + (1 - ratio) * 0.1)
      } else {
        // growth: less than 500B, grow bank values
        multiplier = 1.0 + (1 - ratio) * 0.03
      }
      if (multiplier <= 1.0) {
        // deflation: just apply shrinkage
        await run(`UPDATE users SET bank = CAST(bank * ${multiplier} AS INTEGER) WHERE bank > 0`)
      } else {
        // growth: deduct from general bank first
        const interestPct = multiplier - 1.0
        let totalInterest = 0
        for (const u of rows) {
          if ((u.bank || 0) > 0) {
            const gain = Math.min(Math.round((u.bank || 0) * interestPct), (u.bankspace || 5000) - (u.bank || 0))
            if (gain > 0) totalInterest += gain
          }
        }
        const generalBank = await getGeneralBank()
        const canCover = Math.min(totalInterest, Math.max(0, generalBank))
        if (canCover > 0) {
          await addToGeneralBank(-canCover)
          // apply pro-rated interest based on what we can cover
          const prorated = canCover / totalInterest
          for (const u of rows) {
            if ((u.bank || 0) > 0) {
              const gain = Math.min(Math.round((u.bank || 0) * interestPct * prorated), (u.bankspace || 5000) - (u.bank || 0))
              if (gain > 0) {
                await run(`UPDATE users SET bank = MIN(bankspace, bank + ?) WHERE id=?`, [gain, u.id])
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Interest cycle error:", e)
    }
  }, 180000))

  // Debt Foreclosure System (Runs every second, automatically reposesses assets of users in debt)
  setInterval(async () => {
    try {
      const usersInDebt = await all(`SELECT * FROM users WHERE (wallet + bank) < 0`)
      for (const u of usersInDebt) {
        let inventory = JSON.parse(u.inventory || "[]")
        let changed = false
        let lostMansion = false
        let lostBriefcase = false

        if (inventory.includes("mansion")) {
          inventory = inventory.filter(i => i !== "mansion")
          u.multiplier = Math.max(1.0, u.multiplier - 0.5)
          changed = true
          lostMansion = true
        }
        if (inventory.includes("briefcase")) {
          inventory = inventory.filter(i => i !== "briefcase")
          u.bankspace = Math.max(5000, u.bankspace - 10000)
          changed = true
          lostBriefcase = true
        }

        if (changed) {
          await run(
            `UPDATE users SET inventory = ?, multiplier = ?, bankspace = ? WHERE id = ?`,
            [JSON.stringify(inventory), u.multiplier, u.bankspace, u.id]
          )

          const discordUser = await client.users.fetch(u.id).catch(() => null)
          if (discordUser) {
            let notice = `🚨 **FORECLOSURE NOTICE** 🚨\n` +
                         `Your account has fallen into a negative balance debt of **${formatMoney(u.wallet + u.bank)}**!\n` +
                         `As a result, the Central Bank has seized and foreclosed your luxury assets:\n`
            if (lostMansion) notice += `🏠 **Luxury Mansion** has been repossessed. (Payout multiplier reduced by 0.5x)\n`
            if (lostBriefcase) notice += `💼 **Golden Briefcase** has been repossessed. (Bank storage capacity reduced by 10,000)\n`
            notice += `\n*Please execute \`!apply fast_food\` and use \`!work\` to build your balances back up!*`
            await discordUser.send(notice).catch(() => {})
          }
        }
      }
    } catch (e) {
      // Suppress errors during background cycles to guarantee client stability
    }
  }, 30000)

  // Dynamic Inflation System (Adjust and fluctuate inflation values)
  setInterval(async () => {
    const rows = await all(
      `SELECT wallet, bank FROM users LIMIT 5000`
    )

    const totalMoney = rows.reduce(
      (a, b) => a + b.wallet + b.bank,
      0
    )

    let inflation = await getInflation()

    if (totalMoney > 100000) {
      inflation += 0.01
    } else {
      inflation -= 0.01
    }

    if (inflation < 0.5) inflation = 0.5
    if (inflation > 5) inflation = 5

    await setInflation(inflation)
  }, 300000)

})

// Weed price fluctuation
let weedPrice = 40
const BUYERS = ['some hippies', 'a grandma', 'a mother', 'some teenager', 'a chef', 'a nurse', 'a retired cop', 'a yoga instructor']

setInterval(() => {
  const shift = (Math.random() - 0.5) * 10
  weedPrice = Math.round(Math.min(50, Math.max(30, weedPrice + shift)) * 100) / 100
}, 60000)

function getGrowthTime(sprinklers, soil) {
  return Math.max(60000, 300000 - (sprinklers || 0) * 20000 - (soil || 0) * 10000)
}

function getYield(growhouses) {
  return 1 + (growhouses || 0) * 0.5
}

function getWeedEmbed(w) {
  const limit = (w.pots || 0) * 4
  const plants = w.plants || []
  const active = plants.filter(p => Date.now() < p.readyAt)
  const ready = plants.filter(p => Date.now() >= p.readyAt)
  const now = Date.now()

  const lines = [
    `💰 **Bud:** ${(w.buds || 0).toFixed(1)}g | 💹 **Price:** $${weedPrice.toFixed(2)}/g`,
    `🪴 **Pots:** ${w.pots || 0} | 🌱 **Seeds:** ${w.weed_seeds || 0}`,
    `🌿 **Plants:** ${plants.length}/${limit} (${ready.length} ready${ready.length ? ' ✅' : ''})`
  ]

  if (active.length) {
    const first = active[0]
    const remaining = Math.max(0, first.readyAt - now)
    const mins = Math.floor(remaining / 60000)
    const secs = Math.floor((remaining % 60000) / 1000)
    lines.push(`⏳ **Next harvest in:** ${mins}m ${secs}s`)
  }

  return new EmbedBuilder()
    .setTitle("🌿 Weed Business")
    .setColor(0x00ae86)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Yield: ${getYield(w.growhouse || 0).toFixed(1)}g/plant | ${w.sprinkler || 0}s | ${w.soil || 0}l | ${w.growhouse || 0}gh` })
}

function getWeedRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("weed_plant").setLabel("🌱 Plant").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("weed_harvest").setLabel("🌿 Harvest").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("weed_sell").setLabel("💰 Sell").setStyle(ButtonStyle.Secondary)
  )
}

client.on("interactionCreate", async (interaction) => {
  // Quest redeem button from notification
  if (interaction.isButton() && interaction.customId.startsWith('quest_redeem_')) {
    const userId = interaction.customId.replace('quest_redeem_', '')
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This redeem button is not for you.', ephemeral: true })
    }
    const user = await getUser(userId)
    const userQuests = JSON.parse(user.quests || '{}')
    const q = userQuests['business_supplies']
    if (q?.status === 'completed') {
      q.status = 'redeemed'
      const questData = QUESTS.find(x => x.id === 'business_supplies')
      await run(`UPDATE users SET xp = xp + ?, quests = ? WHERE id=?`, [questData.xp, JSON.stringify(userQuests), userId])
      // Unlock weed business
      const biz = JSON.parse(user.businesses || '{}')
      if (!biz.weed) {
        biz.weed = { sprinkler: 0, growhouse: 0, soil: 0, buds: 0, pots: 0, weed_seeds: 0, plants: [] }
        await run(`UPDATE users SET businesses=? WHERE id=?`, [JSON.stringify(biz), userId])
      }
      await interaction.update({ content: `✅ Redeemed **${questData.xp} XP**! Weed business unlocked! Use \`!business weed\` to check it.`, components: [] })
    } else {
      await interaction.update({ content: '❌ This quest has already been redeemed or is not completed.', components: [] })
    }
    return
  }

  if (interaction.isButton() && interaction.customId === "confess_btn") {
    const modal = new ModalBuilder()
      .setCustomId("confess_modal")
      .setTitle("Anonymous Confession")

    const confessionInput = new TextInputBuilder()
      .setCustomId("confession_text")
      .setLabel("What's your confession?")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Type your confession here...")
      .setMinLength(1)
      .setMaxLength(1000)
      .setRequired(true)

    const actionRow = new ActionRowBuilder().addComponents(confessionInput)
    modal.addComponents(actionRow)

    await interaction.showModal(modal)
  }

  if (interaction.isModalSubmit() && interaction.customId === "confess_modal") {
    const confession = interaction.fields.getTextInputValue("confession_text")

    const confessEmbed = new EmbedBuilder()
      .setTitle("🤫 Anonymous Confession")
      .setDescription(confession)
      .setColor(0x9b59b6)
      .setTimestamp()

    await interaction.reply({ content: "✅ Your confession has been posted anonymously!", ephemeral: true })
    await interaction.channel.send({ embeds: [confessEmbed] })
  }

  // Weed business interactions
  if (interaction.isButton()) {
    const uid = interaction.user.id
    let user, biz

    if (interaction.customId === 'weed_plant' || interaction.customId === 'weed_harvest' || interaction.customId === 'weed_sell') {
      user = await getUser(uid)
      biz = JSON.parse(user.businesses || '{}')
      if (!biz.weed) {
        return interaction.reply({ content: "❌ You don't own a weed business!", ephemeral: true })
      }
    }

    if (interaction.customId === 'weed_plant') {
      const w = biz.weed
      const plants = w.plants || []
      const limit = (w.pots || 0) * 4
      if (plants.length >= limit) {
        return interaction.reply({ content: `❌ All **${limit}** plant slots are full! Buy more pots.`, ephemeral: true })
      }
      if ((w.weed_seeds || 0) <= 0) {
        return interaction.reply({ content: '❌ No seeds! Buy weed seeds from the shop.', ephemeral: true })
      }
      const growthTime = getGrowthTime(w.sprinkler, w.soil)
      const now = Date.now()
      plants.push({ plantedAt: now, readyAt: now + growthTime })
      w.plants = plants
      w.weed_seeds = (w.weed_seeds || 0) - 1
      await run(`UPDATE users SET businesses=? WHERE id=?`, [JSON.stringify(biz), uid])
      await interaction.update({ embeds: [getWeedEmbed(w)], components: [getWeedRow()] })
      return
    }

    if (interaction.customId === 'weed_harvest') {
      const w = biz.weed
      const plants = w.plants || []
      const ready = plants.filter(p => Date.now() >= p.readyAt)
      if (!ready.length) {
        return interaction.reply({ content: '❌ No plants are ready to harvest yet!', ephemeral: true })
      }
      const yieldPerPlant = getYield(w.growhouse || 0)
      const total = yieldPerPlant * ready.length
      w.buds = (w.buds || 0) + total
      w.plants = plants.filter(p => Date.now() < p.readyAt)
      await run(`UPDATE users SET businesses=? WHERE id=?`, [JSON.stringify(biz), uid])
      await interaction.update({ embeds: [getWeedEmbed(w)], components: [getWeedRow()] })
      await interaction.followUp({ content: `🌿 Harvested **${total.toFixed(1)}g** of bud from **${ready.length}** plant(s)!`, ephemeral: true })
      return
    }

    if (interaction.customId === 'weed_sell') {
      const w = biz.weed
      if (!w.buds || w.buds <= 0) {
        return interaction.reply({ content: '❌ No bud to sell! Plant and harvest some first.', ephemeral: true })
      }
      const modal = new ModalBuilder()
        .setCustomId("weed_sell_modal")
        .setTitle("Sell Weed Buds")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("weed_sell_amount")
              .setLabel(`How many grams? (You have ${(w.buds || 0).toFixed(1)}g, $${weedPrice.toFixed(2)}/g)`)
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("e.g. 2.5")
              .setRequired(true)
          )
        )
      await interaction.showModal(modal)
      return
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === 'weed_sell_modal') {
    const uid = interaction.user.id
    const user = await getUser(uid)
    const biz = JSON.parse(user.businesses || '{}')
    if (!biz.weed) {
      return interaction.reply({ content: "❌ You don't own a weed business!", ephemeral: true })
    }
    const w = biz.weed
    const raw = interaction.fields.getTextInputValue("weed_sell_amount").trim()
    const amount = parseFloat(raw)
    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: '❌ Enter a valid positive number.', ephemeral: true })
    }
    if (amount > (w.buds || 0)) {
      return interaction.reply({ content: `❌ You only have **${(w.buds || 0).toFixed(1)}g** to sell.`, ephemeral: true })
    }
    const earned = Math.round(amount * weedPrice * 100) / 100
    const buyer = BUYERS[Math.floor(Math.random() * BUYERS.length)]
    w.buds = Math.round(((w.buds || 0) - amount) * 100) / 100
    await run(`UPDATE users SET wallet = wallet + ?, businesses = ? WHERE id=?`, [earned, JSON.stringify(biz), uid])
    await addToGeneralBank(earned)
    await interaction.reply({ content: `💰 You sold **${amount.toFixed(1)}g** of bud to **${buyer}** for **$${earned.toFixed(2)}**!` })
    // Try to update the original message embed if it still exists
    try {
      await interaction.message.edit({ embeds: [getWeedEmbed(w)], components: [getWeedRow()] })
    } catch {}
    return
  }
})

client.on("messageCreate", async msg => {
  try {
    if (msg.author.bot) return

    const prefix = await getPrefix(msg.author.id)

    if (!msg.content.startsWith(prefix)) return

    const args = msg.content
      .slice(prefix.length)
      .trim()
      .split(/ +/g)

    const cmdName = args.shift()?.toLowerCase()

    const command = [...commands.values()].find(cmd =>
      cmd.name === cmdName ||
      cmd.aliases?.includes(cmdName)
    )

    if (command) {
      if (msg.guild && command.category !== 'owner') {
        const toggle = await get(`SELECT enabled FROM command_toggles WHERE guild_id=? AND command_name=?`,
          [msg.guild.id, command.name])
        if (toggle && !toggle.enabled) return
      }
      await ensureUser(msg.author.id)
      await run(`UPDATE users SET last_channel=? WHERE id=?`, [msg.channel.id, msg.author.id])
      const user = await getUser(msg.author.id)
      await command.execute(msg, args, user)
      run(`INSERT INTO command_stats (command_name, guild_id, user_id, timestamp) VALUES (?, ?, ?, ?)`,
        [command.name, msg.guild?.id || 'dm', msg.author.id, Date.now()]).catch(() => {})
      return
    }

    // Custom commands (Myntax)
    const guildId = msg.guild?.id || '*'
        const cc = await get(`SELECT * FROM custom_cmds WHERE (server_id='*' OR server_id=?) AND name=? ORDER BY server_id DESC LIMIT 1`, [guildId, cmdName])
        if (cc) {
          await ensureUser(msg.author.id)
          await run(`UPDATE users SET last_channel=? WHERE id=?`, [msg.channel.id, msg.author.id])
          const user = await getUser(msg.author.id)

           await runMyntax(cc.script, msg, user, !!cc.suppress_errors, getGeneralBank, db)

          run(`INSERT INTO command_stats (command_name, guild_id, user_id, timestamp) VALUES (?, ?, ?, ?)`,
            [cc.name, msg.guild?.id || 'dm', msg.author.id, Date.now()]).catch(() => {})
          return
        }
  } catch (err) {
    console.error(err)
    msg.reply("command exploded")
  }
})

async function goOffline() {
  try {
    if (client?.user) {
      await client.user.setPresence({
        status: "invisible"
      })
    }
  } catch {}
  process.exit()
}

process.on("SIGINT", goOffline)
process.on("SIGTERM", goOffline)

console.log("initialized");
client.login(process.env.TOKEN)
  .then(() => {
    console.log("valid token");
  })
  .catch(err => {
    console.error("login failed");
    console.error(err);
  });
module.exports = { db };

