require('dotenv').config({ path: __dirname + '/.env' })
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const PORT = parseInt(process.env.WEB_PORT) || 28015
const OWNER_ID = process.env.OWNER_ID || '338401360137551874'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set in .env')
  process.exit(1)
}

const AUTH_TOKEN_TTL = 86400

let client = null
let db = null
let metricsInterval = null
let commandsMap = null
let botHelpers = null

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return hash === verify
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Simple rate limiter
const rateLimitMap = new Map();
function rateLimiter(limit, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    let records = rateLimitMap.get(ip) || [];
    records = records.filter(timestamp => timestamp > windowStart);
    if (records.length >= limit) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    records.push(now);
    rateLimitMap.set(ip, records);
    next();
  };
}

function init(discordClient, database, cmds, helpers) {
  client = discordClient
  db = database
  commandsMap = cmds
  botHelpers = helpers

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS web_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      discord_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`)

    db.run("DROP TABLE IF EXISTS pairing_codes")
    db.run(`CREATE TABLE IF NOT EXISTS pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL,
      used_by INTEGER DEFAULT NULL
    )`)

    db.run("DROP TABLE IF EXISTS server_links")
    db.run(`CREATE TABLE IF NOT EXISTS server_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      linked_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(username, guild_id)
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS command_toggles (
      guild_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (guild_id, command_name)
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      ram_rss REAL NOT NULL,
      ram_total REAL NOT NULL,
      cpu_percent REAL NOT NULL
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      username TEXT,
      user_id TEXT,
      timestamp INTEGER DEFAULT (strftime('%s','now'))
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      username TEXT,
      user_id TEXT,
      category TEXT DEFAULT 'general',
      status TEXT DEFAULT 'open',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS command_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_name TEXT NOT NULL,
      guild_id TEXT,
      user_id TEXT,
      timestamp INTEGER NOT NULL
    )`)

    db.run("DROP TABLE IF EXISTS auth_tokens")
    db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL
    )`)

    db.run(`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics (timestamp)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_cmd_stats_name ON command_stats (command_name)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_cmd_stats_ts ON command_stats (timestamp)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at)`)

    db.run(`CREATE TABLE IF NOT EXISTS server_vars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(server_id, key)
    )`)

    db.run(`CREATE TABLE IF NOT EXISTS custom_cmds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      server_id TEXT DEFAULT '*',
      script TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      suppress_errors INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`)

    db.run("ALTER TABLE metrics ADD COLUMN ram_rss REAL", () => {})
    db.run("ALTER TABLE metrics ADD COLUMN ram_total REAL", () => {})
    db.run("ALTER TABLE metrics ADD COLUMN cpu_percent REAL", () => {})
    db.run("ALTER TABLE web_users ADD COLUMN password_hash TEXT", () => {})
    db.run("ALTER TABLE web_users ADD COLUMN discord_id TEXT DEFAULT NULL", () => {})
    db.run("ALTER TABLE web_users ADD COLUMN created_at INTEGER DEFAULT (strftime('%s','now'))", () => {})
    db.run("ALTER TABLE custom_cmds ADD COLUMN description TEXT DEFAULT ''", () => {})
    db.run("ALTER TABLE custom_cmds ADD COLUMN category TEXT DEFAULT 'general'", () => {})
  })

  ensureAdminUser()

  if (metricsInterval) clearInterval(metricsInterval)
  metricsInterval = setInterval(collectMetrics, 5000)

  setInterval(() => {
    const now = Math.floor(Date.now() / 1000)
    db.run(`DELETE FROM auth_tokens WHERE expires_at < ?`, [now])
  }, 3600000)

  startWebServer()
}

function ensureAdminUser() {
  const hash = hashPassword(ADMIN_PASSWORD)
  db.run(`INSERT OR IGNORE INTO web_users (username, password_hash, discord_id) VALUES (?, ?, ?)`,
    [ADMIN_USERNAME, hash, OWNER_ID])
  db.run(`UPDATE web_users SET password_hash=?, discord_id=? WHERE username=?`,
    [hash, OWNER_ID, ADMIN_USERNAME])
}

