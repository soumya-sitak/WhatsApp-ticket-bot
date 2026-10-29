const nodemailer = require('nodemailer');
const { CONFIG } = require('../config');
const { escapeHtml, formatTime } = require('../utils/wa-utils');
const logger = require('../logger');

const transporter = nodemailer.createTransport({
  host: CONFIG.mail.host,
  port: CONFIG.mail.port,
  secure: CONFIG.mail.secure,
  auth: { user: CONFIG.mail.user, pass: CONFIG.mail.pass },
});

async function sendTicket(ticketData, ai) {
  const { chatName, reportedText, reporterName, raiserName, raiserNotes, contextMessages, reportedTimestamp, attachment } = ticketData;

  const subject = ai?.subject
    ? `${CONFIG.prefix} ${ai.subject}`
    : `${CONFIG.prefix} ${chatName}: ${reportedText.slice(0, 60)}`;

  const summaryHtml = ai?.summary
    ? `<div style="background:#f0f9ff;border-left:4px solid #0284c7;padding:14px 16px;border-radius:4px;margin-bottom:18px;">
         <h4 style="margin:0 0 8px 0;color:#0369a1;font-size:15px;">Issue Summary</h4>
         <p style="margin:0;line-height:1.5;color:#1e293b;font-size:14px;">${escapeHtml(ai.summary).replace(/\\n/g, '<br/>')}</p>
       </div>`
    : '';

  const raiserNoteHtml = raiserNotes
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:13px;color:#92400e;">
         <b>Note from ${escapeHtml(raiserName)}:</b> ${escapeHtml(raiserNotes)}
       </div>`
    : '';

  let relatedConversationHtml = '';
  if (ai?.relevant_context_indexes && Array.isArray(ai.relevant_context_indexes) && contextMessages?.length > 0) {
    const validIndexes = [...new Set(
      ai.relevant_context_indexes
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < contextMessages.length)
    )].sort((a, b) => a - b);

    if (validIndexes.length > 0) {
      const contextHtml = validIndexes.map(idx => {
        const ctx = contextMessages[idx];
        const senderEscaped = escapeHtml(ctx.sender);
        const textEscaped = escapeHtml(ctx.text).replace(/\\n/g, '<br/>');
        return `
          <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:12px;color:#64748b;margin-bottom:3px;">
              ${formatTime(ctx.timestamp)} — <b>${senderEscaped}</b>
            </div>
            <div style="font-size:14px;color:#1e293b;line-height:1.5;">${textEscaped}</div>
          </div>`;
      }).join('');

      relatedConversationHtml = `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;color:#475569;font-weight:bold;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">
            Related Conversation
          </div>
          <div style="padding:12px 14px;background:#f8fafc;border-left:4px solid #94a3b8;border-radius:2px;font-size:14px;color:#0f172a;">
            ${contextHtml}
          </div>
        </div>`;
    }
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:680px;color:#1e293b;line-height:1.4;">
      <div style="background:#0f172a;color:#ffffff;padding:12px 18px;border-radius:6px 6px 0 0;">
        <h2 style="margin:0;font-size:17px;font-weight:600;">WhatsApp Support Ticket</h2>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px;">
          Group: <b>${escapeHtml(chatName)}</b> &bull; Raised by: <b>${escapeHtml(raiserName)}</b> &bull; ${new Date().toLocaleString()}
        </div>
      </div>

      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;padding:18px;background:#ffffff;">
        ${summaryHtml}
        ${raiserNoteHtml}
        ${relatedConversationHtml}

        <div style="margin-bottom:12px;">
          <div style="font-size:11px;color:#15803d;font-weight:bold;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">
            Original Reported Message
          </div>
          <div style="padding:10px 14px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:2px;font-size:14px;color:#0f172a;">
            <div style="font-size:12px;color:#64748b;margin-bottom:4px;">
              ${formatTime(reportedTimestamp)} — <b>${escapeHtml(reporterName)}</b>
            </div>
            <div>${escapeHtml(reportedText).replace(/\\n/g, '<br/>')}</div>
          </div>
        </div>
      </div>
    </div>`;

  try {
    const mailOptions = {
      from: CONFIG.mail.user,
      to: CONFIG.mail.to,
      subject: subject,
      html: html,
      attachments: attachment ? [{
        filename: attachment.filename,
        content: attachment.data,
        contentType: attachment.mimetype,
      }] : [],
    };
    if (CONFIG.mail.cc.length > 0) mailOptions.cc = CONFIG.mail.cc;
    if (CONFIG.mail.bcc.length > 0) mailOptions.bcc = CONFIG.mail.bcc;

    logger.info(`Sending email to: ${CONFIG.mail.to.join(', ')}${CONFIG.mail.cc.length > 0 ? ` (CC: ${CONFIG.mail.cc.join(', ')})` : ''}`);
    await transporter.sendMail(mailOptions);
    logger.info(`Email ticket sent successfully`);
    return true;
  } catch (err) {
    logger.error(`Mail error: ${err.message}`);
    return false;
  }
}

module.exports = {
  sendTicket,
};
