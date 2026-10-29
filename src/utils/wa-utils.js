function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  if (!candidate) return '';
  if (typeof candidate !== 'string') return String(candidate);

  // CRITICAL: Filter out Base64 binary data.
  // JPEGs start with /9j/, PNGs start with iVBOR
  const trimmed = candidate.trim();
  if (trimmed.startsWith('/9j/') || trimmed.startsWith('iVBOR') || trimmed.length > 1000 && !trimmed.includes(' ')) {
    return '';
  }

  return trimmed;
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

function matchCommand(text, commands) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const cmd of commands) {
    if (lower === cmd) {
      return { command: cmd, argText: '' };
    }
    if (lower.startsWith(cmd)) {
      const nextChar = lower.charAt(cmd.length);
      if (/[\s:\-]/.test(nextChar)) {
        const argText = trimmed.slice(cmd.length).replace(/^[\s:\-]+/, '').trim();
        return { command: cmd, argText };
      }
    }
  }
  return null;
}

function isCommandMessage(text, commands) {
  return matchCommand(text, commands) !== null;
}

function cleanIssueText(text) {
  if (!text || typeof text !== 'string') return text || '';

  return text
    .replace(/\s*,?\s*reported\s+by\s+(?:user\s+)?\d+\s*/gi, ' ')
    .replace(/\s*,?\s*reported\s+by\s*:?\s*[^\n.,!?;]+/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

module.exports = {
  escapeHtml,
  formatTime,
  extractMessageText,
  isNumericOrId,
  isSameMessage,
  normalizeJid,
  getMsgChatId,
  matchCommand,
  isCommandMessage,
  cleanIssueText,
};
