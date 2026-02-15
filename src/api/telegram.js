import axios from 'axios';
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
      return retry(async () => {
        const result = await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, {
          chat_id: recipient,
          text: chunk,
          parse_mode: 'HTML',
        });

        recordCost({
          platform: 'telegram',
          workflow: 'telegram',
          costCentsOverride: 0, // Telegram Bot API is free
        });

        log.debug('Telegram sent', { messageId: result.data?.result?.message_id, to: recipient });
        return result.data;
      }, {
        retries: 3,
        label: 'Telegram send',
      });
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

export default { sendTelegram, sendAlert, sendMorningBriefing, sendApprovalRequest, setWebhook, getMe };
