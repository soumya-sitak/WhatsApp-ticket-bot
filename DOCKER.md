# Docker Deployment Guide 🐳

This guide covers containerizing and running the WhatsApp Ticket Bot using Docker.

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- `.env` file configured (see Setup below)

---

## Understanding Environment Variables

### Important: How .env Files Work with Docker

**The `.env` file is NOT copied into the Docker image.** Here's what happens:

#### Build Time (docker-compose build)
- The `.env` file is **excluded** from the image via `.dockerignore`
- Your secrets (passwords, API keys) never get baked into the image
- Only your code and dependencies are included
- ✅ This is secure - images can be shared without exposing secrets

#### Runtime (docker-compose up)
- Docker Compose **reads `.env` from your host filesystem**
- Variables are injected as environment variables into the container
- Your app accesses them via `process.env.VARIABLE_NAME`
- The `.env` file must exist in the same directory as `docker-compose.yml`

#### Visual Flow
```
Host Machine                          Docker Container
├── .env (stays here!)                ├── No .env file inside
│   MAIL_PASS=secret123               │   
│   AI_API_KEY=sk-xyz                 │   Environment Variables:
│   AI_BASE_URL=localhost             │   - MAIL_PASS=secret123
│                                     │   - AI_API_KEY=sk-xyz
│                                     │   - AI_BASE_URL=localhost
│                                     │
└── docker-compose.yml                └── App reads process.env.*
    ↓
    Reads .env at startup
    Injects vars into container ─────→
```

#### Key Points

✅ **`.env` location**: Must be at `/path/to/project/.env` on your host  
✅ **Security**: Secrets stay on host, never in the image  
✅ **Updates**: Edit `.env` then run `docker-compose restart` (no rebuild needed)  
✅ **Git**: `.env` is ignored by `.gitignore` - never commit it  
✅ **Verification**: Use `docker-compose exec whatsapp-bot env | grep MAIL_USER` to check

---

## Quick Start

### 1. Setup Environment

```bash
# Copy environment template (or use your existing .env)
cp .env.docker .env

# Edit .env with your credentials
nano .env
```

### 2. Choose Your Setup

#### Option A: OmniRoute on Host (Recommended - Default)

Your current `.env` has `AI_BASE_URL=http://localhost:20128/v1`, which means OmniRoute is running directly on your host machine.

```bash
# Build the image
docker-compose build

# Start with host network mode (can access localhost:20128)
docker-compose up -d

# View logs (watch for QR code on first run)
docker-compose logs -f
```

The default `docker-compose.yml` uses `network_mode: "host"` so the container can reach `localhost:20128`.

#### Option B: OmniRoute in Separate Container

If you want OmniRoute also in Docker:

```bash
# Use the full stack compose file
docker-compose -f docker-compose.omniroute.yml up -d

# View logs
docker-compose -f docker-compose.omniroute.yml logs -f
```

#### Option C: Bridge Network with host.docker.internal

If you prefer isolated networking but OmniRoute is on host:

```bash
# Update .env to use host.docker.internal
sed -i 's|localhost|host.docker.internal|g' .env

# Use bridge network setup
docker-compose -f docker-compose.bridge.yml up -d

# View logs
docker-compose -f docker-compose.bridge.yml logs -f
```

### 3. Scan QR Code (First Run)

```bash
# Watch logs for QR code
docker-compose logs -f whatsapp-bot

# Scan the QR code with WhatsApp > Linked Devices
# Session will be saved to ./wa-session/
```

### 4. Verify Running

```bash
# Check container status
docker-compose ps

# View logs
docker-compose logs --tail=50 whatsapp-bot

# Verify environment variables are loaded
docker-compose exec whatsapp-bot env | grep MAIL_USER
docker-compose exec whatsapp-bot env | grep AI_BASE_URL

# Check health
docker-compose exec whatsapp-bot node -e "console.log('Bot is running')"
```

---

## Docker Commands

### Container Management

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# Stop and remove volumes (fresh start)
docker-compose down -v

# View logs
docker-compose logs -f

# Execute commands in container
docker-compose exec whatsapp-bot /bin/bash
```

### Building

```bash
# Build image
docker-compose build

# Build without cache
docker-compose build --no-cache

# Pull latest base image and rebuild
docker-compose build --pull
```

### Debugging

```bash
# View container logs
docker-compose logs --tail=100 -f whatsapp-bot

