# Production Deployment Guide

## Prerequisites
- Node.js 16+ installed
- npm or yarn
- PM2 installed globally: `npm install -g pm2`
- Gmail app password (or SMTP credentials)
- OmniRoute/Ollama running for AI summaries (or disabled in `.env`)

---

## Step 1: Setup Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```
NODE_ENV=production
GROUPS=test,engineering,ops-alerts
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-gmail-app-password
MAIL_TO=team@example.com
MAIL_CC=manager@example.com
AI_API_KEY=your-key
```

**Security Note**: Never commit `.env` to git. Add to `.gitignore`:
```
.env
logs/
wa-session/
node_modules/
```

---

## Step 2: Install Dependencies

```bash
npm install
```

This installs:
- `whatsapp-web.js` - WhatsApp client
- `nodemailer` - Email sending
- `dotenv` - Environment variable loading
- `qrcode-terminal` - QR code display
- PM2 (global) - Process manager

---

## Step 3: Initial QR Code Scan

```bash
npm run start
```

Or directly:
```bash
node whatsapp-mail-bridge.js
```

**Action Required**: Scan the QR code with WhatsApp on your phone (Linked Devices).

After successful scan, session is saved in `wa-session/` directory.

**Ctrl+C** to stop after scanning.

---

## Step 4: Start with PM2 (Production)

```bash
pm2 start pm2.config.js --env production
```

Verify it's running:
```bash
pm2 status
pm2 logs whatsapp-ticket-bot
```

---

## Step 5: Setup Auto-Start on Server Reboot

### On Linux (systemd):
```bash
pm2 startup systemd -u $(whoami) --hp /home/$(whoami)
pm2 save
```

### On Windows (Task Scheduler):
```powershell
pm2 install pm2-windows-startup
pm2 save
```

---

## Monitoring & Maintenance

### View Logs
```bash
pm2 logs whatsapp-ticket-bot
pm2 logs whatsapp-ticket-bot --lines 100  # Last 100 lines
pm2 logs whatsapp-ticket-bot --err        # Errors only
```

### Monitor Resources
```bash
pm2 monit
```

### Restart Bot
```bash
pm2 restart whatsapp-ticket-bot
```

### Stop Bot (Graceful)
```bash
pm2 stop whatsapp-ticket-bot
```

### Reload Bot (Zero-downtime)
```bash
pm2 reload whatsapp-ticket-bot
```

---

## Troubleshooting

### Bot crashes immediately
- Check logs: `pm2 logs whatsapp-ticket-bot`
- Verify `.env` file has all required variables
- Verify `wa-session/` directory is writable

### "Module not found" errors
```bash
npm install  # Re-install dependencies
```

### WhatsApp session invalid
```bash
rm -rf wa-session/
npm run start  # Scan QR code again
```

### Email not sending
- Check SMTP credentials in `.env`
- Verify Gmail app password (not regular password)
- Check firewall allows outbound port 465

### AI summarization failing
- Verify OmniRoute is running: `omniroute`
- Check AI_BASE_URL is correct
- Set `AI_ENABLED=false` to disable and use fallback

---

## Performance Tuning

### Increase Memory Limit (in pm2.config.js)
```javascript
max_memory_restart: '1G',  // From 500M
```

### Enable Cluster Mode (multiple instances)
```javascript
instances: 4,      // Or 'max' for all CPU cores
exec_mode: 'cluster',
```

---

## Backup & Recovery

### Backup Session
```bash
tar -czf wa-session-backup.tar.gz wa-session/
```

### Backup Logs
```bash
tar -czf logs-backup.tar.gz logs/
```

---

## Production Checklist

- [ ] `.env` configured with all credentials
- [ ] `.env` added to `.gitignore`
- [ ] QR code scanned and session saved
- [ ] PM2 running: `pm2 status`
- [ ] Logs being written: `pm2 logs`
- [ ] Test `/raise` command in WhatsApp group
- [ ] Verify email received
- [ ] PM2 set to auto-start: `pm2 startup`
- [ ] Firewall allows outbound SMTP (port 465)
- [ ] Sufficient disk space for logs

---

## Scaling

For high-volume deployments:

1. **Add multiple instances** (cluster mode in `pm2.config.js`)
2. **Use Redis** for session sharing between instances
3. **Add load balancer** for multiple servers
4. **Monitor with PM2+**: `pm2 plus` (premium)

---

## Support & Logs Location

- **Logs**: `./logs/bot-YYYY-MM-DD.log`
- **PM2 Logs**: `./logs/pm2-out.log` and `pm2-error.log`
- **Session**: `./wa-session/`
- **Config**: `./.env`

For debugging, set `LOG_LEVEL=debug` in `.env`.
