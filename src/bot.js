const { Client } = require('whatsapp-web.js');
const { CONFIG } = require('./config');
const {
  extractMessageText,
  matchCommand,
  isCommandMessage,
  cleanIssueText,
  getMsgChatId,
  isSameMessage,
  isNumericOrId
} = require('./utils/wa-utils');
const waService = require('./services/wa.service');
const aiService = require('./services/ai.service');
const mailService = require('./services/mail.service');
const csvService = require('./services/csv.service');
const logger = require('./logger');

const client = waService.client;

// State
const processedMessageIds = new Map();
const raisedTicketMessageIds = new Map();

function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  for (const [id, time] of processedMessageIds.entries()) {
    if (now - time > 60000) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.set(msgId, now);
  return false;
}

function hasMessageRaisedTicket(id, stanzaId) {
  if (id && raisedTicketMessageIds.has(String(id))) return true;
  if (stanzaId && raisedTicketMessageIds.has(String(stanzaId))) return true;
  return false;
}

function markMessageRaisedTicket(id, stanzaId) {
  const now = Date.now();
  for (const [key, time] of raisedTicketMessageIds.entries()) {
    if (now - time > 24 * 60 * 60 * 1000) raisedTicketMessageIds.delete(key);
  }
  if (id) raisedTicketMessageIds.set(String(id), now);
  if (stanzaId) raisedTicketMessageIds.set(String(stanzaId), now);
}

