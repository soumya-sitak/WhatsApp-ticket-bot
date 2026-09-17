# WhatsApp Ticket Bot 🎟️

**Production-grade WhatsApp group monitoring bot** that creates support tickets via email when team members raise issues with `/raise` command.

## Features

✅ **Multi-group monitoring** - Monitor multiple WhatsApp groups  
✅ **AI-powered summaries** - Auto-generate ticket subjects & summaries  
✅ **Email routing** - Send to multiple recipients with CC/BCC  
✅ **Persistent logging** - Structured logs with file rotation  
✅ **Graceful shutdown** - Clean resource cleanup  
✅ **Auto-restart** - PM2 process manager integration  
✅ **Retry logic** - Exponential backoff for API calls  
✅ **Production-ready** - Security, error handling, monitoring  

---

## Quick Start

### Prerequisites
- Node.js 16+
- npm or yarn
- Gmail account with app password
- OmniRoute/Ollama (for AI, optional)

### Installation

```bash
# Clone/Setup
cd whatsapp-ticket-bot

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your values
```

### First Run (Scan QR Code)

```bash
npm run start
```

Scan the QR code with WhatsApp on your phone (Linked Devices).

### Production Deployment

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start pm2.config.js --env production

# Auto-start on reboot
pm2 startup
pm2 save

# Monitor
pm2 monit
pm2 logs
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
# WhatsApp Groups (comma-separated)
GROUPS=test,engineering,ops-alerts

# Gmail SMTP
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-app-password
MAIL_TO=team@example.com
MAIL_CC=manager@example.com

# AI Summarization (Optional)
AI_ENABLED=true
AI_BASE_URL=http://localhost:20128/v1
AI_MODEL=omni
AI_API_KEY=sk-xxx

# Logging
LOG_LEVEL=info
LOG_DIR=./logs
```

[Full config options in `.env.example`]

---

## Usage

### Raising a Ticket

1. In a monitored WhatsApp group, someone reports an issue:
   > "RCS delivery failing on Airtel network since 2pm"

2. Any team member replies to that message with:
   > `/raise` or `/raise P1 urgent`

3. Bot automatically:
   - Extracts the quoted issue message
   - Gathers previous 4 messages for context
   - Generates AI ticket summary
   - Sends formatted email to team
   - Confirms in WhatsApp: `🎟️ Ticket Raised & Dispatched!`

---

## Commands

- `/raise` - Create ticket from quoted message
- `/ticket` - Alias for `/raise`
- `!raise` - Alternative prefix
- `!ticket` - Alternative prefix

---

## Monitoring

### View Logs

```bash
# Live logs
pm2 logs whatsapp-ticket-bot

# Last 100 lines
pm2 logs whatsapp-ticket-bot --lines 100

# Errors only
pm2 logs whatsapp-ticket-bot --err
```

### Monitor Resources

```bash
pm2 monit
```

### Check Status

```bash
pm2 status
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot crashes on startup | Check `.env` - verify all required vars are set |
| QR code not appearing | Ensure WhatsApp Web is accessible; check logs |
| Emails not sending | Verify Gmail app password in `.env`; check firewall |
| AI summarization failing | Ensure OmniRoute is running or set `AI_ENABLED=false` |
| WhatsApp session invalid | Delete `wa-session/` folder and rescan QR code |

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete troubleshooting guide.

---

## Project Structure

```
whatsapp-ticket-bot/
├── whatsapp-mail-bridge.js    # Main bot (production version)
├── pm2.config.js              # PM2 process manager config
├── package.json               # Dependencies & scripts
├── .env.example               # Environment template
├── .gitignore                 # Git ignore rules
├── DEPLOYMENT.md              # Deployment guide
├── README.md                  # This file
├── src/
│   └── logger.js              # Structured logging module
├── logs/                      # Log files (git ignored)
├── wa-session/                # WhatsApp session (git ignored)
└── node_modules/              # Dependencies (git ignored)
```

---

## Environment Variables

### Required
- `MAIL_USER` - Gmail address
- `MAIL_PASS` - Gmail app password
- `MAIL_TO` - Recipients (comma-separated)
- `GROUPS` - WhatsApp groups to monitor (comma-separated)

### Optional
- `NODE_ENV` - `development` or `production`
- `MAIL_CC` - CC recipients
- `MAIL_BCC` - BCC recipients
- `AI_ENABLED` - Enable/disable AI summaries (default: true)
- `LOG_LEVEL` - DEBUG, INFO, WARN, ERROR (default: info)
- `CONTEXT_MESSAGES` - Previous messages for context (default: 4)
- `MAX_RETRIES` - Retry attempts for API calls (default: 3)
- `RETRY_DELAY_MS` - Initial retry delay in ms (default: 1000)

---

## Logs

Logs are written to `./logs/` directory:

```
logs/
├── bot-2026-09-17.log        # Daily bot logs
├── pm2-out.log               # PM2 stdout
└── pm2-error.log             # PM2 stderr
```

Each log entry is JSON formatted:
```json
{
  "timestamp": "2026-09-17T10:00:01.314Z",
  "level": "INFO",
  "message": "Ticket created successfully",
  "groupName": "engineering",
  "ticketId": "WA-12345"
}
```

---

## Production Checklist

- [ ] `.env` configured with all credentials
- [ ] `.env` added to `.gitignore`
- [ ] QR code scanned and session saved
- [ ] Test `/raise` in WhatsApp group
- [ ] Verify email received
- [ ] PM2 running: `pm2 status`
- [ ] Logs being written: `pm2 logs`
- [ ] Auto-start configured: `pm2 startup && pm2 save`
- [ ] Firewall allows outbound SMTP (port 465)
- [ ] Sufficient disk space for logs

---

## Development

### Scripts

```bash
npm run start          # Run bot (for QR code scanning)
npm run dev            # Run bot in development mode
pm2 start pm2.config.js  # Production with PM2
pm2 stop whatsapp-ticket-bot
pm2 restart whatsapp-ticket-bot
pm2 logs whatsapp-ticket-bot
```

### Local Testing

```bash
# Scan QR code
npm run start

# In another terminal, send test message with /raise

# View logs
tail -f logs/bot-*.log
```

---

## Security

- 🔒 Credentials stored in `.env` (git ignored)
- 🔒 Sensitive data sanitized in logs
- 🔒 No passwords/API keys in source code
- 🔒 Session file protected (git ignored)
- 🔒 Input validation on all external data

---

## Support & Issues

1. Check [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed troubleshooting
2. View logs: `pm2 logs whatsapp-ticket-bot`
3. Verify `.env` configuration
4. Check network/firewall settings

---

## License

MIT

---

**Made for team productivity** 🚀
