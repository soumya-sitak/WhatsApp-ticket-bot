module.exports = {
  apps: [
    {
      name: 'whatsapp-ticket-bot',
      script: './whatsapp-mail-bridge.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // AI Configuration
        AI_API_KEY: 'your-api-key-here',
        AI_BASE_URL: 'http://localhost:20128/v1',
        AI_MODEL: 'omni',
        // Email Configuration
        MAIL_HOST: 'smtp.gmail.com',
        MAIL_PORT: '465',
        MAIL_SECURE: 'true',
        MAIL_USER: 'your-gmail-address@gmail.com',
        MAIL_PASS: 'your-app-specific-password',
        MAIL_TO: 'recipient1@example.com,recipient2@example.com',
        MAIL_CC: 'cc-recipient@example.com',
        MAIL_BCC: 'bcc-recipient@example.com',
        // WhatsApp Groups
        WHATSAPP_GROUPS: 'test,engineering,support',
        // Bot Behavior
        BOT_PREFIX: '[WA→Ticket]',
        BOT_COMMANDS: '/raise,/ticket,!raise,!ticket',
        BOT_CONTEXT_MESSAGES_COUNT: '4',
        BOT_CONFIRM_IN_GROUP: 'true',
        BOT_IGNORE_OWN_MESSAGES: 'false',
        // Logging
        LOG_LEVEL: 'INFO',
        LOG_DIR: './logs',
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 3000,
      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Memory limit
      max_memory_restart: '500M',
      // Watch for changes (disable in production)
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'wa-session'],
      // Merge logs from multiple instances
      merge_logs: true,
    },
  ],
  // Deploy configuration (optional)
  deploy: {
    production: {
      user: 'node',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-repo.git',
      path: '/var/www/whatsapp-ticket-bot',
      'post-deploy':
        'npm install && pm2 reload pm2.config.js --env production',
    },
  },
};
