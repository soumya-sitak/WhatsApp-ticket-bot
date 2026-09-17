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

// ----------------------------- CONFIG -------------------------------------
const CONFIG = {
  // Multiple groups to monitor
  groups: (process.env.WHATSAPP_GROUPS || 'test,engineering').split(',').map(g => g.trim()),

  ignoreOwnMessages: process.env.BOT_IGNORE_OWN_MESSAGES === 'true' ? true : false,
  commands: (process.env.BOT_COMMANDS || '/raise,/ticket,!raise,!ticket').split(',').map(c => c.trim()),
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
    enabled: process.env.AI_ENABLED || false,
    baseUrl: process.env.AI_BASE_URL || 'http://localhost:20128/v1',
    model: process.env.AI_MODEL || 'omni',
    apiKey: process.env.AI_API_KEY || '',
  },
};
// ---------------------------------------------------------------------------

const AI_SYSTEM_PROMPT =
  'You are an assistant that converts reported WhatsApp issues into formal engineering/ops support tickets.\n' +
  'Analyze the problem carefully and reply ONLY with compact JSON:\n' +
  '{"subject": "Clear issue title (max 75 chars)", "summary": "1-3 sentences"}';

function extractJson(content) {
  if (!content) return null;
  let cleaned = content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, '$1').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (_) { }
    }
  }
  return null;
}

function formatTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ============================================================================
// AI SUMMARIZATION
// ============================================================================

async function aiSummarize({ reportedText, reporterName, raiserName, raiserNotes, contextMessages }) {
  if (!CONFIG.ai.enabled) return null;

  const contextStr = contextMessages.length > 0
    ? contextMessages.map(m => `[${formatTime(m.timestamp)}] ${m.sender}: ${m.text}`).join('\n')
    : '(No preceding messages)';

  const userPrompt =
    `[BACKGROUND CONTEXT]\n${contextStr}\n\n` +
    `[REPORTED ISSUE]\n` +
    `Reported by: ${reporterName}\n` +
    `Issue: "${reportedText}"\n` +
    (raiserNotes ? `Raiser Note: "${raiserNotes}" (raised by ${raiserName})\n` : '');

  try {
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
    });
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
         <p style="margin:0;line-height:1.5;color:#1e293b;font-size:14px;">${ai.summary.replace(/</g, '&lt;')}</p>
       </div>`
    : '';

  const raiserNoteHtml = raiserNotes
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:13px;color:#92400e;">
         <b>Note from ${raiserName}:</b> ${raiserNotes.replace(/</g, '&lt;')}
       </div>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:680px;color:#1e293b;line-height:1.4;">
      <div style="background:#0f172a;color:#ffffff;padding:12px 18px;border-radius:6px 6px 0 0;">
        <h2 style="margin:0;font-size:17px;font-weight:600;">WhatsApp Support Ticket</h2>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px;">
          Group: <b>${chatName}</b> &bull; Raised by: <b>${raiserName}</b> &bull; ${new Date().toLocaleString()}
        </div>
      </div>

      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;padding:18px;background:#ffffff;">
        ${summaryHtml}
        ${raiserNoteHtml}

        <div style="margin-bottom:12px;">
          <div style="font-size:11px;color:#15803d;font-weight:bold;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">
            Original Reported Message
          </div>
          <div style="padding:10px 14px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:2px;font-size:14px;color:#0f172a;">
            <div style="font-size:12px;color:#64748b;margin-bottom:4px;">
              ${formatTime(reportedTimestamp)}
            </div>
            <div>${reportedText.replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</div>
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
    return ai;
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  },
});

const activeGroups = {};
const groupHistories = {};

async function getChatInfo(chatId) {
  try {
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
  try {
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
    return await client.pupPage.evaluate(() => {
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
  } catch (err) {
    console.warn('⚠ listAllGroups failed:', err.message);
    return [];
  }
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

    // Check for /raise command
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
      console.log(`ℹ /raise sent without reply - instructing user`);
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
          let contactName = await getContactName(authorJid);
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

    // Send email
    try {
      const aiResult = await sendTicketEmail({
        chatName: chatName,
        reportedText: quotedText,
        reporterName: quotedSender,
        raiserName: senderName,
        raiserNotes: raiserNotes,
        contextMessages: contextMessages,
        reportedTimestamp: quotedTimestamp,
      });

      // Confirm in WhatsApp only if email succeeded
      if (aiResult !== null && CONFIG.confirmInGroup) {
        try {
          await msg.reply('🎟️ *Ticket Raised!*');
        } catch (err) {
          console.warn('Failed to send WhatsApp confirmation:', err.message);
        }
      } else if (aiResult === null && CONFIG.confirmInGroup) {
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
    client.initialize();
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
