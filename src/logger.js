/**
 * Centralized Logger Module
 * Provides structured logging with file persistence and log levels
 */

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class Logger {
  constructor(options = {}) {
    this.level = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase() || 'INFO'] || LOG_LEVELS.INFO;
    this.logDir = process.env.LOG_DIR || './logs';
    this.logFile = path.join(this.logDir, `bot-${new Date().toISOString().split('T')[0]}.log`);

    // Ensure logs directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  format(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const sanitized = this.sanitize(data);
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...sanitized,
    });
  }

  sanitize(data) {
    if (!data || typeof data !== 'object') return data;
    const cleaned = { ...data };
    // Remove sensitive fields
    if (cleaned.password) cleaned.password = '***';
    if (cleaned.apiKey) cleaned.apiKey = '***';
    if (cleaned.pass) cleaned.pass = '***';
    return cleaned;
  }

  write(logLine) {
    try {
      fs.appendFileSync(this.logFile, logLine + '\n');
    } catch (err) {
      console.error('Failed to write log:', err.message);
    }
  }

  log(level, levelName, message, data = {}) {
    if (LOG_LEVELS[levelName] < this.level) return;
    const logLine = this.format(levelName, message, data);
    console.log(logLine);
    this.write(logLine);
  }

  debug(message, data) {
    this.log(LOG_LEVELS.DEBUG, 'DEBUG', message, data);
  }

  info(message, data) {
    this.log(LOG_LEVELS.INFO, 'INFO', message, data);
  }

  warn(message, data) {
    this.log(LOG_LEVELS.WARN, 'WARN', message, data);
  }

  error(message, data) {
    this.log(LOG_LEVELS.ERROR, 'ERROR', message, data);
  }
}

module.exports = new Logger();
