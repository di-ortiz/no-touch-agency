import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';

const log = logger.child({ platform: 'whatsapp' });

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Send a WhatsApp text message via Meta Cloud API.
 * @param {string} message - Message text (supports WhatsApp formatting: *bold*, _italic_, ```code```)
 * @param {string} [to] - Recipient number (defaults to OWNER). Use raw number without 'whatsapp:' prefix.
 */
export async function sendWhatsApp(message, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;

  // WhatsApp has a 4096 char limit per message. Split if needed.
  const chunks = splitMessage(message, 4000);

  for (const chunk of chunks) {
    await rateLimited('whatsapp', async () => {
      return retry(async () => {
        const result = await axios.post(
          `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'text',
            text: { body: chunk },
          },
          {
            headers: {
              Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );

        recordCost({
          platform: 'whatsapp-cloud',
          workflow: 'whatsapp',
          costCentsOverride: 0.5, // ~$0.005 per message (varies by country)
        });

        log.debug('WhatsApp sent', { messageId: result.data?.messages?.[0]?.id, to: recipient });
        return result.data;
      }, {
        retries: 3,
        label: 'WhatsApp send',
      });
    });
  }
}

/**
 * Send an alert with emoji status indicators.
 */
export async function sendAlert(level, title, body) {
  const emoji = { critical: '🚨', warning: '⚠️', info: 'ℹ️', success: '✅' }[level] || 'ℹ️';
  const message = `${emoji} *${title}*\n\n${body}`;
  return sendWhatsApp(message);
}

/**
 * Send the morning briefing.
 */
export async function sendMorningBriefing(briefing) {
  const message = [
    `📊 *Morning Intelligence Briefing*`,
    `${briefing.date}`,
    ``,
    `*Health Score: ${briefing.healthScore}/10* ${briefing.healthEmoji}`,
    ``,
    `🔴 *Top Urgent Items:*`,
    ...briefing.urgentItems.map((item, i) => `${i + 1}. ${item}`),
    ``,
    `📈 *Performance Highlights:*`,
    ...briefing.highlights.map(h => `• ${h}`),
    ``,
    `📉 *Issues Requiring Attention:*`,
    ...briefing.issues.map(h => `• ${h}`),
    ``,
    `📋 *Today's Tasks:*`,
    ...briefing.todayTasks.map(t => `• ${t}`),
    ``,
    `⏰ *Overdue:*`,
    ...(briefing.overdueTasks.length > 0 ? briefing.overdueTasks.map(t => `• ${t}`) : ['None - great job!']),
    ``,
    `💰 *Budget Pacing:* ${briefing.budgetSummary}`,
    ``,
    `🔗 Dashboard: ${briefing.dashboardLink || 'N/A'}`,
  ].join('\n');

  return sendWhatsApp(message);
}

/**
 * Send approval request and return a reference ID.
 */
export async function sendApprovalRequest(action) {
  const message = [
    `🔐 *Approval Required*`,
    ``,
    `*Action:* ${action.description}`,
    `*Client:* ${action.clientName}`,
    `*Platform:* ${action.platform}`,
    `*Impact:* ${action.impact}`,
    ``,
    `*Details:*`,
    action.details,
    ``,
    `Reply with:`,
    `✅ *APPROVE ${action.id}* - Execute this action`,
    `❌ *DENY ${action.id}* - Cancel this action`,
    `❓ *DETAILS ${action.id}* - Get more information`,
  ].join('\n');

  await sendWhatsApp(message);
  return action.id;
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

export default { sendWhatsApp, sendAlert, sendMorningBriefing, sendApprovalRequest };
