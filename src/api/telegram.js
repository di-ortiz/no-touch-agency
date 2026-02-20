import axios from 'axios';
import FormData from 'form-data';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';

const log = logger.child({ platform: 'telegram' });

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

/**
 * Send a Telegram text message via Bot API.
 * @param {string} message - Message text (supports Telegram Markdown V2 subset)
 * @param {string} [chatId] - Recipient chat ID (defaults to OWNER)
 */
export async function sendTelegram(message, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) {
    log.warn('Telegram not configured — skipping send');
    return null;
  }

  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;
  if (!recipient) {
    log.warn('No Telegram chat ID configured — skipping send');
    return null;
  }

  // Telegram has a 4096 char limit per message. Split if needed.
  const chunks = splitMessage(message, 4000);

  for (const chunk of chunks) {
    await rateLimited('telegram', async () => {
      try {
        const result = await retry(async () => {
          return axios.post(`${TELEGRAM_API_BASE}/sendMessage`, {
            chat_id: recipient,
            text: chunk,
            parse_mode: 'HTML',
          });
        }, {
          retries: 2,
          label: 'Telegram send',
          shouldRetry: (err) => {
            const status = err.response?.status;
            if (status === 400) return false; // Don't retry HTML parse errors
            return !status || status === 429 || status >= 500;
          },
        });

        recordCost({ platform: 'telegram', workflow: 'telegram', costCentsOverride: 0 });
        log.debug('Telegram sent', { messageId: result.data?.result?.message_id, to: recipient });
        return result.data;
      } catch (htmlError) {
        // If HTML parsing failed (400), retry without parse_mode
        if (htmlError.response?.status === 400) {
          log.debug('Telegram HTML parse failed, retrying without parse_mode', { to: recipient });
          const fallback = await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, {
            chat_id: recipient,
            text: chunk,
          });
          recordCost({ platform: 'telegram', workflow: 'telegram', costCentsOverride: 0 });
          return fallback.data;
        }
        throw htmlError;
      }
    });
  }
}

/**
 * Send an alert with emoji status indicators.
 */
export async function sendAlert(level, title, body) {
  const emoji = { critical: '🚨', warning: '⚠️', info: 'ℹ️', success: '✅' }[level] || 'ℹ️';
  const message = `${emoji} <b>${title}</b>\n\n${body}`;
  return sendTelegram(message);
}

/**
 * Send the morning briefing.
 */
export async function sendMorningBriefing(briefing) {
  const message = [
    `📊 <b>Morning Intelligence Briefing</b>`,
    `${briefing.date}`,
    ``,
    `<b>Health Score: ${briefing.healthScore}/10</b> ${briefing.healthEmoji}`,
    ``,
    `🔴 <b>Top Urgent Items:</b>`,
    ...briefing.urgentItems.map((item, i) => `${i + 1}. ${item}`),
    ``,
    `📈 <b>Performance Highlights:</b>`,
    ...briefing.highlights.map(h => `• ${h}`),
    ``,
    `📉 <b>Issues Requiring Attention:</b>`,
    ...briefing.issues.map(h => `• ${h}`),
    ``,
    `📋 <b>Today's Tasks:</b>`,
    ...briefing.todayTasks.map(t => `• ${t}`),
    ``,
    `⏰ <b>Overdue:</b>`,
    ...(briefing.overdueTasks.length > 0 ? briefing.overdueTasks.map(t => `• ${t}`) : ['None - great job!']),
    ``,
    `💰 <b>Budget Pacing:</b> ${briefing.budgetSummary}`,
    ``,
    `🔗 Dashboard: ${briefing.dashboardLink || 'N/A'}`,
  ].join('\n');

  return sendTelegram(message);
}

/**
 * Send approval request and return a reference ID.
 */
export async function sendApprovalRequest(action) {
  const message = [
    `🔐 <b>Approval Required</b>`,
    ``,
    `<b>Action:</b> ${action.description}`,
    `<b>Client:</b> ${action.clientName}`,
    `<b>Platform:</b> ${action.platform}`,
    `<b>Impact:</b> ${action.impact}`,
    ``,
    `<b>Details:</b>`,
    action.details,
    ``,
    `Reply with:`,
    `✅ <b>APPROVE ${action.id}</b> - Execute this action`,
    `❌ <b>DENY ${action.id}</b> - Cancel this action`,
    `❓ <b>DETAILS ${action.id}</b> - Get more information`,
  ].join('\n');

  await sendTelegram(message);
  return action.id;
}

/**
 * Set up the webhook for Telegram Bot API.
 * Call this once during setup to point Telegram to your server.
 * @param {string} webhookUrl - Your public server URL (e.g. https://yourdomain.com/webhook/telegram)
 */
