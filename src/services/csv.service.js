const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');
const logger = require('../logger');

function escapeCSVField(value) {
  if (value === null || value === undefined) return '""';
  let str = String(value);
  // Prevent spreadsheet applications from treating user text as a formula.
  if (/^[\s]*[=+\-@]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}

async function logTicket(ticketData) {
  try {
    const csvPath = path.join(process.cwd(), 'tickets.csv');
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

    const file = await fs.promises.open(csvPath, 'a+');
    try {
      const { size } = await file.stat();
      await file.writeFile(size === 0 ? headers + row : row, 'utf8');
      logger.info(size === 0 ? 'Created tickets.csv with first ticket' : 'Appended ticket to tickets.csv');
    } finally {
      await file.close();
    }
  } catch (err) {
    logger.warn(`CSV logging failed: ${err.message}`);
  }
}

module.exports = {
  logTicket,
};
