/**
 * Office WhatsApp Group → Email Ticket Bot (/raise command)
 * ---------------------------------------------------------
 * Monitor multiple WhatsApp groups and process /raise commands.
 * When someone:
 *   1. Replies to an issue message with `/raise` [optional notes], OR
 *   2. Directly types `/raise <describe issue here>` without replying
 *
 * The bot:
 *   - Extracts/processes the reported issue
 *   - Gathers background conversation context
 *   - Generates AI ticket summary
 *   - Sends formatted email to recipients
 *   - Replies in WhatsApp confirming the ticket was created
 *
 * Setup:
 *   1. npm install
 *   2. Edit CONFIG below (groups, email, AI settings)
 *   3. node whatsapp-mail-bridge.js   → scan QR once
 */

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ----------------------------- CONFIG -------------------------------------
const CONFIG = {
  // Multiple groups to monitor
  groups: (process.env.WHATSAPP_GROUPS || 'test').split(',').map(g => g.trim()).filter(Boolean),

  ignoreOwnMessages: process.env.BOT_IGNORE_OWN_MESSAGES === 'true' ? true : false,
  commands: (process.env.BOT_COMMANDS || 'raise,/raise,!raise,ticket,/ticket,!ticket').split(',').map(c => c.trim().toLowerCase()).filter(Boolean),
  contextMessagesCount: parseInt(process.env.BOT_CONTEXT_MESSAGES_COUNT || '4', 10),
  confirmInGroup: process.env.BOT_CONFIRM_IN_GROUP === 'false' ? false : true,

  // Unified email recipients (all groups use these)
  mail: {
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT || '465', 10),
    secure: process.env.MAIL_SECURE === 'false' ? false : true,
    user: (process.env.MAIL_USER || 'your-email@gmail.com').trim(),
    pass: (process.env.MAIL_PASS || '').trim(),
    to: (process.env.MAIL_TO || 'recipient@example.com').split(',').map(e => e.trim()).filter(e => e),
    cc: (process.env.MAIL_CC || '').split(',').map(e => e.trim()).filter(e => e),
    bcc: (process.env.MAIL_BCC || '').split(',').map(e => e.trim()).filter(e => e),
  },

  prefix: process.env.BOT_PREFIX || '[WA→Ticket]',

  ai: {
    enabled: process.env.AI_ENABLED === 'false' ? false : true,
    baseUrl: process.env.AI_BASE_URL || 'http://localhost:20128/v1',
    model: process.env.AI_MODEL || 'omni',
    apiKey: process.env.AI_API_KEY || '',
  },
};
// ---------------------------------------------------------------------------

const AI_SYSTEM_PROMPT =
  'You are an assistant that converts reported WhatsApp issues into formal engineering/ops support tickets.\n' +
  'Do not include reporter names, phone numbers, WhatsApp user IDs, or phrases like "reported by user XXXXX" in the subject or summary unless they are directly relevant to the technical issue.\n' +
  'Analyze the problem carefully and reply ONLY with compact JSON:\n' +
  '{"subject": "Clear issue title (max 75 chars)", "summary": "1-3 sentences", "relevant_context_indexes": [array of indexes that are relevant to the issue]}\n' +
  'Only include context message indexes (0-based, referring to the contextMessages array) that materially help explain, reproduce, clarify, or provide background for the reported issue.\n' +
  'If no context messages are relevant, use an empty array: []';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractJson(content) {
  if (!content || typeof content !== 'string') return null;
  let cleaned = content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(jsonCandidate);
      } catch (_) {
        try {
          const fixed = jsonCandidate.replace(/,\s*([\]}])/g, '$1');
          return JSON.parse(fixed);
        } catch (_) { }
      }
    }
  }
  return null;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;

  const candidate =
    msg.body ||
    msg._data?.body ||
    msg._data?.caption ||
    msg.caption ||
    msg._data?.text ||
    msg._data?.comment ||
    msg._data?.description ||
    msg._data?.matchedText ||
    msg._data?.pollName ||
    msg.pollName ||
    '';

  return typeof candidate === 'string' ? candidate : String(candidate || '');
}

function isNumericOrId(str) {
  if (!str || typeof str !== 'string') return true;
  const clean = str.replace(/@.*$/, '').trim();
  return /^\d+$/.test(clean) || clean.toLowerCase() === 'unknown';
}

function isSameMessage(historyMsg, targetId, stanzaId, text) {
  if (!historyMsg) return false;
  const hId = String(historyMsg.id || '');
  const hStanza = String(historyMsg.stanzaId || '');
  const hText = String(historyMsg.text || '').trim();

  if (targetId) {
    const tId = String(targetId);
    if (hId === tId || hStanza === tId || hId.includes(tId) || tId.includes(hId)) return true;
  }
  if (stanzaId) {
    const sId = String(stanzaId);
    if (hStanza === sId || hId.includes(sId) || sId.includes(hId)) return true;
  }
  if (text && hText && text.trim() === hText) {
    return true;
  }
  return false;
}

