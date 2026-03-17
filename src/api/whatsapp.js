import axios from 'axios';
import FormData from 'form-data';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';

const log = logger.child({ platform: 'whatsapp' });

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Check if a WhatsApp API error is retryable.
 * Non-retryable: re-engagement (131047), invalid recipient, template errors.
 */
function isRetryableWhatsAppError(error) {
  const status = error.response?.status;
  const data = error.response?.data?.error;
  const code = data?.code;

  // Non-retryable WhatsApp-specific errors
  if (code === 131047) return false; // Re-engagement: user hasn't messaged in 24h
  if (code === 131026) return false; // Message undeliverable (invalid number)
  if (code === 131021) return false; // Recipient not on WhatsApp
  if (code === 131009) return false; // Parameter missing/invalid
  if (code === 131051) return false; // Unsupported message type
  if (code === 131053) return false; // Media download/upload error (permanent)
  if (status === 400) return false;  // Bad request (won't change on retry)
  if (status === 401) return false;  // Unauthorized

  // Retryable: rate limits, server errors, network errors
  if (status === 429) return true;
  if (status >= 500) return true;
  if (!error.response) return true; // Network error
  return false;
}

/**
 * Check if a WhatsApp error is a re-engagement error (131047).
 * This means the user hasn't messaged in 24h and free-form messages are blocked.
 */
function isReEngagementError(error) {
  return error.response?.data?.error?.code === 131047;
}

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
    try {
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
          shouldRetry: isRetryableWhatsAppError,
        });
      });
    } catch (e) {
      if (isReEngagementError(e)) {
        // 131047: user hasn't messaged in 24h — WhatsApp blocks free-form messages.
        // Log as warning (not error) and don't throw — Telegram fallback in dual() handles delivery.
        log.warn('WhatsApp re-engagement blocked (24h window expired), message not delivered via WhatsApp', { to: recipient });
        return; // Skip remaining chunks — all will fail with same error
      }
      throw e;
    }
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

/**
 * Send a "thinking" message to indicate Sofia is working on something.
 */
export async function sendThinkingMessage(to, message) {
  const text = message || 'Give me a moment... I\'m working on this for you.';
  return sendWhatsApp(text, to);
}

/**
 * Upload media (image/video) directly to WhatsApp's servers and get a media_id.
 * This is the most reliable way to send media — avoids URL fetching issues.
 *
 * @param {Buffer} buffer - The media binary data
 * @param {string} mimeType - MIME type (e.g. 'image/png', 'video/mp4')
 * @param {string} [fileName] - Filename for the upload
 * @returns {string} The WhatsApp media_id
 */