async function processRaiseCommand({
  msg,
  chatId,
  chatName,
  senderName,
  trimmedBody,
  match,
  isEdit = false,
}) {
  const commandArgText = match.argText;
  const hasQuoted = Boolean(msg.hasQuotedMsg || msg._data?.quotedMsg);

  if (!hasQuoted && !commandArgText) {
    logger.info(`Command sent without reply or issue text - instructing user${isEdit ? ' (via edit)' : ''}`);
    if (CONFIG.confirmInGroup) {
      try {
        await msg.reply('ℹ *To raise a ticket:*\n• Reply directly to any issue message with `raise` or `/raise`\n• Or type `raise <describe your issue here>` (or `/raise <issue>`)');
      } catch (err) {
        logger.warn(`Failed to send WhatsApp reply: ${err.message}`);
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
  let reportedAttachment = null;

  if (hasQuoted) {
    raiserNotes = commandArgText;
    logger.info(`\n🎯 [RAISE (REPLY${isEdit ? ' - VIA EDIT' : ''})] from ${senderName} in "${chatName}"`);

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
        // fallback
      }
    }

    if ((!quotedText || !quotedSender) && msg._data?.quotedMsg) {
      const rawQ = msg._data.quotedMsg;
      if (!quotedText) quotedText = extractMessageText(rawQ).trim();
      if (!quotedId) quotedId = rawQ.id?._serialized || msg._data.quotedStanzaID;
      if (!quotedStanzaId) quotedStanzaId = rawQ.id?.id || msg._data.quotedStanzaID;
      if (!quotedSender) quotedSender = rawQ.notifyName || rawQ.pushname || '';
      if (!quotedParticipant) quotedParticipant = msg._data.quotedParticipant || rawQ.author || rawQ.from;
    }

    if ((!quotedText || !quotedSender) && quotedStanzaId) {
      const waMsg = await waService.findQuotedMsgFromWA(chatId, quotedStanzaId);
      if (waMsg) {
        if (!quotedText) quotedText = waMsg.text?.trim() || '';
        if (!quotedSender) quotedSender = waMsg.sender;
        if (!quotedParticipant) quotedParticipant = waMsg.author;
        if (waMsg.timestamp) quotedTimestamp = waMsg.timestamp;
        if (waMsg.id && !quotedId) quotedId = waMsg.id;
      }
    }

    // Download attachment if the quoted message has media
    if (hasQuoted) {
      try {
        let quotedMsgObj = null;
        if (msg.hasQuotedMsg) {
          quotedMsgObj = await msg.getQuotedMessage();
        } else if (msg._data?.quotedMsg) {
          quotedMsgObj = msg._data.quotedMsg;
        } else if (quotedStanzaId) {
          quotedMsgObj = await waService.findQuotedMsgFromWA(chatId, quotedStanzaId);
        }

        if (quotedMsgObj && (quotedMsgObj.hasMedia || quotedMsgObj.type === 'image' || quotedMsgObj.type === 'document')) {
          logger.info(`📎 Media detected in quoted message. Attempting download...`);

          const media = await waService.downloadMedia(quotedMsgObj);

          if (media) {
            logger.info(`✅ Successfully downloaded attachment: ${media.filename}`);
            reportedAttachment = {
              data: media.data,
              filename: media.filename || 'attachment',
              mimetype: media.mimetype,
            };
          } else {
            logger.warn(`⚠️ Media download returned null for message ${quotedMsgObj.id?._serialized}`);
          }
        }
      } catch (err) {
        logger.error(`❌ Failed to download attachment: ${err.message}`);
      }
    }

    // ENSURE we have text for the ticket, even if the message is ONLY an image
    if (!quotedText || quotedText.startsWith('/9j/') || quotedText.startsWith('iVBOR')) {
      if (hasQuoted) {
        try {
          const quotedMsgObj = msg.hasQuotedMsg
            ? await msg.getQuotedMessage()
            : (msg._data?.quotedMsg || await waService.findQuotedMsgFromWA(chatId, quotedStanzaId));

          if (quotedMsgObj) {
            const caption = extractMessageText(quotedMsgObj).trim();
            if (caption && !caption.startsWith('/9j/') && !caption.startsWith('iVBOR')) {
              quotedText = caption;
            } else if (reportedAttachment) {
              quotedText = `[Image/Media Attachment]`;
            } else {
              quotedText = `[Media Attachment (Download Failed)]`;
            }
          }
        } catch (e) {
          logger.warn(`Failed to retrieve caption for image-only ticket: ${e.message}`);
          quotedText = reportedAttachment ? `[Image/Media Attachment]` : `[Media Attachment]`;
        }
      }
    }

    const historyMatch = waService.groupHistories[chatId]?.find(m =>
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

    if ((!quotedSender || isNumericOrId(quotedSender)) && quotedParticipant) {
      const resolvedName = await waService.getContactName(quotedParticipant, chatId);
      if (resolvedName) {
        quotedSender = resolvedName;
      }
    }

    if (!quotedSender) {
      quotedSender = quotedParticipant ? quotedParticipant.replace(/@.*$/, '') : 'Unknown';
    }
  } else {
    quotedText = commandArgText;
    quotedSender = senderName;
    quotedId = msg.id?._serialized || null;
    quotedStanzaId = msg.id?.id || msg._data?.id?.id || null;
    quotedTimestamp = msg.timestamp || Math.floor(Date.now() / 1000);
    raiserNotes = '';
    logger.info(`\n🎯 [RAISE (DIRECT${isEdit ? ' - VIA EDIT' : ''})] from ${senderName} in "${chatName}": "${quotedText.slice(0, 60)}"`);
  }

  if (!quotedText) {
    logger.warn('Could not retrieve issue text');
    if (CONFIG.confirmInGroup) {
      try {
        await msg.reply('⚠ Could not read the issue text. Please try again with `raise <issue description>` or reply to the message.');
      } catch (err) {
        logger.warn(`Failed to send WhatsApp reply: ${err.message}`);
      }
    }
    return;
  }

  logger.info(`📌 Issue from ${quotedSender}: "${quotedText.slice(0, 60)}"`);
  if (raiserNotes) logger.info(`📝 Raiser note: "${raiserNotes}"`);

  if (waService.groupHistories[chatId].length < 2) {
    await waService.primeChatHistory(chatId, chatName);
  }

  let quotedIndex = -1;
  if (hasQuoted) {
    quotedIndex = waService.groupHistories[chatId].findIndex(m =>
      isSameMessage(m, quotedId, quotedStanzaId, quotedText)
    );
  } else {
    quotedIndex = waService.groupHistories[chatId].findIndex(m =>
      isSameMessage(m, quotedId, quotedStanzaId, trimmedBody)
    );
  }

  let contextMessages = [];
  if (quotedIndex > 0) {
    const start = Math.max(0, quotedIndex - CONFIG.contextMessagesCount);
    contextMessages = waService.groupHistories[chatId].slice(start, quotedIndex);
  } else if (quotedIndex === 0) {
    contextMessages = [];
  } else {
    const nonRaise = waService.groupHistories[chatId].filter(m => {
      const t = (m.text || '').trim();
      const isRaise = isCommandMessage(t, CONFIG.commands);
      const isBotResponse = t.startsWith('🎟️') || t.startsWith('ℹ') || t.startsWith('⚠') || t.startsWith('✖');
      const isQuotedText = quotedText && t.toLowerCase() === quotedText.toLowerCase().trim();
      return !isRaise && !isBotResponse && !isQuotedText && t.length > 0;
    });
    contextMessages = nonRaise.slice(-CONFIG.contextMessagesCount);
  }

  contextMessages = contextMessages.filter(m => {
    if (!m || !m.text || !m.text.trim()) return false;
    const t = m.text.trim();
    if (isCommandMessage(t, CONFIG.commands)) return false;
    if (t.startsWith('🎟️') || t.startsWith('ℹ') || t.startsWith('⚠') || t.startsWith('✖')) return false;
    if (quotedText && t.toLowerCase() === quotedText.toLowerCase().trim()) return false;
    return true;
  });

  logger.info(`📎 Gathered ${contextMessages.length} context message(s)`);
  if (contextMessages.length > 0) {
    contextMessages.forEach((c, idx) => {
      logger.info(`   [${idx + 1}] ${c.sender}: "${c.text.slice(0, 50)}"`);
    });
  }

  const cleanedQuotedText = cleanIssueText(quotedText);

  try {
    const aiSummary = await aiService.summarize({
      reportedText: cleanedQuotedText,
      reporterName: quotedSender,
      raiserName: senderName,
      raiserNotes: raiserNotes,
      contextMessages: contextMessages,
    });

    if (aiSummary) {
      logger.info(`🤖 AI Subject: "${aiSummary.subject}"`);
      logger.info(`🤖 AI Summary: "${aiSummary.summary}"`);
      if (aiSummary.relevant_context_indexes?.length > 0) {
        logger.info(`🤖 Relevant context indexes: [${aiSummary.relevant_context_indexes.join(', ')}]`);
      }
    } else {
      logger.warn('🤖 AI summarization returned no result — using raw text for email');
    }

    const ticketData = {
      chatName,
      reportedText: cleanedQuotedText,
      reporterName: quotedSender,
      raiserName: senderName,
      raiserNotes: raiserNotes,
      contextMessages: contextMessages,
      reportedTimestamp: quotedTimestamp,
      attachment: reportedAttachment,
    };

    logger.info(`📧 Sending email ticket...`);
    const emailSuccess = await mailService.sendTicket(ticketData, aiSummary);

    markMessageRaisedTicket(msg.id?._serialized || null, msg.id?.id || msg._data?.id?.id || null);

    if (emailSuccess && CONFIG.confirmInGroup) {
      try {
        await msg.reply('🎟️ *Ticket Raised*');
      } catch (err) {
        logger.warn(`Failed to send WhatsApp reply: ${err.message}`);
      }
    } else if (!emailSuccess && CONFIG.confirmInGroup) {
      try {
        await msg.reply('✖ Failed to create ticket. Please try again or contact support.');
      } catch (err) {
        logger.warn(`Failed to send WhatsApp reply: ${err.message}`);
      }
    }

    if (aiSummary) {
      await csvService.logTicket({
        timestamp: quotedTimestamp,
        chatName,
        raiserName: senderName,
        issueSubject: aiSummary.subject || `[No AI subject] ${cleanedQuotedText.slice(0, 60)}`,
        raiserNotes,
        summary: aiSummary.summary,
      });
    }
  } catch (err) {
    logger.error(`Failed to process /raise command: ${err.message}`);
  }
}

async function handleEditedMessage(msg, newBody, prevBody) {
  try {
    if (!msg) return;
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.type === 'protocol' || msg.type === 'e2e_notification' || msg.type === 'reaction') {
      return;
    }

    const chatId = getMsgChatId(msg);
    if (!chatId || !chatId.endsWith('@g.us')) return;

    if (CONFIG.ignoreOwnMessages && msg.fromMe) return;

    if (!waService.activeGroups[chatId]) {
      try {
        const chat = await msg.getChat();
        if (chat && chat.isGroup) {
          const matchedGroupName = CONFIG.groups.find(
            g => g.toLowerCase() === (chat.name || '').trim().toLowerCase()
          );
          if (matchedGroupName) {
            waService.activeGroups[chatId] = { name: chat.name, id: chatId };
            if (!waService.groupHistories[chatId]) waService.groupHistories[chatId] = [];
            logger.info(`✔ Dynamically detected configured group "${chat.name}" (ID: ${chatId})`);
            await waService.primeChatHistory(chatId, chat.name);
          }
        }
      } catch (_) { }
    }

    if (!waService.activeGroups[chatId]) return;

    const groupConfig = waService.activeGroups[chatId];
    const chatName = groupConfig.name;

    if (!waService.groupHistories[chatId]) waService.groupHistories[chatId] = [];

    const msgUniqueId = msg.id?._serialized || msg.id?.id || (msg._data?.id?.id ? String(msg._data.id.id) : null);
    const stanzaId = msg.id?.id || msg._data?.id?.id || null;

    const authorJid = msg.author || (msg.fromMe ? (waService.client.info?.wid?._serialized || msg.from) : msg.from);
    let senderName = msg._data?.notifyName || msg._data?.pushname;
    if (!senderName && authorJid) {
      senderName = await waService.getContactName(authorJid, chatId);
    }
    if (!senderName && msg.fromMe && waService.client.info?.pushname) {
      senderName = waService.client.info.pushname;
    }
    if (!senderName) {
      senderName = authorJid ? String(authorJid).replace(/@.*$/, '') : (msg.fromMe ? 'Bot' : 'Unknown');
    }

    const editedText = (typeof newBody === 'string' && newBody.trim().length > 0)
      ? newBody.trim()
      : extractMessageText(msg).trim();
    const previousText = (typeof prevBody === 'string') ? prevBody.trim() : '';

    const editKey = `${msgUniqueId || stanzaId}:${editedText}`;
    const now = Date.now();
    for (const [k, t] of processedEditDebounce.entries()) {
      if (now - t > 30000) processedEditDebounce.delete(k);
    }
    if (processedEditDebounce.has(editKey)) {
      return;
    }
    processedEditDebounce.set(editKey, now);

    logger.info(`✏ [EDIT] "${chatName}" | ${senderName}: "${previousText.slice(0, 30)}" ➔ "${editedText.slice(0, 40)}"`);

    if (editedText) {
      const msgObj = {
        id: msg.id?._serialized || `${Date.now()}-${Math.random()}`,
        stanzaId: stanzaId,
        sender: senderName,
        author: authorJid,
        text: editedText,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      };
      const existingIdx = waService.groupHistories[chatId].findIndex(m =>
        isSameMessage(m, msgObj.id, msgObj.stanzaId)
      );
      if (existingIdx !== -1) {
        waService.groupHistories[chatId][existingIdx].text = editedText;
      } else {
        waService.groupHistories[chatId].push(msgObj);
        if (waService.groupHistories[chatId].length > 50) waService.groupHistories[chatId].shift();
      }
    }

    if (hasMessageRaisedTicket(msgUniqueId, stanzaId)) {
      logger.info(`ℹ Message ${msgUniqueId || stanzaId} was already processed as a ticket; skipping duplicate ticket.`);
      return;
    }

    if (previousText && isCommandMessage(previousText, CONFIG.commands)) {
      logger.info(`ℹ Message previously contained a raise command; skipping.`);
      return;
    }

    const match = matchCommand(editedText, CONFIG.commands);
    if (!match) {
      return;
    }

    logger.info(`🎯 [EDIT TRIGGER] Message edited to start with "${match.command}"! Triggering ticket process...`);

    await processRaiseCommand({
      msg,
      chatId,
      chatName,
      senderName,
      trimmedBody: editedText,
      match,
      isEdit: true,
    });
  } catch (err) {
    logger.error(`✖ Edit message handler error: ${err?.stack || err?.message || err}`);
  }
}

const processedEditDebounce = new Map();

// ============================================================================
// MESSAGE LISTENERS
// ============================================================================

client.on('qr', qr => {
  logger.info('Scan this QR with WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

// Note: qrcode-terminal needs to be imported here if we use it
const qrcode = require('qrcode-terminal');

client.on('authenticated', () => {
  logger.info('✅ WhatsApp authenticated successfully');
  if (!waService.isReady) {
    logger.info('⏳ Syncing WhatsApp messages & chats, please wait...');
    waService.startSyncWatchdog();
  }
});

client.on('loading_screen', (percent, message) => {
  logger.info(`⏳ WhatsApp loading: ${percent}% - ${message}`);
  if (percent >= 90 && !waService.isReady) {
    waService.startSyncWatchdog();
  }
});

client.on('change_state', state => {
  logger.info(`🔄 WhatsApp state: ${state}`);
  if (state === 'CONNECTED' && !waService.isReady) {
    waService.startSyncWatchdog();
  }
});

client.on('ready', async () => {
  waService.isReady = true;
  if (waService.syncCheckInterval) {
    clearInterval(waService.syncCheckInterval);
    waService.syncCheckInterval = null;
  }
  logger.info(`Connected. Looking for groups: ${CONFIG.groups.map(g => `"${g}"`).join(', ')}...`);
  await new Promise(r => setTimeout(r, 2500));

  try {
    for (const groupName of CONFIG.groups) {
      const group = await waService.findGroupByName(groupName);
      if (group) {
        waService.activeGroups[group.id] = { name: groupName, id: group.id };
        waService.groupHistories[group.id] = [];
        logger.info(`✔ Found group "${groupName}" (ID: ${group.id})`);
        await waService.primeChatHistory(group.id, groupName);
      } else {
        logger.warn(`⚠ Group not found: ${groupName}`);
      }
    }
  } catch (err) {
    console.error('Error finding groups on startup:', err.message);
  }

  try {
    if (waService.client.pupPage && !waService.client.pupPage.isClosed()) {
      await waService.client.pupPage.evaluate(() => {
        try {
          const Msg = window.require('WAWebCollections')?.Msg;
          if (!Msg || typeof Msg.on !== 'function') return;

          if (!window.__wwebjs_msg_listener_fixed) {
            window.__wwebjs_msg_listener_fixed = true;
            Msg.on('add', (msg) => {
              try {
                if (msg && msg.isNewMsg && typeof window.onAddMessageEvent === 'function') {
                  const model = window.WWebJS?.getMessageModel ? window.WWebJS.getMessageModel(msg) : msg;
                  window.onAddMessageEvent(model);
                }
              } catch (e) { console.error(e); }
            });
          }

          if (!window.__wwebjs_edit_listener_fixed) {
            window.__wwebjs_edit_listener_fixed = true;
            Msg.on('change:body change:caption', (msg, newBody, prevBody) => {
              try {
                if (typeof window.onEditMessageEvent === 'function') {
                  const model = window.WWebJS?.getMessageModel ? window.WWebJS.getMessageModel(msg) : msg;
                  window.onEditMessageEvent(model, newBody, prevBody);
                }
              } catch (e) { console.error(e); }
            });
          }
        } catch (e) { console.error(e); }
      });
    }
  } catch (err) {
    logger.error(`Error injecting listeners: ${err.message}`);
  }

  logger.info(`\n========================================================`);
  logger.info(`Ready! Monitoring ${Object.keys(waService.activeGroups).length} group(s)`);
  logger.info(`To raise a ticket: Reply with "raise" / "/raise" OR type "raise <issue text>" / "/raise <issue text>"`);
  logger.info(`========================================================\n`);
});

client.on('auth_failure', msg => {
  logger.error('✖ Auth failed:', msg);
  process.exit(1);
});

client.on('message_create', async msg => {
  try {
    if (!msg) return;
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.type === 'protocol' || msg.type === 'e2e_notification' || msg.type === 'reaction') {
      return;
    }

    const msgUniqueId = msg.id?._serialized || msg.id?.id || (msg._data?.id?.id ? String(msg._data.id.id) : null);
    if (msgUniqueId && isDuplicateMessage(msgUniqueId)) {
      return;
    }

    const chatId = getMsgChatId(msg);
    if (!chatId || !chatId.endsWith('@g.us')) return;

    if (CONFIG.ignoreOwnMessages && msg.fromMe) {
      return;
    }

    if (!waService.activeGroups[chatId]) {
      try {
        const chat = await msg.getChat();
        if (chat && chat.isGroup) {
          const matchedGroupName = CONFIG.groups.find(
            g => g.toLowerCase() === (chat.name || '').trim().toLowerCase()
          );
          if (matchedGroupName) {
            waService.activeGroups[chatId] = { name: chat.name, id: chatId };
            if (!waService.groupHistories[chatId]) waService.groupHistories[chatId] = [];
            logger.info(`✔ Dynamically detected configured group "${chat.name}" (ID: ${chatId})`);
            await waService.primeChatHistory(chatId, chat.name);
          }
        }
      } catch (_) { }
    }

    if (!waService.activeGroups[chatId]) return;

    const groupConfig = waService.activeGroups[chatId];
    const chatName = groupConfig.name;

    if (!waService.groupHistories[chatId]) waService.groupHistories[chatId] = [];

    const authorJid = msg.author || (msg.fromMe ? (waService.client.info?.wid?._serialized || msg.from) : msg.from);
    let senderName = msg._data?.notifyName || msg._data?.pushname;
    if (!senderName && authorJid) {
      senderName = await waService.getContactName(authorJid, chatId);
    }
    if (!senderName && msg.fromMe && waService.client.info?.pushname) {
      senderName = waService.client.info.pushname;
    }
    if (!senderName) {
      senderName = authorJid ? String(authorJid).replace(/@.*$/, '') : (msg.fromMe ? 'Bot' : 'Unknown');
    }

    const rawBody = extractMessageText(msg);
    const trimmedBody = rawBody.trim();

    if (trimmedBody) {
      const msgObj = {
        id: msg.id?._serialized || `${Date.now()}-${Math.random()}`,
        stanzaId: msg.id?.id || msg._data?.id?.id,
        sender: senderName,
        author: authorJid,
        text: trimmedBody,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      };
      const existingIdx = waService.groupHistories[chatId].findIndex(m =>
        isSameMessage(m, msgObj.id, msgObj.stanzaId)
      );
      if (existingIdx !== -1) {
        waService.groupHistories[chatId][existingIdx] = msgObj;
      } else {
        waService.groupHistories[chatId].push(msgObj);
      }
      if (waService.groupHistories[chatId].length > 50) waService.groupHistories[chatId].shift();
    } else if (msg.hasMedia || msg.type === 'image' || msg.type === 'document') {
      // Log media messages without trying to treat them as text
      const filename = msg._data?.filename || 'Media Attachment';
      logger.info(`[MEDIA] "${chatName}" | ${senderName}: ${filename}`);
    }

    const match = matchCommand(trimmedBody, CONFIG.commands);

    if (!match) {
      logger.info(`[MSG] "${chatName}" | ${senderName}: "${trimmedBody.slice(0, 60)}"`);
      return;
    }

    await processRaiseCommand({
      msg,
      chatId,
      chatName,
      senderName,
      trimmedBody,
      match,
      isEdit: false,
    });
  } catch (err) {
    logger.error(`✖ Message handler error: ${err?.stack || err?.message || err}`);
  }
});

client.on('message_edit', async (msg, newBody, prevBody) => {
  await handleEditedMessage(msg, newBody, prevBody);
});

client.on('disconnected', reason => {
  waService.isReady = false;
  logger.error(`Disconnected: ${reason}`);
  setTimeout(() => {
    logger.info('Reconnecting...');
    client.initialize().catch(err => logger.error(`Reconnection failed: ${err.message}`));
  }, 5000);
});

process.on('SIGINT', async () => {
  logger.info('\nGracefully shutting down WhatsApp Ticket Bot...');
  if (waService.syncCheckInterval) clearInterval(waService.syncCheckInterval);
  try {
    await client.destroy();
  } catch (_) { }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  if (waService.syncCheckInterval) clearInterval(waService.syncCheckInterval);
  try {
    await client.destroy();
  } catch (_) { }
  process.exit(0);
});

console.log('Starting WhatsApp Ticket Bot...');
client.initialize().catch(err => {
  logger.error(`Failed to initialize: ${err.message}`);
  process.exit(1);
});