export async function setWebhook(webhookUrl) {
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  const result = await axios.post(`${TELEGRAM_API_BASE}/setWebhook`, {
    url: webhookUrl,
    allowed_updates: ['message'],
  });
  log.info('Telegram webhook set', { url: webhookUrl, ok: result.data?.ok });
  return result.data;
}

/**
 * Get bot info — useful for getting your bot's username and verifying the token works.
 */
export async function getMe() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  const result = await axios.get(`${TELEGRAM_API_BASE}/getMe`);
  return result.data?.result;
}

/**
 * Send a typing action indicator via Telegram.
 */
export async function sendTypingAction(chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;
  try {
    await axios.post(`${TELEGRAM_API_BASE}/sendChatAction`, { chat_id: recipient, action: 'typing' });
  } catch (e) {
    log.debug('Failed to send typing action', { error: e.message });
  }
}

/**
 * Send a "thinking" message with typing indicator.
 */
export async function sendThinkingMessage(chatId, message) {
  await sendTypingAction(chatId);
  const text = message || 'Give me a moment... I\'m working on this for you.';
  return sendTelegram(text, chatId);
}

/**
 * Send a Telegram photo via multipart upload (download URL → upload buffer).
 * Falls back to URL-based, then text.
 */
export async function sendTelegramPhoto(photoUrl, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  // Try 1: Download → multipart upload (most reliable — works with auth/redirect URLs)
  try {
    const response = await axios.get(photoUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const buffer = Buffer.from(response.data);
    if (buffer.length < 100) throw new Error(`Photo buffer too small (${buffer.length} bytes)`);

    await rateLimited('telegram', async () => {
      return retry(async () => {
        const form = new FormData();
        form.append('chat_id', recipient);
        form.append('photo', buffer, { filename: `photo-${Date.now()}.jpg`, contentType: response.headers['content-type'] || 'image/jpeg' });
        if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

        const result = await axios.post(`${TELEGRAM_API_BASE}/sendPhoto`, form, { headers: form.getHeaders() });
        log.debug('Telegram photo sent via multipart upload', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram photo send (multipart)' });
    });
    return;
  } catch (uploadError) {
    log.warn('Telegram multipart photo upload failed, trying URL-based', { error: uploadError.message });
  }

  // Try 2: URL-based (Telegram fetches the URL)
  try {
    await rateLimited('telegram', async () => {
      return retry(async () => {
        const result = await axios.post(`${TELEGRAM_API_BASE}/sendPhoto`, {
          chat_id: recipient,
          photo: photoUrl,
          ...(caption ? { caption, parse_mode: 'HTML' } : {}),
        });
        log.debug('Telegram photo sent via URL', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram photo send (URL)' });
    });
  } catch (error) {
    log.warn('Telegram photo send failed completely, falling back to text URL', { error: error.message });
    await sendTelegram(`${caption ? `${caption}\n` : ''}${photoUrl}`, chatId);
  }
}

/**
 * Send a Telegram photo using a pre-downloaded buffer (skips download step).
 */
export async function sendTelegramPhotoBuffer(buffer, mimeType, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  await rateLimited('telegram', async () => {
    return retry(async () => {
      const form = new FormData();
      form.append('chat_id', recipient);
      form.append('photo', buffer, { filename: `photo-${Date.now()}.jpg`, contentType: mimeType || 'image/jpeg' });
      if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

      const result = await axios.post(`${TELEGRAM_API_BASE}/sendPhoto`, form, { headers: form.getHeaders() });
      log.debug('Telegram photo sent via buffer upload', { to: recipient });
      return result.data;
    }, { retries: 2, label: 'Telegram photo send (buffer)' });
  });
}

/**
 * Send a Telegram video via multipart upload (download URL → upload buffer).
 * Falls back to URL-based, then text.
 */
export async function sendTelegramVideo(videoUrl, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  // Try 1: Download → multipart upload
  try {
    const response = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const buffer = Buffer.from(response.data);
    if (buffer.length < 100) throw new Error(`Video buffer too small (${buffer.length} bytes)`);

    await rateLimited('telegram', async () => {
      return retry(async () => {
        const form = new FormData();
        form.append('chat_id', recipient);
        form.append('video', buffer, { filename: `video-${Date.now()}.mp4`, contentType: response.headers['content-type'] || 'video/mp4' });
        if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

        const result = await axios.post(`${TELEGRAM_API_BASE}/sendVideo`, form, { headers: form.getHeaders() });
        log.debug('Telegram video sent via multipart upload', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram video send (multipart)' });
    });
    return;
  } catch (uploadError) {
    log.warn('Telegram multipart video upload failed, trying URL-based', { error: uploadError.message });
  }

  // Try 2: URL-based
  try {
    await rateLimited('telegram', async () => {
      return retry(async () => {
        const result = await axios.post(`${TELEGRAM_API_BASE}/sendVideo`, {
          chat_id: recipient,
          video: videoUrl,
          ...(caption ? { caption, parse_mode: 'HTML' } : {}),
        });
        log.debug('Telegram video sent via URL', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram video send (URL)' });
    });
  } catch (error) {
    log.warn('Telegram video send failed completely, falling back to text URL', { error: error.message });
    await sendTelegram(`${caption ? `${caption}\n` : ''}${videoUrl}`, chatId);
  }
}

/**
 * Send a Telegram video using a pre-downloaded buffer (skips download step).
 */
export async function sendTelegramVideoBuffer(buffer, mimeType, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  await rateLimited('telegram', async () => {
    return retry(async () => {
      const form = new FormData();
      form.append('chat_id', recipient);
      form.append('video', buffer, { filename: `video-${Date.now()}.mp4`, contentType: mimeType || 'video/mp4' });
      if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

      const result = await axios.post(`${TELEGRAM_API_BASE}/sendVideo`, form, { headers: form.getHeaders() });
      log.debug('Telegram video sent via buffer upload', { to: recipient });
      return result.data;
    }, { retries: 2, label: 'Telegram video send (buffer)' });
  });
}

/**
 * Send a Telegram document via multipart upload (download URL → upload buffer).
 * Falls back to URL-based, then text.
 */
export async function sendTelegramDocument(documentUrl, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  // Try 1: Download → multipart upload
  try {
    const response = await axios.get(documentUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const buffer = Buffer.from(response.data);
    if (buffer.length < 100) throw new Error(`Document buffer too small (${buffer.length} bytes)`);
    // Infer filename from URL or content-disposition
    const urlFilename = documentUrl.split('/').pop()?.split('?')[0] || 'document';
    const contentType = response.headers['content-type'] || 'application/octet-stream';

    await rateLimited('telegram', async () => {
      return retry(async () => {
        const form = new FormData();
        form.append('chat_id', recipient);
        form.append('document', buffer, { filename: urlFilename, contentType });
        if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

        const result = await axios.post(`${TELEGRAM_API_BASE}/sendDocument`, form, { headers: form.getHeaders() });
        log.debug('Telegram document sent via multipart upload', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram document send (multipart)' });
    });
    return;
  } catch (uploadError) {
    log.warn('Telegram multipart document upload failed, trying URL-based', { error: uploadError.message });
  }

  // Try 2: URL-based
  try {
    await rateLimited('telegram', async () => {
      return retry(async () => {
        const result = await axios.post(`${TELEGRAM_API_BASE}/sendDocument`, {
          chat_id: recipient,
          document: documentUrl,
          ...(caption ? { caption, parse_mode: 'HTML' } : {}),
        });
        log.debug('Telegram document sent via URL', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'Telegram document send (URL)' });
    });
  } catch (error) {
    log.warn('Telegram document send failed completely, falling back to text URL', { error: error.message });
    await sendTelegram(`${caption ? `${caption}\n` : ''}${documentUrl}`, chatId);
  }
}

/**
 * Send a Telegram document using a pre-downloaded buffer (skips download step).
 * Use when you already have the bytes (e.g. exported PDF from Google Docs).
 */
export async function sendTelegramDocumentBuffer(buffer, mimeType, filename, caption, chatId) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;
  const recipient = chatId || config.TELEGRAM_OWNER_CHAT_ID;

  await rateLimited('telegram', async () => {
    return retry(async () => {
      const form = new FormData();
      form.append('chat_id', recipient);
      form.append('document', buffer, { filename: filename || 'document.pdf', contentType: mimeType || 'application/pdf' });
      if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }

      const result = await axios.post(`${TELEGRAM_API_BASE}/sendDocument`, form, { headers: form.getHeaders() });
      log.debug('Telegram document sent via buffer upload', { to: recipient });
      return result.data;
    }, { retries: 2, label: 'Telegram document send (buffer)' });
  });
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Split at last newline within limit
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

export default { sendTelegram, sendTelegramPhoto, sendTelegramPhotoBuffer, sendTelegramVideo, sendTelegramVideoBuffer, sendTelegramDocument, sendTelegramDocumentBuffer, sendAlert, sendMorningBriefing, sendApprovalRequest, setWebhook, getMe, sendTypingAction, sendThinkingMessage };