# Check container status
docker-compose ps

# Inspect container
docker-compose exec whatsapp-bot ps aux

# Check disk usage
docker-compose exec whatsapp-bot df -h

# View environment variables
docker-compose exec whatsapp-bot env
```

---

## Volume Management

The bot uses persistent volumes for:

- **wa-session/** - WhatsApp authentication session
- **logs/** - Application logs
- **.wwebjs_cache/** - WhatsApp Web cache
- **.wwebjs_auth/** - WhatsApp authentication data

### Backup Session

```bash
# Backup WhatsApp session
tar -czf wa-session-backup-$(date +%Y%m%d).tar.gz wa-session/

# Restore session
tar -xzf wa-session-backup-YYYYMMDD.tar.gz
```

### Reset Session

```bash
# Stop container
docker-compose down

# Remove session data
rm -rf wa-session/ .wwebjs_cache/ .wwebjs_auth/

# Start fresh
docker-compose up -d

# Scan new QR code
docker-compose logs -f
```

---

## Production Deployment

### 1. Using Docker Compose (Recommended)

```bash
# Production docker-compose
docker-compose -f docker-compose.yml up -d

# Enable auto-restart
docker-compose up -d --restart unless-stopped
```

### 2. Using Docker Run

```bash
# Build image
docker build -t whatsapp-ticket-bot:latest .

# Run container
docker run -d \
  --name whatsapp-ticket-bot \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/wa-session:/app/wa-session \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/.wwebjs_cache:/app/.wwebjs_cache \
  -v $(pwd)/.wwebjs_auth:/app/.wwebjs_auth \
  -p 3000:3000 \
  whatsapp-ticket-bot:latest
```

### 3. Using Docker Swarm

```bash
# Initialize swarm
docker swarm init

# Create secret for .env
docker secret create whatsapp_env .env

# Deploy stack
docker stack deploy -c docker-compose.yml whatsapp-bot

# Check services
docker service ls
docker service logs whatsapp-bot_whatsapp-bot
```

---

## Managing Environment Variables

### How to Update Variables

```bash
# 1. Edit .env on your host machine
nano .env

# 2. Restart the container (NO rebuild needed)
docker-compose restart

# 3. Verify changes took effect
docker-compose exec whatsapp-bot env | grep YOUR_VARIABLE
```

**Important**: Editing `.env` does NOT require rebuilding the image with `docker-compose build`. Just restart the container.

### Required Variables

```env
WHATSAPP_GROUPS=engineering,ops-alerts
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-app-password
MAIL_TO=team@example.com
```

### Optional Variables

```env
NODE_ENV=production
LOG_LEVEL=INFO
AI_ENABLED=true
AI_BASE_URL=http://localhost:20128/v1
BOT_CONTEXT_MESSAGES_COUNT=4
```

### Where Variables Are Used

| Variable | Read From | Used By | Location |
|----------|-----------|---------|----------|
| `MAIL_PASS` | Host `.env` | Container `process.env` | App at runtime |
| `AI_API_KEY` | Host `.env` | Container `process.env` | App at runtime |
| All others | Host `.env` | Container `process.env` | App at runtime |

**None of these are in the Docker image** - they're all injected at runtime.

### Docker-Specific Notes

**Three networking options are provided:**

1. **Host network mode** (default `docker-compose.yml`)
   - Container shares host network stack
   - Can directly access `localhost:20128`
   - Best when OmniRoute runs on host
   - Keep your `.env` as-is: `AI_BASE_URL=http://localhost:20128/v1`

2. **Bridge with host.docker.internal** (`docker-compose.bridge.yml`)
   - Container has isolated network
   - Uses special DNS name to reach host
   - Change `.env`: `AI_BASE_URL=http://host.docker.internal:20128/v1`

3. **Full container stack** (`docker-compose.omniroute.yml`)
   - Both WhatsApp bot and OmniRoute in Docker
   - Containers communicate via Docker network
   - Uses: `AI_BASE_URL=http://omniroute:20128/v1`

**Current setup**: Your `.env` has `localhost:20128`, so use the default `docker-compose.yml` with host network mode.

---

## Networking

### Access Host Services

```yaml
# In .env
AI_BASE_URL=http://host.docker.internal:20128/v1
```

### Link to Other Containers

```yaml
# In docker-compose.yml
services:
  whatsapp-bot:
    # ...
  
  ollama:
    image: ollama/ollama
    # ...

# In .env
AI_BASE_URL=http://ollama:11434/v1
```

