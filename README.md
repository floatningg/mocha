# Mochabot

A high-performance Discord bot with an integrated web dashboard for economy management, server administration, analytics, and runtime configuration.

Mochabot combines a feature-rich Discord bot with a browser-based management interface, allowing administrators to configure the bot, manage server-specific settings, monitor performance, and update runtime behavior without restarting the application.

---

## Features

### Economy

* Wallet and bank accounts
* Daily rewards
* Work and earning commands
* Gambling system
* XP and leveling
* Leaderboards
* User statistics
* Administrative economy controls

### Web Dashboard

* Secure account registration and authentication
* Discord server pairing
* Server-specific configuration
* Live bot management
* Command enable/disable controls
* Runtime settings editor
* Feedback system
* Audit log
* Server variables
* Custom command editor
* User statistics management

### Bot Management

* Live status updates
* Static, rotating, and random activities
* Presence management
* Runtime configuration changes
* Command statistics
* Server overview
* Performance monitoring

### Analytics

* CPU usage
* Memory usage
* Uptime
* Command usage statistics
* Historical metrics
* Server information

### Custom Commands

Create and manage custom commands directly from the dashboard.

Features include:

* Custom scripting
* User variables
* Server variables
* Economy integration
* Runtime editing

---

## Architecture

The project consists of two primary components:

* **Discord Bot** — Handles Discord interactions, economy, commands, and server events.
* **Web Dashboard** — Provides browser-based management and monitoring of the bot.

Configuration changes made through the dashboard are applied without requiring the bot to restart whenever possible.

---

## Technology Stack

* Node.js
* discord.js v14
* SQLite
* HTML
* CSS
* Vanilla JavaScript

---

## Installation

### Requirements

* Node.js 20 or newer
* npm
* Discord Application and Bot Token

### Clone the repository

```bash
git clone https://github.com/<username>/mochabot.git
cd mochabot
```

### Install dependencies

```bash
npm install
```

### Configure environment variables

Create a `.env` file in the project root.

```env
TOKEN=YOUR_DISCORD_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_ID
OWNER_ID=YOUR_DISCORD_USER_ID
```

Additional configuration values may be required depending on your deployment.

### Start the application

```bash
node bot.js
```

By default, the dashboard is available on the configured web server port.

---

## Dashboard Capabilities

The dashboard provides access to:

* User authentication
* Server pairing
* Server management
* Runtime settings
* Command toggles
* Status configuration
* Analytics
* Feedback management
* Audit history
* Server variables
* Custom commands
* Economy administration

---

## Project Structure

```
.
├── bot.js
├── dashboard/
├── database/
├── commands/
├── events/
├── config/
├── assets/
└── README.md
```

The exact structure may vary as the project evolves.

---

## Security

Sensitive configuration values should never be committed to version control.

Recommended practices include:

* Store secrets in environment variables.
* Restrict dashboard access to trusted users.
* Regularly back up the database.
* Keep dependencies up to date.
* Run the bot using a dedicated service account.

---

## Roadmap

Planned improvements include:

* Plugin architecture
* Public REST API
* WebSocket-based live updates
* Theme customization
* Localization
* Database abstraction
* Improved permission system
* Automated backups
* Additional moderation features

---

## Contributing

Contributions are welcome.

If you would like to contribute:

1. Fork the repository.
2. Create a feature branch.
3. Commit your changes.
4. Open a pull request.

Please keep changes focused and include clear descriptions of any new functionality.

---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
