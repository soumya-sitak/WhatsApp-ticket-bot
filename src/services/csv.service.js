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

let writeQueue = Promise.resolve();

async function appendTicket(ticketData) {
  const ticketDir = process.env.TICKETS_DIR || path.join(process.cwd(), 'ticket-data');
  const instanceId = CONFIG.instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const csvPath = path.join(ticketDir, `tickets-${instanceId}.csv`);
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

  await fs.promises.mkdir(ticketDir, { recursive: true });
  const file = await fs.promises.open(csvPath, 'a+');
  try {
    const { size } = await file.stat();
    await file.writeFile(size === 0 ? headers + row : row, 'utf8');
    logger.info(`${size === 0 ? 'Created' : 'Appended'} ${path.basename(csvPath)}`);
  } finally {
    await file.close();
  }
}

function logTicket(ticketData) {
  writeQueue = writeQueue
    .then(() => appendTicket(ticketData))
    .catch(err => logger.warn(`CSV logging failed: ${err.message}`));
  return writeQueue;
}

module.exports = {
  logTicket,
};