function collectMetrics() {
  const now = Math.floor(Date.now() / 1000)
  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const ramRss = mem.rss
  const ramTotal = totalMem
  const cpus = os.cpus()
  const loadAvg = os.loadavg()[0]
  const cpuPercent = Math.min(100, (loadAvg / cpus.length) * 100)
  db.run(`INSERT INTO metrics (timestamp, ram_rss, ram_total, cpu_percent) VALUES (?, ?, ?, ?)`,
    [now, ramRss, ramTotal, cpuPercent])
}

function audit(action, details, username, userId) {
  db.run(`INSERT INTO audit_log (action, details, username, user_id) VALUES (?, ?, ?, ?)`,
    [action, details || '', username || 'system', userId || ''])
}

function lookupToken(token, cb) {
  if (!token) return cb(null)
  const now = Math.floor(Date.now() / 1000)
  db.get(`SELECT web_users.username, web_users.discord_id
    FROM auth_tokens JOIN web_users ON auth_tokens.username = web_users.username
    WHERE auth_tokens.token=? AND auth_tokens.expires_at > ?`, [token, now], (err, row) => {
    if (err || !row) return cb(null)
    cb({
      username: row.username,
      discordId: row.discord_id,
      isOwner: row.discord_id === OWNER_ID
    })
  })
}

