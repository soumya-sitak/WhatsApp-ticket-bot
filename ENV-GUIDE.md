# Environment Variables - Docker Setup

## Quick Answer

**Q: Is my .env file copied into the Docker image?**

**A: No.** Your `.env` file stays on your host machine and is read by Docker Compose at container startup.

## How It Works

### 1. Build Time (Creating Image)
```bash
docker-compose build
```
- ❌ `.env` is NOT copied into the image
- ❌ Secrets are NOT baked into the image
- ✅ Only code and dependencies are included
- ✅ Safe to share/distribute the image

### 2. Runtime (Starting Container)
```bash
docker-compose up -d
```
- ✅ Docker Compose reads `.env` from host
- ✅ Variables are injected as environment variables
- ✅ App accesses via `process.env.VARIABLE_NAME`
- ✅ Secrets stay on your host machine

## File Locations

### On Host Machine
```
/home/soumya/workspace/projects/WhatsApp-ticket-bot/
├── .env                          ← Your actual secrets (stays here!)
├── docker-compose.yml            ← Reads .env at startup
├── .dockerignore                 ← Excludes .env from image
└── .gitignore                    ← Excludes .env from git
```

### Inside Docker Container
```
/app/
├── whatsapp-mail-bridge.js       ← Reads process.env.*
├── package.json
├── src/
├── logs/                         ← Mounted from host
├── wa-session/                   ← Mounted from host
└── NO .env FILE HERE!            ← Variables come from environment
```

## Configuration Flow

```
Step 1: You edit .env on host
   ↓
Step 2: docker-compose reads .env
   ↓
Step 3: Variables injected into container as environment variables
   ↓
Step 4: App reads process.env.MAIL_USER, process.env.AI_API_KEY, etc.
   ↓
Step 5: App works with your configuration
```

## Common Operations

### Update Configuration
```bash
# Edit .env on your host
nano /home/soumya/workspace/projects/WhatsApp-ticket-bot/.env

# Restart container (NO rebuild needed)
docker-compose restart

# Verify
docker-compose exec whatsapp-bot env | grep MAIL_USER
```

### Verify Variables Are Loaded
```bash
# Check specific variable
docker-compose exec whatsapp-bot env | grep AI_BASE_URL

# Check all environment variables
docker-compose exec whatsapp-bot env

# Check inside running container
docker-compose exec whatsapp-bot bash
$ echo $MAIL_USER
$ echo $AI_API_KEY
$ exit
```

### Debug Missing Variables
```bash
# Ensure .env exists
ls -la .env

# Check docker-compose can read it
docker-compose config

# Restart with fresh environment
docker-compose down
docker-compose up -d
docker-compose logs -f
```

## Security Best Practices

### ✅ Do This
- Keep `.env` on host machine only
- Add `.env` to `.gitignore` (already done)
- Use `.dockerignore` to exclude from image (already done)
- Back up `.env` securely (encrypted storage)
- Use different `.env` for dev/staging/production

### ❌ Don't Do This
- Don't add secrets to Dockerfile with `ENV` commands
- Don't commit `.env` to git
- Don't copy `.env` into image with `COPY` command
- Don't share `.env` file in chat/email
- Don't log sensitive environment variables

## Why This Approach?

### Advantages
1. **Security**: Secrets never in image, can't be extracted with `docker history`
2. **Flexibility**: Same image works in dev/staging/prod with different `.env`
3. **Easy Updates**: Edit `.env` and restart, no rebuild needed
4. **Portability**: Share images without exposing secrets
5. **Standard Practice**: Docker best practice for configuration

### What Gets Put Where

| Component | In Docker Image | On Host | Injected at Runtime |
|-----------|----------------|---------|-------------------|
| Node.js code | ✅ Yes | ✅ Yes (source) | ❌ No |
| npm packages | ✅ Yes | ❌ No | ❌ No |
| `.env` file | ❌ No | ✅ Yes | ❌ No |
| Environment variables | ❌ No | ✅ Yes (in .env) | ✅ Yes |
| Secrets (passwords, keys) | ❌ No | ✅ Yes (in .env) | ✅ Yes (as env vars) |
| WhatsApp session | ❌ No | ✅ Yes | ✅ Yes (mounted volume) |
| Logs | ❌ No | ✅ Yes | ✅ Yes (mounted volume) |

## Examples

### Example 1: Update AI Configuration
```bash
# Edit .env
nano .env
# Change: AI_BASE_URL=http://localhost:20128/v1
# To: AI_BASE_URL=http://host.docker.internal:20128/v1

# Restart (no rebuild!)
docker-compose restart

# Verify
docker-compose exec whatsapp-bot env | grep AI_BASE_URL
# Output: AI_BASE_URL=http://host.docker.internal:20128/v1
```

### Example 2: Update Email Recipients
```bash
# Edit .env
nano .env
# Change: MAIL_TO=old@example.com
# To: MAIL_TO=new@example.com,team@example.com

# Restart
docker-compose restart

# Test
docker-compose logs -f
# Raise a test ticket and verify email goes to new recipients
```

### Example 3: Check What App Sees
```bash
# See all variables the app can access
docker-compose exec whatsapp-bot node -e "console.log(process.env)" | grep -E "MAIL|AI_|WHATSAPP"
```

## Troubleshooting

### Variables Not Updating
```bash
# Problem: Changed .env but app still uses old values
# Solution: Ensure you restarted the container
docker-compose restart

# If still not working, recreate container
docker-compose down
docker-compose up -d
```

### Can't Find .env File
```bash
# Problem: docker-compose can't find .env
# Solution: Ensure .env is in same directory as docker-compose.yml
ls -la .env docker-compose.yml
# Both should be in the same directory

# Check docker-compose is reading it
docker-compose config | head -20
```

### Variables Show As Empty
```bash
# Problem: Environment variables are empty in container
# Solution: Check .env syntax (no spaces around =)

# Wrong:
MAIL_USER = user@example.com

# Correct:
MAIL_USER=user@example.com

# Verify syntax
cat .env
```

## Summary

| Question | Answer |
|----------|--------|
| Is .env copied into image? | ❌ No |
| Where does .env live? | ✅ Host machine only |
| When is .env read? | ✅ Container startup (runtime) |
| How to update config? | ✅ Edit .env, then `docker-compose restart` |
| Need to rebuild after .env change? | ❌ No, just restart |
| Are secrets safe? | ✅ Yes, not in image |
| Can I share the image? | ✅ Yes, no secrets in it |

---

**Your secrets stay on your machine** 🔒
