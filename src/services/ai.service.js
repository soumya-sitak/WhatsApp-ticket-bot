const { CONFIG, AI_SYSTEM_PROMPT } = require('../config');
const logger = require('../logger');

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

async function summarize({ reportedText, reporterName, raiserName, raiserNotes, contextMessages }, retries = 2) {
  if (!CONFIG.ai.enabled) return null;

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const contextStr = contextMessages && contextMessages.length > 0
    ? contextMessages.map((m, idx) => `[${idx}] [${formatTime(m.timestamp)}] ${m.sender}: ${m.text}`).join('\n')
    : '(No preceding messages)';

  const userPrompt =
    `[BACKGROUND CONTEXT]\n${contextStr}\n\n` +
    `[REPORTED WHATSAPP MESSAGE]\n${reportedText}\n\n` +
    `[ISSUE DESCRIPTION FROM TICKET RAISER${/^\[(?:image\/)?media attachment(?: \(download failed\))?\]$/i.test((reportedText || '').trim()) ? ' — PRIMARY ISSUE DESCRIPTION' : ''}]\n` +
    (raiserNotes ? `${raiserNotes}\n` : '(No additional issue description)\n') +
    `\n[REPORTER DETAILS]\n` +
    `Reported by: ${reporterName}\n` +
    `Ticket raised by: ${raiserName}\n`;

  try {
    logger.info(`🤖 AI summarizing issue with ${contextMessages?.length || 0} context message(s)...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

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
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = extractJson(rawContent);
    if (!parsed) throw new Error('Could not parse JSON response');
    logger.info(`🤖 AI summarization finished successfully`);
    return parsed;
  } catch (err) {
    if ((err.name === 'AbortError' || err.message === 'This operation was aborted') && retries > 0) {
      logger.warn(`AI fetch aborted, retrying in 3s... (${retries} attempt(s) left)`);
      await new Promise(r => setTimeout(r, 3000));
      return summarize({ reportedText, reporterName, raiserName, raiserNotes, contextMessages }, retries - 1);
    }
    logger.warn(`AI summarization failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  summarize,
};