function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.replace(/:.*@/, '@').trim();
}

function getMsgChatId(msg) {
  if (!msg) return null;
  const rawRemote = typeof msg.id?.remote === 'string' ? msg.id.remote : (msg.id?.remote?._serialized || '');
  const rawFrom = typeof msg.from === 'string' ? msg.from : (msg.from?._serialized || '');
  const rawTo = typeof msg.to === 'string' ? msg.to : (msg.to?._serialized || '');

  const remote = normalizeJid(rawRemote);
  const from = normalizeJid(rawFrom);
  const to = normalizeJid(rawTo);

  if (remote && remote.endsWith('@g.us')) return remote;
  if (from && from.endsWith('@g.us')) return from;
  if (to && to.endsWith('@g.us')) return to;
  return remote || from || to || null;
}

function matchCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const cmd of CONFIG.commands) {
    if (lower === cmd) {
      return { command: cmd, argText: '' };
    }
    if (lower.startsWith(cmd)) {
      const nextChar = lower.charAt(cmd.length);
      // Valid separators after command: whitespace (\s: space, \n, \r, \t), colon (:), dash (-)
      if (/[\s:\-]/.test(nextChar)) {
        const argText = trimmed.slice(cmd.length).replace(/^[\s:\-]+/, '').trim();
        return { command: cmd, argText };
      }
    }
  }
  return null;
}

function isCommandMessage(text) {
  return matchCommand(text) !== null;
}

