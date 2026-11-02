module.exports = {
  apps: [
    {
      name: 'whatsapp-ticket-bot',
      cwd: __dirname,
      script: 'src/bot.js',
      instances: 1,
      exec_mode: 'fork',
      // Runtime settings and credentials are loaded from .env by dotenv.
      env_production: { NODE_ENV: 'production' },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // Graceful shutdown
      kill_timeout: 5000,
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
};