export async function uploadWhatsAppMedia(buffer, mimeType, fileName) {
  return rateLimited('whatsapp', () =>
    retry(async () => {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('file', buffer, { filename: fileName || 'media.png', contentType: mimeType });

      const response = await axios.post(
        `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/media`,
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` } }
      );

      log.debug('WhatsApp media uploaded', { mediaId: response.data.id });
      return response.data.id;
    }, { retries: 2, label: 'WhatsApp media upload' })
  );
}

/**
 * Download an image from a URL, upload it directly to WhatsApp's servers,
 * and send it as a native image message (like a person sending a photo).
 *
 * @param {string} imageUrl - URL to download the image from
 * @param {string} [caption] - Optional caption
 * @param {string} [to] - Recipient (defaults to owner)
 */
export async function sendWhatsAppImageDirect(imageUrl, caption, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;

  // Step 1: Download the image
  const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(imageResponse.data);
  const mimeType = imageResponse.headers['content-type'] || 'image/png';

  // Step 2: Upload to WhatsApp Media API
  const mediaId = await uploadWhatsAppMedia(buffer, mimeType, `image-${Date.now()}.png`);

  // Step 3: Send message referencing the uploaded media
  await rateLimited('whatsapp', () =>
    retry(async () => {
      const result = await axios.post(
        `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'image',
          image: { id: mediaId, ...(caption ? { caption } : {}) },
        },
        { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      recordCost({ platform: 'whatsapp-cloud', workflow: 'whatsapp-media', costCentsOverride: 0.5 });
      log.debug('WhatsApp image sent via direct upload', { to: recipient, mediaId });
      return result.data;
    }, { retries: 2, label: 'WhatsApp image send (direct)', shouldRetry: isRetryableWhatsAppError })
  );
}

/**
 * Send a WhatsApp image message via Meta Cloud API.
 * Tries direct upload first (download → upload to WhatsApp → send with media_id).
 * Falls back to link-based delivery, then to text.
 */
export async function sendWhatsAppImage(imageUrl, caption, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;

  // Try direct upload first (most reliable — sends like a normal person's photo)
  try {
    await sendWhatsAppImageDirect(imageUrl, caption, to);
    return;
  } catch (directError) {
    log.warn('WhatsApp direct image upload failed, trying link-based', { error: directError.message });
  }

  // Fallback: link-based delivery (WhatsApp servers fetch the URL)
  try {
    await rateLimited('whatsapp', async () => {
      return retry(async () => {
        const result = await axios.post(
          `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'image',
            image: { link: imageUrl, ...(caption ? { caption } : {}) },
          },
          { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        recordCost({ platform: 'whatsapp-cloud', workflow: 'whatsapp-media', costCentsOverride: 0.5 });
        log.debug('WhatsApp image sent via link', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'WhatsApp image send (link)', shouldRetry: isRetryableWhatsAppError });
    });
  } catch (linkError) {
    log.warn('WhatsApp image send failed completely', { error: linkError.message, url: imageUrl?.slice(0, 100) });
    await sendWhatsApp(`${caption ? `${caption}\n` : ''}[Image could not be delivered. Please try again.]`, to);
  }
}

/**
 * Send a WhatsApp video message via Meta Cloud API.
 */
export async function sendWhatsAppVideo(videoUrl, caption, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;
  try {
    await rateLimited('whatsapp', async () => {
      return retry(async () => {
        const result = await axios.post(
          `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'video',
            video: { link: videoUrl, ...(caption ? { caption } : {}) },
          },
          { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        recordCost({ platform: 'whatsapp-cloud', workflow: 'whatsapp-media', costCentsOverride: 0.5 });
        log.debug('WhatsApp video sent', { to: recipient });
        return result.data;
      }, { retries: 2, label: 'WhatsApp video send', shouldRetry: isRetryableWhatsAppError });
    });
  } catch (error) {
    log.warn('WhatsApp video send failed, falling back to text URL', { error: error.message });
    await sendWhatsApp(`${caption ? `${caption}\n` : ''}${videoUrl}`, to);
  }
}

/**
 * Send a WhatsApp document message via Meta Cloud API.
 */
export async function sendWhatsAppDocument(documentUrl, filename, caption, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;
  try {
    await rateLimited('whatsapp', async () => {
      return retry(async () => {
        const result = await axios.post(
          `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'document',
            document: { link: documentUrl, filename: filename || 'document.pdf', ...(caption ? { caption } : {}) },
          },
          { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        recordCost({ platform: 'whatsapp-cloud', workflow: 'whatsapp-media', costCentsOverride: 0.5 });
        log.debug('WhatsApp document sent', { to: recipient, filename });
        return result.data;
      }, { retries: 2, label: 'WhatsApp document send', shouldRetry: isRetryableWhatsAppError });
    });
  } catch (error) {
    log.warn('WhatsApp document send failed, falling back to text URL', { error: error.message });
    await sendWhatsApp(`${caption ? `${caption}\n` : ''}${documentUrl}`, to);
  }
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

export default { sendWhatsApp, sendWhatsAppImage, sendWhatsAppImageDirect, sendWhatsAppVideo, sendWhatsAppDocument, uploadWhatsAppMedia, sendAlert, sendMorningBriefing, sendApprovalRequest, sendThinkingMessage };