function cleanIssueText(text) {
  if (!text || typeof text !== 'string') return text || '';

  // Remove "reported by" patterns in various formats:
  // - "reported by user 235450191110219"
  // - ", reported by John"
  // - "reported by: user123"
  // Handles: leading comma/space, optional colon, and everything until punctuation/end
  return text
    // Remove: "reported by user 235450191110219"
    .replace(/\s*,?\s*reported\s+by\s+(?:user\s+)?\d+\s*/gi, ' ')

    // Remove: "reported by John"
    .replace(/\s*,?\s*reported\s+by\s*:?\s*[^\n.,!?;]+/gi, ' ')

    // Normalize horizontal whitespace while preserving newlines
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ============================================================================
// CSV TICKET LOGGING
// ============================================================================

function escapeCSVField(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

async function logTicketToCSV({ timestamp, chatName, raiserName, issueSubject, raiserNotes, summary }) {
  try {
    const csvPath = path.join(process.cwd(), 'tickets.csv');
    const fileExists = fs.existsSync(csvPath);

    const headers = 'Timestamp,Group,Raiser,Issue,Notes,Summary\n';
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
      console.log(`📊 Created tickets.csv with first ticket`);
    } else {
      fs.appendFileSync(csvPath, row, 'utf8');
      console.log(`📊 Appended ticket to tickets.csv`);
    }
  } catch (err) {
    console.warn('⚠ CSV logging failed:', err.message);
    // Non-critical: don't throw, just warn
  }
}

// ============================================================================
// AI SUMMARIZATION
// ============================================================================

async function aiSummarize({ reportedText, reporterName, raiserName, raiserNotes, contextMessages }) {
  if (!CONFIG.ai.enabled) return null;

  const contextStr = contextMessages && contextMessages.length > 0
    ? contextMessages.map(m => `[${formatTime(m.timestamp)}] ${m.sender}: ${m.text}`).join('\n')
    : '(No preceding messages)';

  const userPrompt =
    `[BACKGROUND CONTEXT]\n${contextStr}\n\n` +
    `[REPORTED ISSUE]\n` +
    `Reported by: ${reporterName}\n` +
    `Issue: "${reportedText}"\n` +
    (raiserNotes ? `Raiser Note: "${raiserNotes}" (raised by ${raiserName})\n` : '');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${CONFIG.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.ai.model,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = extractJson(rawContent);
    if (!parsed) throw new Error('Could not parse JSON response');
    return parsed;
  } catch (err) {
    console.warn('⚠ AI summarization failed:', err.message);
    return null;
  }
}

// ============================================================================
// EMAIL SENDING
// ============================================================================

const transporter = nodemailer.createTransport({
  host: CONFIG.mail.host,
  port: CONFIG.mail.port,
  secure: CONFIG.mail.secure,
  auth: { user: CONFIG.mail.user, pass: CONFIG.mail.pass },
});

async function sendTicketEmail({ chatName, reportedText, reporterName, raiserName, raiserNotes, contextMessages, reportedTimestamp }) {
  console.log(`\n⏳ Generating AI ticket summary for issue reported by ${reporterName}...`);

  const ai = await aiSummarize({
    reportedText,
    reporterName,
    raiserName,
    raiserNotes,
    contextMessages,
  });

  const subject = ai?.subject
    ? `${CONFIG.prefix} ${ai.subject}`
    : `${CONFIG.prefix} ${chatName}: ${reportedText.slice(0, 60)}`;

  const summaryHtml = ai?.summary
    ? `<div style="background:#f0f9ff;border-left:4px solid #0284c7;padding:14px 16px;border-radius:4px;margin-bottom:18px;">
         <h4 style="margin:0 0 8px 0;color:#0369a1;font-size:15px;">Issue Summary</h4>
         <p style="margin:0;line-height:1.5;color:#1e293b;font-size:14px;">${escapeHtml(ai.summary)}</p>
       </div>`
    : '';

  const raiserNoteHtml = raiserNotes
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:13px;color:#92400e;">
         <b>Note from ${escapeHtml(raiserName)}:</b> ${escapeHtml(raiserNotes)}
       </div>`
    : '';

  // Build Related Conversation section from AI-selected relevant context messages
  let relatedConversationHtml = '';
  if (ai?.relevant_context_indexes && Array.isArray(ai.relevant_context_indexes) && contextMessages?.length > 0) {
    // Validate and filter indexes: must be integers within contextMessages bounds, no duplicates
    const validIndexes = [...new Set(
      ai.relevant_context_indexes
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < contextMessages.length)
    )].sort((a, b) => a - b);

    if (validIndexes.length > 0) {
      const contextHtml = validIndexes.map(idx => {
        const ctx = contextMessages[idx];
        const senderEscaped = escapeHtml(ctx.sender);
        const textEscaped = escapeHtml(ctx.text).replace(/\n/g, '<br/>');
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
            <div>${escapeHtml(reportedText).replace(/\n/g, '<br/>')}</div>
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
    };
    if (CONFIG.mail.cc.length > 0) mailOptions.cc = CONFIG.mail.cc;
    if (CONFIG.mail.bcc.length > 0) mailOptions.bcc = CONFIG.mail.bcc;

    console.log(`📧 Sending email to: ${CONFIG.mail.to.join(', ')}${CONFIG.mail.cc.length > 0 ? ` (CC: ${CONFIG.mail.cc.join(', ')})` : ''}`);
    await transporter.sendMail(mailOptions);
    console.log(`✔ Email ticket sent successfully`);

    // Log ticket to CSV (non-critical, doesn't block email success)
    const issueSubject = ai?.subject || `[No AI subject] ${reportedText.slice(0, 60)}`;
    await logTicketToCSV({
      timestamp: reportedTimestamp,
      chatName,
      raiserName,
      issueSubject,
      raiserNotes,
      summary: ai?.summary,
    });

    return { success: true, ai };
  } catch (err) {
    console.error('✖ Mail error:', err.message);
    return null;
  }
}

// ============================================================================
// WHATSAPP CLIENT
// ============================================================================

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa-session' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

const activeGroups = {};
const groupHistories = {};

async function getChatInfo(chatId) {
  try {
    if (!client.pupPage) return null;
    return await client.pupPage.evaluate(id => {
      try {
        const chatCollection = window.require('WAWebCollections')?.Chat;
        let chat = null;
        if (chatCollection) {
          try {
            const widFactory = window.require('WAWebWidFactory');
            const wid = widFactory ? widFactory.createWid(id) : id;
            chat = chatCollection.get(wid) || chatCollection.get(id);
          } catch (_) {
            chat = chatCollection.get(id);
          }
          if (!chat && typeof chatCollection.getModelsArray === 'function') {
            chat = chatCollection.getModelsArray().find(c => c.id?._serialized === id);
          }
        }
        if (chat) {
          return {
            id: chat.id?._serialized || id,
            name: chat.formattedTitle || chat.name || chat.contact?.name || chat.contact?.pushname || '',
            isGroup: Boolean(chat.isGroup || (chat.id?._serialized && chat.id._serialized.endsWith('@g.us'))),
          };
        }
      } catch (_) { }
      return null;
    }, chatId);
  } catch (err) {
    console.warn('⚠ getChatInfo failed:', err.message);
    return null;
  }
}

async function getContactName(jid, chatId = null) {
  if (!jid) return null;
  const rawId = typeof jid === 'string' ? jid.trim() : (jid._serialized || String(jid));
  const cleanId = rawId.replace(/@.*$/, '');

  try {
    if (client.pupPage) {
      const result = await client.pupPage.evaluate((id, cId, numId) => {
        try {
          const contactCol = window.require('WAWebCollections')?.Contact;
          const widFactory = window.require('WAWebWidFactory');

          const getName = (c) => {
            if (!c) return null;
            const n = c.pushname || c.name || c.formattedTitle || c.formattedName || c.displayName;
            if (n && typeof n === 'string' && n.trim() && n.trim() !== id && n.trim() !== numId) {
              return n.trim();
            }
            return null;
          };

          // 1. Try direct WID lookup
          if (widFactory && contactCol) {
            const wid = id.includes('@') ? widFactory.createWid(id) : widFactory.createWid(`${id}@c.us`);
            const c = contactCol.get(wid) || (contactCol.find && contactCol.find(wid));
            const n = getName(c);
            if (n) return n;
          }

          // 2. Try searching contact collection
          if (contactCol && typeof contactCol.getModelsArray === 'function') {
            const all = contactCol.getModelsArray();
            const found = all.find(c => {
              const sId = c.id?._serialized || '';
              const user = c.id?.user || '';
              return sId === id || user === numId || sId.includes(numId) || sId.includes(id);
            });
            const n = getName(found);
            if (n) return n;
          }

          // 3. Try checking group metadata participants if chatId provided
          if (cId) {
            const chatCol = window.require('WAWebCollections')?.Chat;
            const chat = chatCol?.get(cId) || (widFactory && chatCol?.get(widFactory.createWid(cId)));
            if (chat && chat.groupMetadata && chat.groupMetadata.participants) {
              const parts = chat.groupMetadata.participants.getModelsArray ? chat.groupMetadata.participants.getModelsArray() : chat.groupMetadata.participants;
              const p = Array.isArray(parts) ? parts.find(p => (p.id?._serialized || '').includes(numId)) : null;
              if (p && p.contact) {
                const n = getName(p.contact);
                if (n) return n;
              }
            }
          }
        } catch (_) { }
        return null;
      }, rawId, chatId, cleanId);

      if (result) return result;
    }

    // Try client.getContactById
    try {
      const fullJid = rawId.includes('@') ? rawId : `${rawId}@c.us`;
      const c = await client.getContactById(fullJid);
      if (c && (c.pushname || c.name || c.shortName)) {
        const n = c.pushname || c.name || c.shortName;
        if (n && n !== cleanId && n !== rawId) return n;
      }
    } catch (_) { }
  } catch (err) {
    // ignore
  }
  return null;
}

async function findQuotedMsgFromWA(chatId, stanzaId) {
  if (!client.pupPage || !stanzaId) return null;
  try {
    return await client.pupPage.evaluate((cId, sId) => {
      try {
        const chatCol = window.require('WAWebCollections')?.Chat;
        const msgCol = window.require('WAWebCollections')?.Msg;
        let msg = null;

        if (msgCol && typeof msgCol.getModelsArray === 'function') {
          msg = msgCol.getModelsArray().find(m => m.id?.id === sId || m.id?._serialized?.includes(sId));
        }

        if (!msg && chatCol) {
          const chat = chatCol.get(cId);
          if (chat && chat.msgs && typeof chat.msgs.getModelsArray === 'function') {
            msg = chat.msgs.getModelsArray().find(m => m.id?.id === sId || m.id?._serialized?.includes(sId));
          }
        }

        if (msg) {
          const author = msg.author?._serialized || msg.from?._serialized || msg.id?.participant?._serialized || '';
          const body = msg.body || msg.caption || msg.text || '';
          const notifyName = msg.notifyName || msg.sender?.pushname || msg.sender?.name || '';
          return {
            id: msg.id?._serialized || sId,
            stanzaId: msg.id?.id || sId,
            text: body,
            sender: notifyName,
            author: author,
            timestamp: msg.t || Math.floor(Date.now() / 1000),
          };
        }
      } catch (_) { }
      return null;
    }, chatId, stanzaId);
  } catch (_) {
    return null;
  }
}

async function fetchRecentChatMessages(chatId, limit = 30) {
  if (!client.pupPage) return [];
  try {
    return await client.pupPage.evaluate((id, maxCount) => {
      try {
        const chatCol = window.require('WAWebCollections')?.Chat;
        const widFactory = window.require('WAWebWidFactory');
        const wid = widFactory ? (id.includes('@') ? widFactory.createWid(id) : widFactory.createWid(`${id}@g.us`)) : id;

        let chat = chatCol?.get(wid) || chatCol?.get(id);
        if (!chat && chatCol?.find) {
          try { chat = chatCol.find(wid) || chatCol.find(id); } catch (_) { }
        }
        if (!chat && chatCol?.getModelsArray) {
          chat = chatCol.getModelsArray().find(c => c.id?._serialized === id);
        }
        if (!chat || !chat.msgs) return [];

        let msgs = [];
        if (typeof chat.msgs.getModelsArray === 'function') {
          msgs = chat.msgs.getModelsArray();
        } else if (Array.isArray(chat.msgs.models)) {
          msgs = chat.msgs.models;
        } else if (Array.isArray(chat.msgs)) {
          msgs = chat.msgs;
        }

        const validMsgs = msgs.filter(m => {
          if (!m || m.isNotification || m.type === 'notification_template' || m.type === 'gp2' || m.type === 'protocol' || m.type === 'e2e_notification' || m.type === 'reaction') {
            return false;
          }
          return true;
        });

        validMsgs.sort((a, b) => (a.t || 0) - (b.t || 0));
        const sliced = validMsgs.slice(-maxCount);

        return sliced.map(m => {
          const author = m.author?._serialized || m.author || m.from?._serialized || m.from || m.id?.participant?._serialized || '';
          const body = m.body || m.caption || m.text || m.pollName || '';
          const notifyName = m.notifyName || m.sender?.pushname || m.sender?.name || m.sender?.formattedName || '';
          return {
            id: m.id?._serialized || m.id?.id || String(m.id || ''),
            stanzaId: m.id?.id || '',
            author: typeof author === 'string' ? author : '',
            sender: typeof notifyName === 'string' ? notifyName : '',
            text: typeof body === 'string' ? body : '',
            timestamp: m.t || Math.floor(Date.now() / 1000),
          };
        });
      } catch (err) {
        return [];
      }
    }, chatId, limit);
  } catch (err) {
    return [];
  }
}

async function primeChatHistory(chatId, groupName = '') {
  try {
    const rawMessages = await fetchRecentChatMessages(chatId, 30);
    if (rawMessages && rawMessages.length > 0) {
      if (!groupHistories[chatId]) groupHistories[chatId] = [];
      for (const m of rawMessages) {
        const text = (m.text || '').trim();
        if (!text) continue;

        let sender = m.sender;
        const author = m.author;
        if (!sender && author) {
          sender = await getContactName(author, chatId);
        }
        if (!sender) {
          sender = author ? author.replace(/@.*$/, '') : 'Unknown';
        }

        const msgObj = {
          id: m.id || `${Date.now()}-${Math.random()}`,
          stanzaId: m.stanzaId || m.id,
          sender: sender,
          author: author,
          text: text,
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
        };

        const existingIdx = groupHistories[chatId].findIndex(h =>
          isSameMessage(h, msgObj.id, msgObj.stanzaId)
        );
        if (existingIdx !== -1) {
          groupHistories[chatId][existingIdx] = msgObj;
        } else {
          groupHistories[chatId].push(msgObj);
        }
      }

      groupHistories[chatId].sort((a, b) => a.timestamp - b.timestamp);
      if (groupHistories[chatId].length > 50) {
        groupHistories[chatId] = groupHistories[chatId].slice(-50);
      }
      const label = groupName || activeGroups[chatId]?.name || chatId;
      console.log(`📥 Loaded ${groupHistories[chatId].length} recent message(s) for "${label}"`);
    }
  } catch (err) {
    // Non-critical, just keep memory state
  }
}

async function listAllGroups() {
  try {
    if (client.pupPage) {
      const groups = await client.pupPage.evaluate(() => {
        try {
          const chats = window.require('WAWebCollections')?.Chat?.getModelsArray() || [];
          return chats
            .filter(c => c.isGroup || (c.id?._serialized && c.id._serialized.endsWith('@g.us')))
            .map(c => ({
              id: c.id._serialized,
              name: (c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || '').trim(),
            }));
        } catch (_) {
          return [];
        }
      });
      if (groups && groups.length > 0) {
        return groups.map(g => ({ ...g, id: normalizeJid(g.id) }));
      }
    }

    if (typeof client.getChats === 'function') {
      const chats = await client.getChats();
      return (chats || [])
        .filter(c => c && c.isGroup)
        .map(c => ({
          id: normalizeJid(c.id?._serialized || c.id),
          name: (c.name || '').trim(),
        }));
    }
  } catch (err) {
    console.warn('⚠ listAllGroups failed:', err.message);
  }
  return [];
}

async function findGroupByName(targetName) {
  const groups = await listAllGroups();
  const normalizedTarget = targetName.trim().toLowerCase();
  return groups.find(g => g.name.toLowerCase() === normalizedTarget) || null;
}

let syncCheckInterval = null;

function startSyncWatchdog() {
  if (syncCheckInterval) return;
  let attempts = 0;
  syncCheckInterval = setInterval(async () => {
    attempts++;
    if (!client.pupPage || client.pupPage.isClosed()) {
      if (attempts > 60) {
        clearInterval(syncCheckInterval);
        syncCheckInterval = null;
      }
      return;
    }

    try {
      const triggered = await client.pupPage.evaluate(() => {
        try {
          const socket = window.require('WAWebSocketModel')?.Socket;
          const chatCol = window.require('WAWebCollections')?.Chat;
          const hasChats = Boolean(chatCol && typeof chatCol.getModelsArray === 'function' && chatCol.getModelsArray().length > 0);
          const isReady = socket && (socket.state === 'CONNECTED' || socket.hasSynced === true);

          if ((isReady || hasChats) && typeof window.onAppStateHasSyncedEvent === 'function') {
            window.onAppStateHasSyncedEvent();
            return true;
          }
        } catch (_) { }
        return false;
      });

      if (triggered) {
        clearInterval(syncCheckInterval);
        syncCheckInterval = null;
      }
    } catch (_) { }

    if (attempts >= 40) {
      clearInterval(syncCheckInterval);
      syncCheckInterval = null;
    }
  }, 1200);
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

client.on('qr', qr => {
  console.log('Scan this QR with WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated successfully');
  console.log('⏳ Syncing WhatsApp messages & chats, please wait...');
  startSyncWatchdog();
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ WhatsApp loading: ${percent}% - ${message}`);
  if (percent >= 90) {
    startSyncWatchdog();
  }
});

