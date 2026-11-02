# WhatsApp Ticket Bot

The bot monitors WhatsApp groups and turns `/raise` reports into email tickets. The multi-account Docker setup runs one isolated bot process per WhatsApp number, with its own linked-device session, groups, recipient, logs, and ticket CSV.

## Multi-account Docker setup

Requirements: Docker Engine with Docker Compose, three WhatsApp accounts, and shared SMTP/AI settings.

1. Copy the shared configuration and account templates:

   ```sh
   cp .env.example .env
   mkdir -p .env.accounts
   cp .env.accounts/support.env.example .env.accounts/support.env
   cp .env.accounts/govt-support.env.example .env.accounts/govt-support.env
   cp .env.accounts/enterprise.env.example .env.accounts/enterprise.env
   ```

2. Put the shared AI endpoint and SMTP sender credentials in `.env`. In each account file, replace the `WHATSAPP_GROUPS` placeholder with the exact group names for that number. The matching `MAIL_TO` values are already set in the examples. Account env files and credentials are ignored by Git.

3. Validate and start the services:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

4. Link each account separately. Follow one service’s logs at a time, then scan its QR code in WhatsApp → **Linked Devices** → **Link a Device**:

   ```sh
   docker compose logs -f whatsapp-bot-support
   docker compose logs -f whatsapp-bot-govt-support
   docker compose logs -f whatsapp-bot-enterprise
   ```

Each service uses a separate persistent Docker volume for its WhatsApp session and browser cache, plus a unique health port (3001–3003). The existing top-level `wa-session/session` is left untouched; all three new instances will request fresh QR logins. The host network is retained so containers can reach an AI service configured on the host’s `localhost`.

Restart or inspect an individual account without interrupting the others:

```sh
docker compose restart whatsapp-bot-support
docker compose logs -f whatsapp-bot-support
```

## Raise a ticket

- Reply to the issue message with `/raise`.
- Add a note with `/raise <describe the issue>` while replying.
- Or send `/raise <issue description>` directly in a monitored group.
- You can also edit a message to begin with `/raise`.

Each instance only monitors the groups configured in its account env file. Its tickets go to that file’s `MAIL_TO` recipient. AI summarizes text and chat context; it does not inspect image contents. Downloaded WhatsApp media is attached to the email when available.

## Ticket history and logs

- The shared `ticket-data/` directory stores `tickets-support.csv`, `tickets-govt-support.csv`, and `tickets-enterprise.csv` separately.
- The `ticket-viewer` service combines those files and the legacy `tickets.csv`. Open `http://localhost:3000` on the Docker host.
- Structured logs are written to the shared `bot-logs` Docker volume with each bot’s instance ID in the filename and each JSON log entry. Use `docker compose logs` to inspect container output.
- Use `docker compose ps` to see readiness. Health checks use the port configured for each account.

## Local single-account development

For one account outside Docker, install dependencies and configure `.env` with `WHATSAPP_GROUPS` and `MAIL_TO`, then run:

```sh
npm install
npm start
```

The Compose setup is the recommended deployment for multiple WhatsApp accounts.
