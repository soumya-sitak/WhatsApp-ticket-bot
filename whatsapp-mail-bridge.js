/**
 * Office WhatsApp Group → Email Ticket Bot (/raise command)
 * ---------------------------------------------------------
 * Monitor multiple WhatsApp groups and process /raise commands.
 * When someone replies to an issue message with `/raise`, the bot:
 *   1. Extracts the quoted issue message
 *   2. Generates AI ticket summary
 *   3. Sends formatted email to recipients
 *   4. Replies in WhatsApp confirming the ticket was created
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
  commands: (process.env.BOT_COMMANDS || '/raise,/ticket,!raise,!ticket').split(',').map(c => c.trim().toLowerCase()).filter(Boolean),
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

    // Normalize whitespace
    .replace(/\s+/g, ' ')
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
              ${formatTime(reportedTimestamp)}
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

async function getContactName(jid) {
  if (!jid) return null;
  try {
    if (!client.pupPage) return null;
    return await client.pupPage.evaluate(id => {
      try {
        const contact = window.require('WAWebCollections')?.Contact?.get(id);
        if (contact) return contact.pushname || contact.name || contact.formattedName || contact.number || id;
      } catch (_) { }
      return null;
    }, jid);
  } catch (err) {
    return null;
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
      if (groups && groups.length > 0) return groups;
    }

    if (typeof client.getChats === 'function') {
      const chats = await client.getChats();
      return (chats || [])
        .filter(c => c && c.isGroup)
        .map(c => ({
          id: c.id?._serialized || c.id,
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
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ WhatsApp loading: ${percent}% - ${message}`);
  if (percent === 99 || percent === 100) {
    console.log('⏳ Finalizing chat sync & initializing listeners...');
  }
});

client.on('change_state', state => {
  console.log(`🔄 WhatsApp state: ${state}`);
});

client.on('ready', async () => {
  console.log(`Connected. Looking for groups: ${CONFIG.groups.map(g => `"${g}"`).join(', ')}...`);
  await new Promise(r => setTimeout(r, 2500));

  try {
    for (const groupName of CONFIG.groups) {
      const group = await findGroupByName(groupName);
      if (group) {
        activeGroups[group.id] = { name: groupName, id: group.id };
        groupHistories[group.id] = [];
        console.log(`✔ Found group "${groupName}" (ID: ${group.id})`);
      } else {
        console.warn(`⚠ Group not found: ${groupName}`);
      }
    }
  } catch (err) {
    console.error('Error finding groups on startup:', err.message);
  }

  console.log(`\n========================================================`);
  console.log(`Ready! Monitoring ${Object.keys(activeGroups).length} group(s)`);
  console.log(`To raise a ticket: Reply to any message in a monitored group with "/raise"`);
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

    const isGroup = (typeof msg.from === 'string' && msg.from.endsWith('@g.us')) || (typeof msg.to === 'string' && msg.to.endsWith('@g.us'));
    if (!isGroup) return;

    if (CONFIG.ignoreOwnMessages && msg.fromMe) return;

    const chatId = msg.fromMe ? msg.to : msg.from;

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
          }
        }
      } catch (_) { }
    }

    if (!activeGroups[chatId]) return;

    const groupConfig = activeGroups[chatId];
    const chatName = groupConfig.name;

    if (!groupHistories[chatId]) groupHistories[chatId] = [];

    let senderName = msg._data?.notifyName || msg._data?.pushname;
    if (!senderName) {
      senderName = msg.author ? msg.author.replace(/@.*$/, '') : (msg.from ? msg.from.replace(/@.*$/, '') : 'Unknown');
    }

    const trimmedBody = (msg.body || '').trim();

    // Record to history
    const msgObj = {
      id: msg.id?._serialized || `${Date.now()}-${Math.random()}`,
      sender: senderName,
      text: trimmedBody,
      timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    };
    groupHistories[chatId].push(msgObj);
    if (groupHistories[chatId].length > 50) groupHistories[chatId].shift();

    // Check for configured commands
    const matchedCommand = CONFIG.commands.find(cmd =>
      trimmedBody.toLowerCase() === cmd || trimmedBody.toLowerCase().startsWith(cmd + ' ')
    );

    if (!matchedCommand) {
      console.log(`[MSG] "${chatName}" | ${senderName}: "${trimmedBody.slice(0, 50)}"`);
      return;
    }

    console.log(`\n🎯 [RAISE COMMAND] from ${senderName} in "${chatName}"`);

    const raiserNotes = trimmedBody.slice(matchedCommand.length).trim();

    if (!msg.hasQuotedMsg && !msg._data?.quotedMsg) {
      console.log(`ℹ Command sent without reply - instructing user`);
      if (CONFIG.confirmInGroup) {
        try {
          await msg.reply('ℹ *To raise a ticket:* Please reply directly to the message describing the issue with `/raise`.');
        } catch (err) {
          console.warn('Failed to send WhatsApp reply:', err.message);
        }
      }
      return;
    }

    // Extract quoted message
    let quotedText = '';
    let quotedSender = 'Unknown';
    let quotedTimestamp = msg.timestamp || Math.floor(Date.now() / 1000);
    let quotedId = null;

    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted) {
          quotedText = quoted.body || quoted.caption || '';
          quotedId = quoted.id?._serialized;
          quotedTimestamp = quoted.timestamp || quotedTimestamp;

          const authorJid = quoted.author || quoted.from;
          let contactName = authorJid ? await getContactName(authorJid) : null;
          if (!contactName) {
            contactName = quoted._data?.notifyName || quoted._data?.pushname || (authorJid ? authorJid.replace(/@.*$/, '') : 'Unknown');
          }
          quotedSender = contactName;
        }
      } catch (err) {
        console.warn('getQuotedMessage failed:', err.message);
      }
    }

    if (!quotedText && msg._data?.quotedMsg) {
      const rawQ = msg._data.quotedMsg;
      quotedText = rawQ.body || rawQ.caption || '';
      quotedSender = rawQ.notifyName || rawQ.pushname || (msg._data.quotedParticipant ? msg._data.quotedParticipant.replace(/@.*$/, '') : 'Unknown');
      quotedId = rawQ.id?._serialized || msg._data.quotedStanzaID;
    }

    if (!quotedText && quotedId) {
      const match = groupHistories[chatId].find(m => m.id === quotedId);
      if (match) {
        quotedText = match.text;
        quotedSender = match.sender;
        quotedTimestamp = match.timestamp;
      }
    }

    if (!quotedText) {
      console.warn('⚠ Could not retrieve quoted message text');
      if (CONFIG.confirmInGroup) {
        try {
          await msg.reply('⚠ Could not read the original message. Please try replying with `/raise` again.');
        } catch (err) {
          console.warn('Failed to send WhatsApp reply:', err.message);
        }
      }
      return;
    }

    console.log(`📌 Issue from ${quotedSender}: "${quotedText.slice(0, 60)}"`);
    if (raiserNotes) console.log(`📝 Raiser note: "${raiserNotes}"`);

    // Gather context
    let contextMessages = [];
    if (quotedId) {
      const quotedIndex = groupHistories[chatId].findIndex(m => m.id === quotedId);
      if (quotedIndex > 0) {
        const start = Math.max(0, quotedIndex - CONFIG.contextMessagesCount);
        contextMessages = groupHistories[chatId].slice(start, quotedIndex);
      }
    }
    if (contextMessages.length === 0 && groupHistories[chatId].length > 1) {
      const beforeRaise = groupHistories[chatId].slice(0, -1);
      contextMessages = beforeRaise.slice(-CONFIG.contextMessagesCount);
    }

    console.log(`📎 Gathered ${contextMessages.length} context message(s)`);

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
// START BOT
// ============================================================================

console.log('Starting WhatsApp Ticket Bot...');
client.initialize().catch(err => {
  console.error('Failed to initialize:', err.message);
  process.exit(1);
});
