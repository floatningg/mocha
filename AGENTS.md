# AGENTS.md

## Project Overview
Mochabot - Discord economy bot with web dashboard. Single-file bot.js (3000+ lines) + server.js (750 lines) + myntax.js (custom scripting language) + public/index.html (SPA dashboard).

## Key Files
- `bot.js` - Main entry point, Discord bot logic, command handlers, economy system
- `server.js` - Express web server, API endpoints, auth, dashboard routes
- `myntax.js` - Custom scripting language parser/evaluator for custom commands
- `public/index.html` - Single-page dashboard (HTML/CSS/JS all inline)

## Commands
```bash
node bot.js          # Start the bot (also starts web dashboard)
npm install          # Install dependencies
```

## Environment
- `.env` required with: `TOKEN`, `CLIENT_ID`, `OWNER_ID`, `ADMIN_PASSWORD`, `WEB_PORT`
- SQLite database: `economy.db` (auto-created)

## Architecture Notes
- No build step - vanilla JS, runs directly with Node.js
- Bot and web server run in same process
- Dashboard served as static files from `public/`
- Custom commands use Myntax scripting language (see myntax.js)
- No test suite, no lint/typecheck configured

## Common Tasks
- Edit dashboard: modify `public/index.html` (all-in-one file)
- Add bot commands: edit `bot.js` command handlers
- Modify Myntax syntax: edit `myntax.js`
- API endpoints: edit `server.js`

## Git
- Standard git workflow
- `.env` is gitignored
- `node_modules/`, `economy.db` ignored