const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');
const logger = require('../logger');

function escapeCSVField(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

async function logTicket(ticketData) {
  try {
    const csvPath = path.join(process.cwd(), 'tickets.csv');
    const fileExists = fs.existsSync(csvPath);

    const headers = 'Timestamp,Group,Raiser,Issue,Notes,Summary\n';
    const { timestamp, chatName, raiserName, issueSubject, raiserNotes, summary } = ticketData;

    const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
    const row = [
      new Date(ms).toLocaleString(),
      chatName || '',
      raiserName || '',
      issueSubject || '',
      raiserNotes || '',
      summary || '',
    ].map(escapeCSVField).join(',') + '\n';

    if (!fileExists) {
      fs.writeFileSync(csvPath, headers + row, 'utf8');
      logger.info(`Created tickets.csv with first ticket`);
    } else {
      fs.appendFileSync(csvPath, row, 'utf8');
      logger.info(`Appended ticket to tickets.csv`);
    }
  } catch (err) {
    logger.warn(`CSV logging failed: ${err.message}`);
  }
}

module.exports = {
  logTicket,
};