function startWebServer() {
  const app = express()

  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(express.static(path.join(__dirname, 'public')))

  function extractToken(req) {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
    return null
  }

  function requireAuth(req, res, next) {
    const token = extractToken(req)
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    lookupToken(token, (user) => {
      if (!user) return res.status(401).json({ error: 'Unauthorized' })
      req.authUser = user
      next()
    })
  }

  function requireOwner(req, res, next) {
    if (req.authUser.discordId !== OWNER_ID) return res.status(403).json({ error: 'Forbidden' })
    next()
  }

  app.get('/api/session', (req, res) => {
    const token = extractToken(req)
    if (!token) return res.json({ loggedIn: false })
    lookupToken(token, (user) => {
      if (!user) return res.json({ loggedIn: false })
      res.json({ loggedIn: true, user })
    })
  })

  app.post('/api/register', rateLimiter(5, 60000), (req, res) => {
    const { username, password } = req.body
    if (!username || !password || username.length < 3 || password.length < 6)
      return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' })
    db.get(`SELECT username FROM web_users WHERE username=?`, [username], (err, row) => {
      if (row) return res.status(409).json({ error: 'Username already taken' })
      const hash = hashPassword(password)
      db.run(`INSERT INTO web_users (username, password_hash) VALUES (?, ?)`, [username, hash], function(err) {
        if (err) return res.status(500).json({ error: 'Registration failed' })
        const token = generateToken()
        db.run(`INSERT INTO auth_tokens (token, username, expires_at) VALUES (?, ?, ?)`, [token, username, Math.floor(Date.now()/1000) + AUTH_TOKEN_TTL])
        audit('register', `User registered: ${username}`, username, username)
        res.json({
          success: true,
          token,
          user: { username, discordId: null, isOwner: false }
        })
      })
    })
  })

  app.post('/api/login', rateLimiter(5, 60000), (req, res) => {
    const { username, password } = req.body
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' })
    db.get(`SELECT * FROM web_users WHERE username=?`, [username], (err, row) => {
      if (!row || !verifyPassword(password, row.password_hash))
        return res.status(401).json({ error: 'Invalid credentials' })
      const token = generateToken()
      db.run(`INSERT INTO auth_tokens (token, username, expires_at) VALUES (?, ?, ?)`, [token, row.username, Math.floor(Date.now()/1000) + AUTH_TOKEN_TTL])
      audit('login', `User logged in: ${username}`, username, row.username)
      res.json({
        success: true,
        token,
        user: { username: row.username, discordId: row.discord_id, isOwner: row.discord_id === OWNER_ID }
      })
    })
  })

  app.post('/api/logout', (req, res) => {
    const token = extractToken(req)
    if (token) db.run(`DELETE FROM auth_tokens WHERE token=?`, [token])
    res.json({ success: true })
  })

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.authUser })
  })

  app.post('/api/link-discord', requireAuth, (req, res) => {
    const { discordId } = req.body
    if (!discordId) return res.status(400).json({ error: 'discordId required' })
    db.run(`UPDATE web_users SET discord_id=? WHERE username=?`, [discordId, req.authUser.username])
    req.authUser.discordId = discordId
    req.authUser.isOwner = discordId === OWNER_ID
    audit('link_discord', `Linked Discord ID: ${discordId}`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.post('/api/pair', requireAuth, (req, res) => {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: 'Code required' })
    const now = Math.floor(Date.now() / 1000)
    db.get(`SELECT * FROM pairing_codes WHERE code=? AND expires_at>? AND used_by IS NULL`,
      [code.toUpperCase(), now], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Invalid or expired code' })
        db.get(`SELECT id FROM server_links WHERE username=? AND guild_id=?`,
          [req.authUser.username, row.guild_id], (err, link) => {
            if (link) return res.status(409).json({ error: 'Server already linked to your account' })
            db.run(`INSERT INTO server_links (username, guild_id) VALUES (?, ?)`,
              [req.authUser.username, row.guild_id])
            db.run(`UPDATE pairing_codes SET used_by=? WHERE id=?`, [req.authUser.username, row.id])
            const guild = client.guilds.cache.get(row.guild_id)
            audit('pair', `Paired server: ${guild?.name || row.guild_id}`, req.authUser.username, req.authUser.username)
            res.json({
              success: true,
              server: {
                id: row.guild_id,
                name: guild?.name || 'Unknown Server',
                icon: guild?.iconURL({ size: 32 }) || null
              }
            })
          })
      })
  })

  app.get('/api/servers', requireAuth, (req, res) => {
    if (req.authUser.discordId === OWNER_ID) {
      const guilds = client.guilds.cache.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL({ size: 32 }),
        memberCount: g.memberCount
      }))
      return res.json({ servers: guilds, isOwner: true })
    }
    db.all(`SELECT guild_id FROM server_links WHERE username=?`,
      [req.authUser.username], (err, rows) => {
        const guildIds = rows.map(r => r.guild_id)
        const guilds = guildIds.map(id => {
          const g = client.guilds.cache.get(id)
          return g ? { id: g.id, name: g.name, icon: g.iconURL({ size: 32 }), memberCount: g.memberCount } : null
        }).filter(Boolean)
        res.json({ servers: guilds, isOwner: false })
      })
  })

  app.delete('/api/servers/:guildId', requireAuth, (req, res) => {
    const { guildId } = req.params
    db.run(`DELETE FROM server_links WHERE username=? AND guild_id=?`,
      [req.authUser.username, guildId])
    audit('unlink', `Unlinked server: ${guildId}`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.post('/api/servers/:guildId/leave', requireAuth, requireOwner, async (req, res) => {
    const { guildId } = req.params
    try {
      const guild = client.guilds.cache.get(guildId)
      if (!guild) return res.status(404).json({ error: 'Guild not found in cache' })
      const owner = await guild.fetchOwner()
      if (owner) {
        await owner.send(`Your server **${guild.name}** has been forcefully removed from the bot's services. The bot owner has requested this action. If you have questions, please contact <@338401360137551874>.`).catch(() => {})
      }
      await guild.leave()
      audit('force_leave', `Forcefully left guild: ${guild.name} (${guildId})`, req.authUser.username, req.authUser.username)
      res.json({ success: true, guild: guildId })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/servers/:guildId/toggles', requireAuth, (req, res) => {
    const { guildId } = req.params
    const cmdList = commandsMap ? [...commandsMap.values()].filter(c => c.category !== 'owner') : []
    const cmdNames = cmdList.map(c => c.name)
    db.all(`SELECT command_name, enabled FROM command_toggles WHERE guild_id=?`,
      [guildId], (err, rows) => {
        const toggleMap = {}
        rows.forEach(r => { toggleMap[r.command_name] = !!r.enabled })
        const cmdLookup = {}
        cmdList.forEach(c => { cmdLookup[c.name] = c })
        const toggles = cmdNames.map(name => ({
          name,
          description: cmdLookup[name]?.description || '',
          category: cmdLookup[name]?.category || '',
          aliases: cmdLookup[name]?.aliases || [],
          enabled: toggleMap[name] !== undefined ? toggleMap[name] : true
        }))
        res.json({ toggles })
      })
  })

  app.post('/api/servers/:guildId/toggles', requireAuth, (req, res) => {
    const { guildId } = req.params
    const { commandName, enabled } = req.body
    if (!commandName) return res.status(400).json({ error: 'commandName required' })
    db.run(`INSERT OR REPLACE INTO command_toggles (guild_id, command_name, enabled) VALUES (?, ?, ?)`,
      [guildId, commandName, enabled ? 1 : 0])
    audit('toggle', `Toggled ${commandName}: ${enabled ? 'ON' : 'OFF'} for guild ${guildId}`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.get('/api/commands', requireAuth, (req, res) => {
    const cmdList = commandsMap ? [...commandsMap.values()].map(c => ({
      name: c.name,
      description: c.description,
      category: c.category,
      aliases: c.aliases || []
    })) : []
    res.json({ commands: cmdList })
  })

  app.get('/api/command-categories', requireAuth, (req, res) => {
    const cats = new Set()
    if (commandsMap) {
      for (const cmd of commandsMap.values()) {
        if (cmd.category && cmd.category !== 'owner') cats.add(cmd.category)
      }
    }
    res.json({ categories: [...cats].sort() })
  })

  app.get('/api/metrics', requireAuth, (req, res) => {
    const range = req.query.range || 'hour'
    const now = Math.floor(Date.now() / 1000)
    let since, bucketSize
    switch (range) {
      case 'hour': since = now - 3600; bucketSize = 30; break
      case 'day': since = now - 86400; bucketSize = 300; break
      case 'week': since = now - 604800; bucketSize = 1800; break
      case 'month': since = now - 2592000; bucketSize = 7200; break
      case 'year': since = now - 31536000; bucketSize = 86400; break
      default: since = now - 3600; bucketSize = 30
    }
    db.all(`SELECT timestamp, ram_rss, ram_total, cpu_percent FROM metrics WHERE timestamp>=? ORDER BY timestamp`,
      [since], (err, rows) => {
        if (err || rows.length === 0) return res.json({ points: [] })
        const buckets = {}
        rows.forEach(r => {
          const bucket = Math.floor(r.timestamp / bucketSize) * bucketSize
          if (!buckets[bucket]) buckets[bucket] = { ramRss: 0, ramTotal: 0, cpu: 0, count: 0 }
          buckets[bucket].ramRss += r.ram_rss
          buckets[bucket].ramTotal += r.ram_total
          buckets[bucket].cpu += r.cpu_percent
          buckets[bucket].count++
        })
        const points = Object.entries(buckets).sort((a, b) => a[0] - b[0]).map(([ts, data]) => ({
          timestamp: parseInt(ts) * 1000,
          ramRss: data.ramRss / data.count,
          ramTotal: data.ramTotal / data.count,
          cpuPercent: data.cpu / data.count
        }))
        res.json({ points })
      })
  })

  app.post('/api/bot/stop', requireAuth, requireOwner, async (req, res) => {
    try {
      if (client?.user) await client.user.setPresence({ status: 'invisible', activities: [] })
      client.destroy()
      audit('bot_stop', 'Bot stopped', req.authUser.username, req.authUser.username)
      res.json({ success: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/bot/start', requireAuth, requireOwner, async (req, res) => {
    try {
      if (client?.isReady()) return res.json({ success: true, message: 'already running' })
      if (!process.env.TOKEN) return res.status(500).json({ error: 'No token configured' })
      client.login(process.env.TOKEN)
      audit('bot_start', 'Bot started', req.authUser.username, req.authUser.username)
      res.json({ success: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/bot/status', requireAuth, (req, res) => {
    res.json({
      running: client?.isReady() || false,
      username: client?.user?.username || null,
      uptime: client?.uptime || 0
    })
  })

  app.get('/api/prefix', requireAuth, (req, res) => {
    db.get(`SELECT value FROM settings WHERE key='prefix'`, (err, row) => {
      res.json({ prefix: row?.value || '!' })
    })
  })

  app.post('/api/prefix', requireAuth, requireOwner, (req, res) => {
    const { prefix } = req.body
    if (!prefix || prefix.length > 5) return res.status(400).json({ error: 'Prefix must be 1-5 characters' })
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('prefix', ?)`, [prefix])
    audit('prefix', `Prefix changed to: ${prefix}`, req.authUser.username, req.authUser.username)
    res.json({ success: true, prefix })
  })

  app.get('/api/settings', requireAuth, requireOwner, (req, res) => {
    db.all(`SELECT key, value FROM settings WHERE key NOT IN ('session_secret')`, (err, rows) => {
      const settings = {}
      rows.forEach(r => { settings[r.key] = r.value })
      res.json({ settings })
    })
  })

  app.post('/api/settings', requireAuth, requireOwner, (req, res) => {
    const { key, value } = req.body
    if (!key) return res.status(400).json({ error: 'key required' })
    if (key === 'session_secret') return res.status(403).json({ error: 'Cannot modify this setting' })
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value])
    audit('setting', `Setting ${key} changed`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.delete('/api/settings/:key', requireAuth, requireOwner, (req, res) => {
    const key = req.params.key
    if (key === 'session_secret') return res.status(403).json({ error: 'Cannot delete this setting' })
    db.run(`DELETE FROM settings WHERE key=?`, [key])
    audit('setting', `Setting ${key} deleted`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.get('/api/user/settings', requireAuth, (req, res) => {
    res.json({ settings: {} })
  })

  app.post('/api/bot/set-status', requireAuth, requireOwner, async (req, res) => {
    try {
      if (!client?.isReady()) return res.status(400).json({ error: 'Bot not running' })
      if (!botHelpers) return res.status(500).json({ error: 'Bot helpers not initialized' })
      const sc = botHelpers.statusConfig
      const { status, activityType, rotatingStatuses, staticStatus } = req.body
      const validStatuses = ['online', 'idle', 'dnd', 'invisible']
      const validActivities = ['rotating', 'random', 'none', 'static']
      if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' })
      if (activityType && !validActivities.includes(activityType)) return res.status(400).json({ error: 'Invalid activity type' })
      if (status) sc.status = status
      if (activityType) sc.activityType = activityType
      if (rotatingStatuses) sc.rotatingStatuses = rotatingStatuses
      if (staticStatus) sc.staticStatus = staticStatus
      botHelpers.saveRotatingStatuses()
      botHelpers.saveStaticStatus()
      botHelpers.run(`INSERT OR REPLACE INTO settings(key,value) VALUES('status_mode',?)`, [sc.activityType])
      if (sc.rotationInterval) { clearInterval(sc.rotationInterval); sc.rotationInterval = null }
      botHelpers.applyStatus()
      audit('set_status', `Presence updated: ${sc.status} / ${sc.activityType}`, req.authUser.username, req.authUser.username)
      res.json({ success: true, config: sc })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/bot/status-config', requireAuth, requireOwner, (req, res) => {
    if (!botHelpers) return res.status(500).json({ error: 'Not initialized' })
    res.json({ config: botHelpers.statusConfig })
  })

  app.post('/api/admin/statsmodify', requireAuth, requireOwner, (req, res) => {
    const { field, username, amount } = req.body
    if (!field || !username || amount === undefined)
      return res.status(400).json({ error: 'field, username, and amount required' })
    const validFields = ['cash', 'level', 'bank']
    if (!validFields.includes(field)) return res.status(400).json({ error: 'Valid fields: cash, level, bank' })
    const colMap = { cash: 'wallet', level: 'level', bank: 'bank' }
    const col = colMap[field]
    db.get(`SELECT discord_id FROM web_users WHERE username = ?`, [username], (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' })
      if (!row || !row.discord_id) return res.status(404).json({ error: 'User not found' })
      const discordId = row.discord_id
      db.run(`UPDATE users SET ${col}=? WHERE id = ?`, [parseInt(amount), discordId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed' })
        audit('statsmodify', `Modified ${field} for ${username} to ${amount}`, req.authUser.username, req.authUser.username)
        res.json({ success: true, field, username, amount: parseInt(amount) })
      })
    })
  })

  app.get('/api/servers/all', requireAuth, requireOwner, (req, res) => {
    const guilds = client.guilds.cache.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ size: 64 }),
      memberCount: g.memberCount,
      ownerId: g.ownerId,
      createdTimestamp: g.createdTimestamp
    }))
    res.json({ servers: guilds, total: guilds.length })
  })

  app.get('/api/audit-log', requireAuth, requireOwner, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage) || 25))
    db.get(`SELECT COUNT(*) as total FROM audit_log`, (err, countRow) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch audit log' })
      const total = countRow.total
      const totalPages = Math.ceil(total / perPage)
      const offset = (page - 1) * perPage
      db.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`, [perPage, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch audit log' })
        res.json({ entries: rows, total, page, perPage, totalPages })
      })
    })
  })

  app.post('/api/feedback', requireAuth, (req, res) => {
    const { message, category } = req.body
    if (!message || message.length < 3) return res.status(400).json({ error: 'Message must be at least 3 characters' })
    db.run(`INSERT INTO feedback (message, username, user_id, category) VALUES (?, ?, ?, ?)`,
      [message, req.authUser.username, req.authUser.username, category || 'general'])
    audit('feedback', `Feedback submitted: ${message.slice(0, 50)}...`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.get('/api/feedback', requireAuth, requireOwner, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.perPage) || 20))
    db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as openCount FROM feedback`, (err, countRow) => {
      if (err) return res.status(500).json({ error: 'Failed' })
      const total = countRow.total
      const openCount = countRow.openCount || 0
      const totalPages = Math.ceil(total / perPage)
      const offset = (page - 1) * perPage
      db.all(`SELECT * FROM feedback ORDER BY id DESC LIMIT ? OFFSET ?`, [perPage, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed' })
        res.json({ feedback: rows, total, openCount, page, perPage, totalPages })
      })
    })
  })

  app.post('/api/feedback/:id/status', requireAuth, requireOwner, (req, res) => {
    const { status } = req.body
    const valid = ['open', 'acknowledged', 'resolved']
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    db.run(`UPDATE feedback SET status=? WHERE id=?`, [status, req.params.id])
    res.json({ success: true })
  })

  app.get('/api/bot-stats', requireAuth, requireOwner, (req, res) => {
    const stats = {}
    db.get(`SELECT COUNT(*) as total FROM users`, (err, row) => { stats.users = row?.total || 0 })
    db.get(`SELECT COUNT(*) as total FROM command_stats`, (err, row) => { stats.commandsExecuted = row?.total || 0 })
    db.get(`SELECT COUNT(*) as total FROM audit_log`, (err, row) => { stats.auditEntries = row?.total || 0 })
    db.get(`SELECT COUNT(*) as total FROM feedback WHERE status='open'`, (err, row) => { stats.openFeedback = row?.total || 0 })
    db.get(`SELECT COUNT(DISTINCT guild_id) as total FROM server_links`, (err, row) => { stats.linkedServers = row?.total || 0 })
    db.get(`SELECT COUNT(*) as total FROM web_users`, (err, row) => { stats.webUsers = row?.total || 0 })
    db.all(`SELECT command_name, COUNT(*) as count FROM command_stats GROUP BY command_name ORDER BY count DESC LIMIT 10`,
      (err, rows) => { stats.topCommands = rows || [] })
    setTimeout(() => {
      stats.guilds = client?.guilds?.cache?.size || 0
      stats.totalMembers = client?.guilds?.cache?.reduce((s, g) => s + g.memberCount, 0) || 0
      res.json(stats)
    }, 100)
  })

  app.delete('/api/tokens', requireAuth, (req, res) => {
    const token = extractToken(req)
    db.run(`DELETE FROM auth_tokens WHERE token=?`, [token])
    res.json({ success: true })
  })

  // Server Variables API
  app.get('/api/servers/:id/vars', requireAuth, (req, res) => {
    db.all(`SELECT key, value FROM server_vars WHERE server_id=?`, [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed' })
      const vars = {}
      rows.forEach(r => { vars[r.key] = r.value })
      res.json({ vars })
    })
  })

  app.post('/api/servers/:id/vars', requireAuth, (req, res) => {
    const { key, value } = req.body
    if (!key) return res.status(400).json({ error: 'key required' })
    db.run(`INSERT OR REPLACE INTO server_vars (server_id, key, value) VALUES (?, ?, ?)`, [req.params.id, key, value])
    audit('var', `Var ${key} set for server ${req.params.id}`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.delete('/api/servers/:id/vars/:key', requireAuth, (req, res) => {
    db.run(`DELETE FROM server_vars WHERE server_id=? AND key=?`, [req.params.id, req.params.key])
    audit('var', `Var ${req.params.key} deleted for server ${req.params.id}`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  // Custom Commands API
  app.get('/api/custom-cmds', requireAuth, (req, res) => {
    db.all(`SELECT * FROM custom_cmds ORDER BY created_at DESC`, (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed' })
      res.json({ commands: rows || [] })
    })
  })

  app.post('/api/custom-cmds', requireAuth, (req, res) => {
    const { name, server_id, script, description, category, suppress_errors } = req.body
    if (!name || !script) return res.status(400).json({ error: 'name and script required' })
    db.run(`INSERT INTO custom_cmds (name, server_id, script, description, category, suppress_errors) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, server_id || '*', script, description || '', category || 'general', suppress_errors ? 1 : 0])
    audit('custom_cmd', `Custom command ${name} created`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.put('/api/custom-cmds/:id', requireAuth, (req, res) => {
    const { name, server_id, script, description, category, suppress_errors } = req.body
    if (!name || !script) return res.status(400).json({ error: 'name and script required' })
    db.run(`UPDATE custom_cmds SET name=?, server_id=?, script=?, description=?, category=?, suppress_errors=? WHERE id=?`,
      [name, server_id || '*', script, description || '', category || 'general', suppress_errors ? 1 : 0, req.params.id])
    audit('custom_cmd', `Custom command ${name} updated`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.delete('/api/custom-cmds/:id', requireAuth, (req, res) => {
    db.run(`DELETE FROM custom_cmds WHERE id=?`, [req.params.id])
    audit('custom_cmd', `Custom command ${req.params.id} deleted`, req.authUser.username, req.authUser.username)
    res.json({ success: true })
  })

  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' })
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  })

  app.listen(PORT, () => {
    console.log(`Web dashboard: http://localhost:${PORT}`)
  })
}

module.exports = { init, collectMetrics, audit }
