# WhatsApp Ticket Bot 🎟️

A professional WhatsApp group monitoring bot that automatically converts issue reports into support tickets via email.

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js 16+** installed.
- **Ollama** installed and running locally (for AI summaries).
- **Gmail Account** with an [App Password](https://support.google.com/accounts/answer/185833?hl=en) (standard passwords won't work).

### 2. Installation
```bash
# Clone the repository and enter the folder
cd whatsapp-ticket-bot

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
```

### 3. Configuration
Open the `.env` file and fill in your details:
- **WhatsApp**: Add the names of the groups you want to monitor in `WHATSAPP_GROUPS` (comma-separated).
- **Email**: Enter your Gmail address and the **App Password**.
- **AI**: Ensure `AI_ENABLED=true` and `AI_BASE_URL` points to your local Ollama/OmniRoute instance (e.g., `http://localhost:20128/v1`).

### 4. First Run (Scan QR Code)
```bash
npm start
```
1. A **QR code** will appear in your terminal.
2. Open WhatsApp on your phone $\rightarrow$ **Linked Devices** $\rightarrow$ **Link a Device**.
3. Scan the code. The bot is now active!

### 5. Production Deployment (Optional)
To keep the bot running in the background forever:
```bash
npm install -g pm2
pm2 start pm2.config.js --env production
pm2 startup
pm2 save
```

---

## 🛠 How to Use

Once the bot is running, you can raise tickets in any monitored group using these methods:

### Method A: Reply to a Message (Recommended)
- Find a message describing an issue $\rightarrow$ **Reply** to it with `/raise`.
- The bot captures the original issue, the reporter's name, and the conversation context.

### Method B: Direct Command
- Type `/raise <describe your issue here>` directly in the group.
- Example: `/raise Server is lagging since 10 AM`.

### Method C: Edit a Message
- If you forgot to add `/raise`, simply **edit** your message to start with `/raise`. The bot will detect the edit and create the ticket.

---

## ⚙️ Technical Details

### Project Structure
```text
src/
├── bot.js            # Main entry point & event coordinator
├── config.js         # Environment & Prompt configuration
├── logger.js         # Structured JSON logging
├── utils/
│   └── wa-utils.js   # WhatsApp data helpers
└── services/
    ├── ai.service.js    # AI summarization logic
    ├── mail.service.js # Email dispatch & templates
    ├── csv.service.js   # Ticket logging to CSV
    └── wa.service.js    # WhatsApp Client wrapper
```

### Monitoring & Logs
- **Live Logs**: `pm2 logs whatsapp-ticket-bot`
- **Resource Monitor**: `pm2 monit`
- **Daily Logs**: Check the `./logs/` folder for daily JSON log files.

---

## 🆘 Troubleshooting
- **QR Code not appearing?** Check your internet connection and logs.
- **Emails not sending?** Verify your Gmail App Password and firewall settings.
- **AI failing?** Ensure your local AI model is running and accessible at the `AI_BASE_URL`.
- **Session expired?** Delete the `wa-session/` folder and run `npm start` to rescan.

**Made for team productivity** 🚀