### Custom Network

```yaml
networks:
  whatsapp-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.25.0.0/16
```

---

## Health Checks

The container includes a health check endpoint:

```bash
# Check health
curl http://localhost:3000/health

# Docker health status
docker-compose ps
docker inspect --format='{{.State.Health.Status}}' whatsapp-ticket-bot
```

---

## Resource Limits

Default limits (adjust in docker-compose.yml):

- **CPU**: 1.0 cores (limit), 0.5 cores (reservation)
- **Memory**: 1GB (limit), 512MB (reservation)

```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 2G
    reservations:
      cpus: '1.0'
      memory: 1G
```

---

## Troubleshooting

### QR Code Not Showing

```bash
# Check logs
docker-compose logs -f whatsapp-bot

# Ensure clean session
docker-compose down
rm -rf wa-session/
docker-compose up -d
```

### Container Keeps Restarting

```bash
# View crash logs
docker-compose logs --tail=100 whatsapp-bot

# Check environment variables
docker-compose exec whatsapp-bot env | grep MAIL

# Verify .env file
cat .env
```

### Permission Issues

```bash
# Fix ownership
sudo chown -R $(id -u):$(id -g) wa-session/ logs/

# Check permissions
ls -la wa-session/ logs/
```

### Out of Memory

```bash
# Check memory usage
docker stats whatsapp-ticket-bot

# Increase memory limit in docker-compose.yml
# Then restart
docker-compose down
docker-compose up -d
```

### Chromium Issues

```bash
# Rebuild without cache
docker-compose build --no-cache

# Check Chromium installation
docker-compose exec whatsapp-bot chromium --version

# View browser logs
docker-compose exec whatsapp-bot cat /app/logs/bot-*.log | grep -i chromium
```

---

## Monitoring

### View Logs

```bash
# Live logs
docker-compose logs -f

# Last 100 lines
docker-compose logs --tail=100

# Filter by level
docker-compose logs | grep ERROR
docker-compose logs | grep WARN
```

### Resource Usage

```bash
# Real-time stats
docker stats whatsapp-ticket-bot

# Detailed info
docker-compose exec whatsapp-bot top
```

### Log Rotation

Logs are automatically rotated:
- Max size: 10MB per file
- Max files: 3
- Total max: 30MB

Configure in docker-compose.yml:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Deploy WhatsApp Bot

on:
  push:
    branches: [master]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build image
        run: docker build -t whatsapp-bot:${{ github.sha }} .
      
      - name: Push to registry
        run: |
          echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
          docker push whatsapp-bot:${{ github.sha }}
      
      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.HOST }}
          username: ${{ secrets.USERNAME }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /app/whatsapp-bot
            docker-compose pull
            docker-compose up -d
```

---

## Security Best Practices

- ✅ Runs as non-root user (`node`)
- ✅ No new privileges (`no-new-privileges:true`)
- ✅ Environment variables via `.env` (not in image)
- ✅ Secrets excluded via `.dockerignore`
- ✅ Resource limits configured
- ✅ Health checks enabled
- ✅ Log rotation configured

### Additional Hardening

```yaml
# Add to docker-compose.yml
security_opt:
  - no-new-privileges:true
  - seccomp:unconfined  # Only if WhatsApp Web requires it

read_only: true  # Optional: read-only filesystem
tmpfs:
  - /tmp
  - /app/.wwebjs_cache
```

---

## Updating

```bash
# Pull latest code
git pull

# Rebuild image
docker-compose build

# Recreate container
docker-compose up -d

# Verify
docker-compose logs -f
```

---

## Backup & Recovery

### Full Backup

```bash
# Create backup directory
mkdir -p backups

# Backup everything
tar -czf backups/bot-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  .env \
  wa-session/ \
  logs/ \
  .wwebjs_cache/ \
  .wwebjs_auth/
```

### Restore

```bash
# Extract backup
tar -xzf backups/bot-backup-TIMESTAMP.tar.gz

# Restart container
docker-compose restart
```

---

## Support

- **Logs**: `docker-compose logs -f`
- **Health**: `curl http://localhost:3000/health`
- **Shell**: `docker-compose exec whatsapp-bot /bin/bash`
- **Rebuild**: `docker-compose build --no-cache && docker-compose up -d`

---

**Containerized for reliability** 🚀