client.on('change_state', state => {
  console.log(`🔄 WhatsApp state: ${state}`);
  if (state === 'CONNECTED') {
    startSyncWatchdog();
  }
});

client.on('ready', async () => {
  if (syncCheckInterval) {
    clearInterval(syncCheckInterval);
    syncCheckInterval = null;
  }
  console.log(`Connected. Looking for groups: ${CONFIG.groups.map(g => `"${g}"`).join(', ')}...`);
  await new Promise(r => setTimeout(r, 2500));

  try {
    for (const groupName of CONFIG.groups) {
      const group = await findGroupByName(groupName);
      if (group) {
        activeGroups[group.id] = { name: groupName, id: group.id };
        groupHistories[group.id] = [];
        console.log(`✔ Found group "${groupName}" (ID: ${group.id})`);
        await primeChatHistory(group.id, groupName);
      } else {
        console.warn(`⚠ Group not found: ${groupName}`);
      }
    }
  } catch (err) {
    console.error('Error finding groups on startup:', err.message);
  }

  console.log(`\n========================================================`);
  console.log(`Ready! Monitoring ${Object.keys(activeGroups).length} group(s)`);
  console.log(`To raise a ticket: Reply with "raise" / "/raise" OR type "raise <issue text>" / "/raise <issue text>"`);
  console.log(`========================================================\n`);
});

