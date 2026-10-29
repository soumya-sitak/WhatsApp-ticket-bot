const { Client, LocalAuth } = require('whatsapp-web.js');
const { CONFIG } = require('../config');
const { normalizeJid } = require('../utils/wa-utils');
const logger = require('../logger');

class WAService {
  constructor() {
    this.client = new Client({
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
    this.activeGroups = {};
    this.groupHistories = {};
    this.isReady = false;
  }

  async startSyncWatchdog() {
    // Don't start watchdog if the client is already ready
    if (this.isReady) return;

    // Guard: clear any existing watchdog before creating a new one
    if (this.syncCheckInterval) {
      clearInterval(this.syncCheckInterval);
      this.syncCheckInterval = null;
    }
    let attempts = 0;
    this.syncCheckInterval = setInterval(async () => {
      attempts++;

      // Stop if client became ready while watchdog was running
      if (this.isReady) {
        clearInterval(this.syncCheckInterval);
        this.syncCheckInterval = null;
        return;
      }

      if (!this.client.pupPage || this.client.pupPage.isClosed()) {
        if (attempts > 60) {
          clearInterval(this.syncCheckInterval);
          this.syncCheckInterval = null;
        }
        return;
      }

      if (attempts < 20) return;

      try {
        const triggered = await this.client.pupPage.evaluate(() => {
          try {
            const socket = window.require('WAWebSocketModel')?.Socket;
            const isReady = socket && (socket.state === 'CONNECTED' || socket.hasSynced === true);

            if (isReady && typeof window.onAppStateHasSyncedEvent === 'function') {
              window.onAppStateHasSyncedEvent();
              return true;
            }
          } catch (_) { }
          return false;
        });

        if (triggered) {
          logger.info('Sync watchdog triggered initialization fallback');
          clearInterval(this.syncCheckInterval);
          this.syncCheckInterval = null;
        }
      } catch (_) { }

      if (attempts >= 60) {
        clearInterval(this.syncCheckInterval);
        this.syncCheckInterval = null;
      }
    }, 1500);
  }

  async getChatInfo(chatId) {
    try {
      if (!this.client.pupPage) return null;
      return await this.client.pupPage.evaluate(id => {
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
      logger.warn(`getChatInfo failed: ${err.message}`);
      return null;
    }
  }

  async getContactName(jid, chatId = null) {
    if (!jid) return null;
    const rawId = typeof jid === 'string' ? jid.trim() : (jid._serialized || String(jid));
    const cleanId = rawId.replace(/@.*$/, '');

    try {
      if (this.client.pupPage) {
        const result = await this.client.pupPage.evaluate((id, cId, numId) => {
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

            if (widFactory && contactCol) {
              const wid = id.includes('@') ? widFactory.createWid(id) : widFactory.createWid(`${id}@c.us`);
              const c = contactCol.get(wid) || (contactCol.find && contactCol.find(wid));
              const n = getName(c);
              if (n) return n;
            }

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

      try {
        const fullJid = rawId.includes('@') ? rawId : `${rawId}@c.us`;
        const c = await this.client.getContactById(fullJid);
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

  async downloadMedia(msg) {
    if (!msg) return null;
    try {
      if (typeof msg.downloadMedia === 'function') {
        const media = await msg.downloadMedia();
        if (media) return media;
      }

      // Fallback: try to get the full message if the object is shallow
      const msgId = msg.id?._serialized || msg.id?.id;
      if (msgId) {
        logger.info(`Attempting fallback media download for msg: ${msgId}`);
        const fullMsg = await this.client.getMessageById(msgId);
        if (fullMsg && typeof fullMsg.downloadMedia === 'function') {
          return await fullMsg.downloadMedia();
        }
      }
    } catch (err) {
      logger.error(`Media download error in WAService: ${err.message}`);
    }
    return null;
  }

  async findQuotedMsgFromWA(chatId, stanzaId) {
    if (!this.client.pupPage || !stanzaId) return null;
    try {
      return await this.client.pupPage.evaluate((cId, sId) => {
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

  async fetchRecentChatMessages(chatId, limit = 30) {
    if (!this.client.pupPage) return [];
    try {
      return await this.client.pupPage.evaluate((id, maxCount) => {
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

  async primeChatHistory(chatId, groupName = '') {
    const { extractMessageText } = require('../utils/wa-utils');
    try {
      const rawMessages = await this.fetchRecentChatMessages(chatId, 30);
      if (rawMessages && rawMessages.length > 0) {
        if (!this.groupHistories[chatId]) this.groupHistories[chatId] = [];
        for (const m of rawMessages) {
          const text = (m.text || '').trim();
          if (!text) continue;

          let sender = m.sender;
          const author = m.author;
          if (!sender && author) {
            sender = await this.getContactName(author, chatId);
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

          // This part requires isSameMessage from wa-utils
          const { isSameMessage } = require('../utils/wa-utils');
          const existingIdx = this.groupHistories[chatId].findIndex(h =>
            isSameMessage(h, msgObj.id, msgObj.stanzaId)
          );
          if (existingIdx !== -1) {
            this.groupHistories[chatId][existingIdx] = msgObj;
          } else {
            this.groupHistories[chatId].push(msgObj);
          }
        }

        this.groupHistories[chatId].sort((a, b) => a.timestamp - b.timestamp);
        if (this.groupHistories[chatId].length > 50) {
          this.groupHistories[chatId] = this.groupHistories[chatId].slice(-50);
        }
        const label = groupName || this.activeGroups[chatId]?.name || chatId;
        logger.info(`Loaded ${this.groupHistories[chatId].length} recent message(s) for "${label}"`);
      }
    } catch (err) {
      logger.warn(`primeChatHistory failed: ${err.message}`);
    }
  }

  async listAllGroups() {
    try {
      if (this.client.pupPage) {
        const groups = await this.client.pupPage.evaluate(() => {
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

      if (typeof this.client.getChats === 'function') {
        const chats = await this.client.getChats();
        return (chats || [])
          .filter(c => c && c.isGroup)
          .map(c => ({
            id: normalizeJid(c.id?._serialized || c.id),
            name: (c.name || '').trim(),
          }));
      }
    } catch (err) {
      logger.warn(`listAllGroups failed: ${err.message}`);
    }
    return [];
  }

  async findGroupByName(targetName) {
    const groups = await this.listAllGroups();
    const normalizedTarget = targetName.trim().toLowerCase();
    return groups.find(g => g.name.toLowerCase() === normalizedTarget) || null;
  }
}

module.exports = new WAService();