client.on('auth_failure', msg => {
  console.error('✖ Auth failed:', msg);
  process.exit(1);
});

client.on('message_create', async msg => {
  try {
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.type === 'protocol' || msg.type === 'e2e_notification' || msg.type === 'reaction') {
      return;
    }

    const chatId = getMsgChatId(msg);
    if (!chatId || !chatId.endsWith('@g.us')) return;

    if (CONFIG.ignoreOwnMessages && msg.fromMe) return;

    // Dynamically detect configured group if not yet in activeGroups
    if (!activeGroups[chatId]) {
      try {
        const chat = await msg.getChat();
        if (chat && chat.isGroup) {
          const matchedGroupName = CONFIG.groups.find(
            g => g.toLowerCase() === (chat.name || '').trim().toLowerCase()
          );
          if (matchedGroupName) {
            activeGroups[chatId] = { name: chat.name, id: chatId };
            if (!groupHistories[chatId]) groupHistories[chatId] = [];
            console.log(`✔ Dynamically detected configured group "${chat.name}" (ID: ${chatId})`);
            await primeChatHistory(chatId, chat.name);
          }
        }
      } catch (_) { }
    }

    if (!activeGroups[chatId]) return;

    const groupConfig = activeGroups[chatId];
    const chatName = groupConfig.name;

    if (!groupHistories[chatId]) groupHistories[chatId] = [];

    const authorJid = msg.author || (msg.fromMe ? (client.info?.wid?._serialized || msg.from) : msg.from);
    let senderName = msg._data?.notifyName || msg._data?.pushname;
    if (!senderName && authorJid) {
      senderName = await getContactName(authorJid, chatId);
    }
    if (!senderName && msg.fromMe && client.info?.pushname) {
      senderName = client.info.pushname;
    }
    if (!senderName) {
      senderName = authorJid ? String(authorJid).replace(/@.*$/, '') : (msg.fromMe ? 'Bot' : 'Unknown');
    }

    const rawBody = extractMessageText(msg);
    const trimmedBody = rawBody.trim();

    // Record to history if it has text
    if (trimmedBody) {
      const msgObj = {
        id: msg.id?._serialized || `${Date.now()}-${Math.random()}`,
        stanzaId: msg.id?.id || msg._data?.id?.id,
        sender: senderName,
        author: authorJid,
        text: trimmedBody,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      };
      const existingIdx = groupHistories[chatId].findIndex(m =>
        isSameMessage(m, msgObj.id, msgObj.stanzaId)
      );
      if (existingIdx !== -1) {
        groupHistories[chatId][existingIdx] = msgObj;
      } else {
        groupHistories[chatId].push(msgObj);
      }
      if (groupHistories[chatId].length > 50) groupHistories[chatId].shift();
    }

    // Check for configured commands
    const match = matchCommand(trimmedBody);

    if (!match) {
      console.log(`[MSG] "${chatName}" | ${senderName}: "${trimmedBody.slice(0, 60)}"`);
      return;
    }

    const matchedCommand = match.command;
    const commandArgText = match.argText;
    const hasQuoted = Boolean(msg.hasQuotedMsg || msg._data?.quotedMsg);

    // If neither reply nor issue text was given, instruct the user
    if (!hasQuoted && !commandArgText) {
      console.log(`ℹ Command sent without reply or issue text - instructing user`);
      if (CONFIG.confirmInGroup) {
        try {
          await msg.reply('ℹ *To raise a ticket:*\n• Reply directly to any issue message with `raise` or `/raise`\n• Or type `raise <describe your issue here>` (or `/raise <issue>`)');
        } catch (err) {
          console.warn('Failed to send WhatsApp reply:', err.message);
        }
      }
      return;
    }

    let quotedText = '';
    let quotedSender = '';
    let quotedTimestamp = msg.timestamp || Math.floor(Date.now() / 1000);
    let quotedId = null;
    let quotedStanzaId = msg._data?.quotedStanzaID || msg._data?.quotedMsg?.id?.id || null;
    let quotedParticipant = msg._data?.quotedParticipant || null;
    let raiserNotes = '';

    if (hasQuoted) {
      // MODE 1: Reply to an issue message
      raiserNotes = commandArgText;
      console.log(`\n🎯 [RAISE (REPLY)] from ${senderName} in "${chatName}"`);

      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          if (quoted) {
            quotedText = extractMessageText(quoted).trim();
            quotedId = quoted.id?._serialized || quotedId;
            quotedStanzaId = quoted.id?.id || quotedStanzaId;
            quotedTimestamp = quoted.timestamp || quotedTimestamp;
            quotedParticipant = quoted.author || quoted.from || quotedParticipant;
            quotedSender = quoted._data?.notifyName || quoted._data?.pushname || '';
          }
        } catch (err) {
          // getQuotedMessage failed, will fallback below
        }
      }

      // Fallback 1: Raw quotedMsg object from message data
      if ((!quotedText || !quotedSender) && msg._data?.quotedMsg) {
        const rawQ = msg._data.quotedMsg;
        if (!quotedText) {
          quotedText = extractMessageText(rawQ).trim();
        }
        if (!quotedId) {
          quotedId = rawQ.id?._serialized || msg._data.quotedStanzaID;
        }
        if (!quotedStanzaId) {
          quotedStanzaId = rawQ.id?.id || msg._data.quotedStanzaID;
        }
        if (!quotedSender) {
          quotedSender = rawQ.notifyName || rawQ.pushname || '';
        }
        if (!quotedParticipant) {
          quotedParticipant = msg._data.quotedParticipant || rawQ.author || rawQ.from;
        }
      }

      // Fallback 2: Direct lookup in WhatsApp Web store
      if ((!quotedText || !quotedSender) && quotedStanzaId) {
        const waMsg = await findQuotedMsgFromWA(chatId, quotedStanzaId);
        if (waMsg) {
          if (!quotedText) quotedText = waMsg.text?.trim() || '';
          if (!quotedSender) quotedSender = waMsg.sender;
          if (!quotedParticipant) quotedParticipant = waMsg.author;
          if (waMsg.timestamp) quotedTimestamp = waMsg.timestamp;
          if (waMsg.id && !quotedId) quotedId = waMsg.id;
        }
      }

      // Fallback 3: Search in local group history
      const historyMatch = groupHistories[chatId]?.find(m =>
        isSameMessage(m, quotedId, quotedStanzaId, quotedText)
      );
      if (historyMatch) {
        if (!quotedText) quotedText = historyMatch.text;
        if (!quotedSender || isNumericOrId(quotedSender)) {
          if (historyMatch.sender && !isNumericOrId(historyMatch.sender)) {
            quotedSender = historyMatch.sender;
          }
        }
        if (historyMatch.timestamp) quotedTimestamp = historyMatch.timestamp;
        if (historyMatch.id && !quotedId) quotedId = historyMatch.id;
        if (historyMatch.author && !quotedParticipant) quotedParticipant = historyMatch.author;
      }

      // Resolve reporter name if it is still a phone number / LID or empty
      if ((!quotedSender || isNumericOrId(quotedSender)) && quotedParticipant) {
        const resolvedName = await getContactName(quotedParticipant, chatId);
        if (resolvedName) {
          quotedSender = resolvedName;
        }
      }

      if (!quotedSender) {
        quotedSender = quotedParticipant ? quotedParticipant.replace(/@.*$/, '') : 'Unknown';
      }
    } else {
      // MODE 2: Direct raise command with issue text (/raise <issue>)
      quotedText = commandArgText;
      quotedSender = senderName;
      quotedId = msg.id?._serialized || null;
      quotedStanzaId = msg.id?.id || msg._data?.id?.id || null;
      quotedTimestamp = msg.timestamp || Math.floor(Date.now() / 1000);
      raiserNotes = '';
      console.log(`\n🎯 [RAISE (DIRECT)] from ${senderName} in "${chatName}": "${quotedText.slice(0, 60)}"`);
    }

    if (!quotedText) {
      console.warn('⚠ Could not retrieve issue text');
      if (CONFIG.confirmInGroup) {
        try {
          await msg.reply('⚠ Could not read the issue text. Please try again with `raise <issue description>` or reply to the message.');
        } catch (err) {
          console.warn('Failed to send WhatsApp reply:', err.message);
        }
      }
      return;
    }

    console.log(`📌 Issue from ${quotedSender}: "${quotedText.slice(0, 60)}"`);
    if (raiserNotes) console.log(`📝 Raiser note: "${raiserNotes}"`);

    // Ensure recent history is loaded for context
    if (groupHistories[chatId].length < 2) {
      await primeChatHistory(chatId, chatName);
    }

    // Gather context messages preceding the issue / command
    let quotedIndex = -1;
    if (hasQuoted) {
      quotedIndex = groupHistories[chatId].findIndex(m =>
        isSameMessage(m, quotedId, quotedStanzaId, quotedText)
      );
    } else {
      quotedIndex = groupHistories[chatId].findIndex(m =>
        isSameMessage(m, quotedId, quotedStanzaId, trimmedBody)
      );
    }

    let contextMessages = [];
    if (quotedIndex > 0) {
      const start = Math.max(0, quotedIndex - CONFIG.contextMessagesCount);
      contextMessages = groupHistories[chatId].slice(start, quotedIndex);
    } else if (quotedIndex === 0) {
      contextMessages = [];
    } else {
      const nonRaise = groupHistories[chatId].filter(m => {
        const t = (m.text || '').trim();
        const isRaise = isCommandMessage(t);
        const isBotResponse = t.startsWith('🎟️') || t.startsWith('ℹ') || t.startsWith('⚠') || t.startsWith('✖');
        const isQuotedText = quotedText && t.toLowerCase() === quotedText.toLowerCase().trim();
        return !isRaise && !isBotResponse && !isQuotedText && t.length > 0;
      });
      contextMessages = nonRaise.slice(-CONFIG.contextMessagesCount);
    }

    // Filter out invalid or command messages from context
    contextMessages = contextMessages.filter(m => {
      if (!m || !m.text || !m.text.trim()) return false;
      const t = m.text.trim();
      if (isCommandMessage(t)) return false;
      if (t.startsWith('🎟️') || t.startsWith('ℹ') || t.startsWith('⚠') || t.startsWith('✖')) return false;
      if (quotedText && t.toLowerCase() === quotedText.toLowerCase().trim()) return false;
      return true;
    });

    console.log(`📎 Gathered ${contextMessages.length} context message(s)`);
    if (contextMessages.length > 0) {
      contextMessages.forEach((c, idx) => {
        console.log(`   [${idx + 1}] ${c.sender}: "${c.text.slice(0, 50)}"`);
      });
    }

    // Clean the issue text by removing "reported by" patterns
    const cleanedQuotedText = cleanIssueText(quotedText);

    // Send email
    try {
      const result = await sendTicketEmail({
        chatName: chatName,
        reportedText: cleanedQuotedText,
        reporterName: quotedSender,
        raiserName: senderName,
        raiserNotes: raiserNotes,
        contextMessages: contextMessages,
        reportedTimestamp: quotedTimestamp,
      });

      // Confirm in WhatsApp only if email succeeded
      if (result && result.success && CONFIG.confirmInGroup) {
        try {
          await msg.reply('🎟️ *Ticket Raised*');
        } catch (err) {
          console.warn('Failed to send WhatsApp confirmation:', err.message);
        }
      } else if ((!result || !result.success) && CONFIG.confirmInGroup) {
        try {
          await msg.reply('✖ Failed to create ticket. Please try again or contact support.');
        } catch (err) {
          console.warn('Failed to send WhatsApp error notification:', err.message);
        }
      }
    } catch (err) {
      console.error('Failed to process /raise command:', err.message);
    }
  } catch (err) {
    console.error('✖ Message handler error:', err?.stack || err?.message || err);
  }
});

client.on('disconnected', reason => {
  console.error('Disconnected:', reason);
  setTimeout(() => {
    console.log('Reconnecting...');
    client.initialize().catch(err => console.error('Reconnection failed:', err.message));
  }, 5000);
});

// ============================================================================
// PROCESS TERMINATION & CLEANUP
// ============================================================================

process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down WhatsApp Ticket Bot...');
  if (syncCheckInterval) clearInterval(syncCheckInterval);
  try {
    await client.destroy();
  } catch (_) { }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  if (syncCheckInterval) clearInterval(syncCheckInterval);
  try {
    await client.destroy();
  } catch (_) { }
  process.exit(0);
});

// ============================================================================
// START BOT
// ============================================================================

console.log('Starting WhatsApp Ticket Bot...');
client.initialize().catch(err => {
  console.error('Failed to initialize:', err.message);
  process.exit(1);
});
