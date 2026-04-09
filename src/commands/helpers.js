/**
 * Shared helpers, utilities, and state for the WhatsApp/Telegram server.
 * Extracted from whatsapp-server.js to reduce file size and improve maintainability.
 */
import { sendWhatsApp, sendThinkingMessage as sendWhatsAppThinking, sendWhatsAppImage, uploadWhatsAppMedia } from '../api/whatsapp.js';
import { sendTelegram, sendThinkingMessage as sendTelegramThinking, sendTelegramPhoto, sendTelegramPhotoBuffer, sendTelegramVideo, sendTelegramVideoBuffer, sendTelegramDocumentBuffer } from '../api/telegram.js';
import { sendWhatsAppVideo, sendWhatsAppDocumentBuffer } from '../api/whatsapp.js';
import {
  getContactByPhone, createContact,
  getPendingClientByToken, getPendingClientByTokenAny,
  saveMessage, getMessages, clearMessages,
  createPendingClient,
} from '../services/knowledge-base.js';
import { getClientContextByPhone } from '../services/client-onboarding-flow.js';
import * as supabase from '../api/supabase.js';
import axios from 'axios';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ module: 'helpers' });

// --- Shared State ---
export const pendingApprovals = new Map();
export const landingPageStore = new Map();

// Clean up landing pages older than 7 days every hour
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, data] of landingPageStore) {
    if (data.createdAt < cutoff) landingPageStore.delete(id);
  }
}, 60 * 60 * 1000);

// --- Public URL Detection ---
let detectedPublicUrl = null;

export function setDetectedPublicUrl(url) {
  detectedPublicUrl = url;
}

export function getPublicUrl() {
  if (config.PUBLIC_URL) return config.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return detectedPublicUrl;
}

// --- Temporary Media Store (for passing WhatsApp images to video tools) ---
const tempMediaStore = new Map();

/**
 * Store a media buffer temporarily and return a unique ID.
 * Entries expire after 15 minutes.
 */
export function storeTempMedia(buffer, mimeType = 'image/jpeg') {
  const id = crypto.randomUUID();
  tempMediaStore.set(id, { buffer, mimeType, createdAt: Date.now() });
  // Auto-cleanup after 15 minutes
  setTimeout(() => tempMediaStore.delete(id), 15 * 60 * 1000);
  return id;
}

/**
 * Get a stored media buffer by ID.
 */
export function getTempMedia(id) {
  return tempMediaStore.get(id) || null;
}

/**
 * Get a public URL for a stored temp media item.
 */
export function getTempMediaUrl(id) {
  const base = getPublicUrl();
  if (!base) return null;
  return `${base}/media/temp/${id}`;
}

// Clean up expired temp media every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, data] of tempMediaStore) {
    if (data.createdAt < cutoff) tempMediaStore.delete(id);
  }
}, 5 * 60 * 1000);

// --- Tool Execution Config ---
export const SLOW_TOOL_TIMEOUT_MS = 8 * 60 * 1000;
export const DEFAULT_TOOL_TIMEOUT_MS = 2 * 60 * 1000;
export const SLOW_TOOLS = new Set(['generate_ad_images', 'generate_ad_video', 'generate_creative_package', 'create_presentation', 'generate_weekly_report', 'preview_landing_page', 'generate_video_from_image', 'generate_ad_creative_with_text', 'extract_brand_dna', 'update_brand_dna', 'generate_pdf_report']);

export const TOOL_PROGRESS_MESSAGES = {
  generate_pdf_report: 'Generating your PDF report... This might take a minute.',
  generate_ad_images: 'Generating your ad images... This might take a minute.',
  generate_ad_video: 'Creating your video... This will take a few minutes.',
  generate_creative_package: 'Building your creative package... This will take a few minutes.',
  browse_website: 'Browsing the website...',
  search_ad_library: 'Searching the ad library...',
  get_page_ads: 'Looking up ads for this page...',
  search_google_ads_transparency: 'Searching Google ads...',
  analyze_serp: 'Analyzing search results...',
  get_domain_overview: 'Analyzing the domain...',
  find_seo_competitors: 'Finding SEO competitors...',
  audit_landing_page: 'Auditing the landing page...',
  audit_seo_page: 'Running SEO audit...',
  get_search_volume: 'Researching keywords...',
  get_keyword_ideas: 'Finding keyword ideas...',
  get_keyword_planner_volume: 'Researching keyword volumes...',
  get_keyword_planner_ideas: 'Finding keyword opportunities...',
  create_presentation: 'Building your presentation...',
  generate_weekly_report: 'Generating the weekly report...',
  generate_campaign_brief: 'Creating the campaign brief...',
  run_competitor_analysis: 'Analyzing competitors...',
  preview_landing_page: 'Publishing your landing page and generating a visual preview...',
  get_clickup_tasks: 'Pulling up ClickUp tasks...',
  get_clickup_task: 'Getting task details from ClickUp...',
  get_clickup_workspace: 'Loading ClickUp workspace...',
  create_clickup_task: 'Creating task in ClickUp...',
  update_clickup_task: 'Updating task in ClickUp...',
  check_overdue_tasks: 'Checking for overdue tasks...',
  get_daily_standup: 'Generating standup report...',
};

// --- Token Regex ---
export const TOKEN_RE_START = /^\/start\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{12})$/i;
export const TOKEN_RE_INLINE = /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{12})\b/i;

// --- Message Deduplication ---
const processedMessageIds = new Map();
const MESSAGE_DEDUP_WINDOW_MS = 5 * 60 * 1000;

export function isMessageAlreadyProcessed(msgId) {
  if (!msgId) return false;
  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.set(msgId, Date.now());
  return false;
}

setInterval(() => {
  const cutoff = Date.now() - MESSAGE_DEDUP_WINDOW_MS;
  for (const [id, ts] of processedMessageIds) {
    if (ts < cutoff) processedMessageIds.delete(id);
  }
}, 10 * 60 * 1000);

// --- Thinking Indicator ---
export async function sendThinkingIndicator(channel, chatId, message) {
  try {
    if (channel === 'telegram') {
      await sendTelegramThinking(chatId, message);
    } else {
      await sendWhatsAppThinking(chatId, message);
    }
  } catch (e) {
    log.warn('Failed to send thinking indicator', { error: e.message, channel, chatId });
  }
}

// --- WhatsApp Native Image Send ---
export async function sendWhatsAppImageNative(imageBuffer, mimeType, url, caption, chatId) {
  const effectiveMime = mimeType || 'image/png';
  const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const ext = extMap[effectiveMime] || '.png';

  try {
    if (imageBuffer) {
      if (!Buffer.isBuffer(imageBuffer)) {
        throw new Error(`Expected Buffer, got ${typeof imageBuffer}`);
      }
      if (imageBuffer.length < 100) {
        throw new Error(`Image buffer too small (${imageBuffer.length} bytes) — likely corrupt or empty`);
      }

      log.info('Uploading image buffer to WhatsApp Media API', { bufferSize: imageBuffer.length, mimeType: effectiveMime, to: chatId });
      const mediaId = await uploadWhatsAppMedia(imageBuffer, effectiveMime, `image-${Date.now()}${ext}`);

      await rateLimited('whatsapp', () =>
        retry(async () => {
          await axios.post(
            `https://graph.facebook.com/v22.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: chatId,
              type: 'image',
              image: { id: mediaId, ...(caption ? { caption } : {}) },
            },
            { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
          );
        }, { retries: 2, label: 'WhatsApp image send (native)', shouldRetry: isRetryableHttpError })
      );
      log.info('WhatsApp image sent via native upload', { to: chatId, mediaId });
    } else {
      await sendWhatsAppImage(url, caption, chatId);
    }
  } catch (e) {
    log.warn('WhatsApp native image send failed, trying URL fallback', { error: e.message, url: url?.slice(0, 80) });
    try {
      await sendWhatsAppImage(url, caption, chatId);
    } catch (e2) {
      throw new Error(`All image delivery failed: native=${e.message}, url=${e2.message}`);
    }
  }
}

// --- JSON Helpers ---
export function stripBinaryBuffers(key, value) {
  if (key === '_imageBuffers' || key === '_pdfBuffer' || key === '_screenshotBuffer') return undefined;
  return value;
}

const MAX_TOOL_RESULT_CHARS = 12000;
export function truncateToolResult(resultJson) {
  if (resultJson.length <= MAX_TOOL_RESULT_CHARS) return resultJson;
  return resultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '... [truncated — result was ' + resultJson.length + ' chars. Key data shown above. Ask for specific details if needed.]';
}

// --- Conversation History ---
const MAX_HISTORY_MESSAGES = 20;
export { MAX_HISTORY_MESSAGES };

export function getHistory(chatId) {
  return getMessages(chatId, MAX_HISTORY_MESSAGES * 2);
}

export function addToHistory(chatId, role, content, channel = 'whatsapp') {
  saveMessage(chatId, channel, role, content);
}

export function clearHistory(chatId) {
  clearMessages(chatId);
}

export function sanitizeMessages(messages) {
  if (!messages || messages.length === 0) return [];

  const cleaned = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    if (!role || !content) continue;

    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === role) {
      const prev = cleaned[cleaned.length - 1];
      // Only merge if BOTH are plain strings — never merge multimodal content arrays
      if (typeof prev.content === 'string' && typeof content === 'string') {
        prev.content = `${prev.content}\n${content}`;
      } else {
        // Can't merge multimodal content — keep as separate message
        // (Claude requires alternating roles, so wrap in a combined array)
        if (Array.isArray(prev.content) && Array.isArray(content)) {
          prev.content = [...prev.content, ...content];
        } else if (Array.isArray(prev.content) && typeof content === 'string') {
          prev.content = [...prev.content, { type: 'text', text: content }];
        } else if (typeof prev.content === 'string' && Array.isArray(content)) {
          prev.content = [{ type: 'text', text: prev.content }, ...content];
        } else {
          prev.content = content;
        }
      }
    } else {
      cleaned.push({ role, content });
    }
  }

  while (cleaned.length > 0 && cleaned[0].role !== 'user') {
    cleaned.shift();
  }

  return cleaned;
}

// --- Tool Result Summarizer ---
export function summarizeToolDeliverables(toolResults) {
  const lines = [];
  for (const result of toolResults) {
    try {
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      const data = JSON.parse(content);
      if (data.error) continue;

      if (data.presentationUrl) lines.push(`Presentation: ${data.presentationUrl}`);
      if (data.sheetUrl) lines.push(`Data sheet: ${data.sheetUrl}`);
      if (data.imageUrls?.length) lines.push(`Generated ${data.imageUrls.length} images`);
      if (data.textAdsCount) lines.push(`Generated ${data.textAdsCount} ad copy variations`);
      if (data.textAdPreview?.length) {
        lines.push(`Ad preview: ${data.textAdPreview.map(a => `"${a.headline}" [${a.cta}]`).join(' | ')}`);
      }
      if (data.videosCount) lines.push(`Generated ${data.videosCount} video(s)`);
      if (data.videoUrl) lines.push(`Video: ${data.videoUrl}`);

      if (data.ads?.length && !data.textAdsCount) {
        lines.push(`Generated ${data.ads.length} ad copy variations`);
        const preview = data.ads.slice(0, 3).map(a => `"${a.headline}" [${a.cta}]`).join(' | ');
        if (preview) lines.push(`Ad preview: ${preview}`);
      }

      if (data.images?.length && !data.imageUrls) {
        const ok = data.images.filter(i => !i.error);
        if (ok.length) lines.push(`Generated ${ok.length} images: ${ok.map(i => i.label || i.format).join(', ')}`);
      }

      if (data.keywords?.length) lines.push(`Found ${data.keywords.length} keywords`);
      if (data.results?.length) lines.push(`Returned ${data.results.length} results`);
      if (data.competitors?.length) lines.push(`Analyzed ${data.competitors.length} competitors`);

      if (data.summary && typeof data.summary === 'string') lines.push(`Summary: ${data.summary.slice(0, 300)}`);
      if (data.message && typeof data.message === 'string' && !lines.length) lines.push(data.message.slice(0, 300));
    } catch (e) {
      // Skip unparseable results
    }
  }
  return lines.length ? lines.join('\n') : '';
}

// --- Cross-Channel Linking ---
export function tryLinkCrossChannel(token, chatId, channel) {
  const pending = getPendingClientByTokenAny(token);
  if (!pending || !pending.chat_id) return null;

  const existingContact = getContactByPhone(pending.chat_id);
  if (!existingContact?.client_id) return null;

  try {
    createContact({
      phone: chatId,
      name: existingContact.name,
      email: existingContact.email,
      clientId: existingContact.client_id,
      channel,
    });
    log.info('Cross-channel link created', {
      clientId: existingContact.client_id,
      existingChatId: pending.chat_id,
      newChatId: chatId,
      channel,
    });
  } catch (e) {
    log.info('Cross-channel contact already exists', { chatId, channel });
  }

  return getClientContextByPhone(chatId);
}

// --- Pending Client with Supabase Fallback ---
export async function getPendingClientWithFallback(token) {
  const local = getPendingClientByToken(token);
  if (local) return local;

  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!UUID_RE.test(token)) return null;

  try {
    const submission = await supabase.getOnboardingSubmission(token);
    if (!submission) return null;

    createPendingClient(submission);
    log.info('Created local pending client from Supabase submission', { token });

    return getPendingClientByToken(token);
  } catch (error) {
    log.error('Supabase fallback failed', { token, error: error.message });
    return null;
  }
}

// --- Media Delivery ---
async function safeSendMedia(sendFn, url, caption, toolName) {
  try {
    await sendFn(url, caption);
  } catch (e) {
    log.warn('Failed to deliver media item', { error: e.message, toolName, url: url?.slice(0, 100) });
  }
}

export async function deliverMediaInline(toolName, result, channel, chatId) {
  try {
    const sendImage = (url, caption) =>
      channel === 'telegram' ? sendTelegramPhoto(url, caption, chatId) : sendWhatsAppImage(url, caption, chatId);
    const sendVideo = (url, caption) =>
      channel === 'telegram' ? sendTelegramVideo(url, caption, chatId) : sendWhatsAppVideo(url, caption, chatId);

    async function deliverImageWithBuffer(bufferObj, deliveryUrl, caption) {
      const hasHttpUrl = deliveryUrl && !deliveryUrl.startsWith('data:');

      if (channel === 'whatsapp') {
        let sent = false;
        if (bufferObj?.buffer) {
          try {
            await sendWhatsAppImageNative(bufferObj.buffer, bufferObj.mimeType, deliveryUrl, caption, chatId);
            sent = true;
          } catch (e) {
            log.warn('Native WhatsApp image delivery failed', { error: e.message });
          }
        }
        if (!sent && hasHttpUrl) {
          try {
            await sendWhatsAppImage(deliveryUrl, caption, chatId);
            sent = true;
          } catch (e) {
            log.warn('WhatsApp URL image delivery also failed', { error: e.message });
          }
        }
        if (!sent) log.warn('No WhatsApp delivery method succeeded', { hasBuffer: !!bufferObj?.buffer, hasHttpUrl });
        return sent;
      } else {
        if (bufferObj?.buffer) {
          try {
            await sendTelegramPhotoBuffer(bufferObj.buffer, bufferObj.mimeType, caption, chatId);
            return true;
          } catch (e) {
            log.warn('Telegram buffer photo delivery failed, trying URL', { error: e.message });
          }
        }
        if (hasHttpUrl) {
          await safeSendMedia(sendImage, deliveryUrl, caption, toolName);
          return true;
        }
        log.warn('No Telegram delivery method available', { hasBuffer: !!bufferObj?.buffer, hasHttpUrl });
        return false;
      }
    }

    // Generated ad images (both generate_ad_images and generate_ad_creative_with_text)
    if ((toolName === 'generate_ad_images' || toolName === 'generate_ad_creative_with_text') && result.images) {
      const hasBuffers = result._imageBuffers?.some(b => b?.buffer);
      const deliverableImages = result.images.filter((img, idx) => {
        if (img.error) return false;
        if (result._imageBuffers?.[idx]?.buffer) return true;
        if (img.url || img.deliveryUrl) return true;
        return false;
      });
      log.info('Delivering ad images inline', { total: result.images.length, deliverable: deliverableImages.length, hasBuffers, channel });

      let deliveredCount = 0;
      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const bufferObj = result._imageBuffers?.[i];
        if (img.error) continue;
        if (!bufferObj?.buffer && !img.url && !img.deliveryUrl) continue;
        const caption = img.label || img.format || 'Ad image';
        const deliveryUrl = img.deliveryUrl || img.url;

        try {
          const sent = await deliverImageWithBuffer(bufferObj, deliveryUrl, caption);
          if (sent) deliveredCount++;
        } catch (e) {
          log.error('All image delivery methods failed for format', { error: e.message, format: img.format, deliveryUrl: deliveryUrl?.slice(0, 80) });
        }
      }

      if (deliveredCount === 0) {
        const allFailed = result.images.every(i => i.error);
        const errors = result.images.filter(i => i.error).map(i => i.error);
        log.error('Zero images delivered to user', { allFailed, deliverable: deliverableImages.length, errors });

        const driveUrl = result.images.find(i => i.driveUrl || i.driveId)?.driveUrl;
        let fallbackMsg;
        if (allFailed) {
          const errorHint = errors[0] || 'unknown error';
          fallbackMsg = `Sorry, image generation failed: ${errorHint}. Please try again.`;
        } else if (driveUrl) {
          fallbackMsg = `I generated your images but had trouble sending them here. You can view them directly: ${driveUrl}`;
        } else {
          fallbackMsg = 'I generated your images but had trouble delivering them in chat. Please try again.';
        }
        try {
          if (channel === 'whatsapp') await sendWhatsApp(fallbackMsg, chatId);
          else await sendTelegram(fallbackMsg, chatId);
        } catch (_) { /* best effort */ }
      }
    }

    // Generated ad video
    if (toolName === 'generate_ad_video' && result.videoUrl) {
      await safeSendMedia(sendVideo, result.videoUrl, `${result.duration || ''}s ${result.aspectRatio || ''} video`.trim(), toolName);
    }

    // Generated video from image (Kling / fal.ai)
    if (toolName === 'generate_video_from_image' && result.videoUrl) {
      await safeSendMedia(sendVideo, result.videoUrl, `${result.duration || ''}s ${result.aspectRatio || ''} video`.trim(), toolName);
    }

    // Creative package
    if (toolName === 'generate_creative_package' && result.imageUrls) {
      for (let i = 0; i < result.imageUrls.length; i++) {
        const url = result.imageUrls[i];
        if (!url) continue;
        const caption = 'Creative package image';
        try {
          await deliverImageWithBuffer(result._imageBuffers?.[i], url, caption);
        } catch (e) {
          log.warn('Creative package image delivery failed', { error: e.message, index: i });
        }
      }
    }

    // PDF reports (generated by pdf-report.js)
    if (toolName === 'generate_pdf_report' && result._pdfBuffer) {
      const filename = result.fileName || `${result.clientName || 'Report'} - Report.pdf`;
      const caption = result.message || filename;
      try {
        if (channel === 'whatsapp') {
          await sendWhatsAppDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        } else {
          await sendTelegramDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        }
        log.info('PDF report delivered', { toolName, filename, channel, size: result._pdfBuffer.length });
      } catch (e) {
        log.warn('PDF delivery failed, URL still in text response', { error: e.message, toolName });
      }
    }

    // Legacy PDF reports
    if ((toolName === 'generate_performance_pdf' || toolName === 'generate_competitor_pdf') && result._pdfBuffer) {
      const filename = `${result.clientName || 'Report'} - ${toolName.includes('competitor') ? 'Competitor Report' : 'Performance Report'}.pdf`;
      const caption = result.message || filename;
      try {
        if (channel === 'whatsapp') {
          await sendWhatsAppDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        } else {
          await sendTelegramDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        }
        log.info('PDF report delivered as native document', { toolName, filename, channel, size: result._pdfBuffer.length });
      } catch (e) {
        log.warn('PDF native delivery failed, URL still in text response', { error: e.message, toolName });
      }
    }

    // Presentation decks
    if ((toolName === 'build_media_plan_deck' || toolName === 'build_competitor_deck' || toolName === 'build_performance_deck' || toolName === 'create_chart_presentation') && result._pdfBuffer) {
      const filename = `${result.clientName || 'Presentation'} - Deck.pdf`;
      const caption = result.message || filename;
      try {
        if (channel === 'whatsapp') {
          await sendWhatsAppDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        } else {
          await sendTelegramDocumentBuffer(result._pdfBuffer, 'application/pdf', filename, caption, chatId);
        }
        log.info('Presentation delivered as PDF document', { toolName, filename, channel, size: result._pdfBuffer.length });
      } catch (e) {
        log.warn('Presentation PDF delivery failed, URL still in text response', { error: e.message, toolName });
      }
    }

    // Ad library search results
    if ((toolName === 'search_ad_library' || toolName === 'get_page_ads') && result.ads) {
      const adsWithSnapshots = result.ads.filter(ad => ad.snapshotUrl);
      if (adsWithSnapshots.length > 0) {
        const links = adsWithSnapshots.map((ad, i) => {
          const label = ad.pageName || ad.headline || `Ad ${i + 1}`;
          return `${i + 1}. *${label}*: ${ad.snapshotUrl}`;
        }).join('\n');
        const msg = `📎 *Ad Preview Links*\n${links}`;
        try {
          if (channel === 'whatsapp') await sendWhatsApp(msg, chatId);
          else await sendTelegram(msg, chatId);
        } catch (_) { /* best effort */ }
      }
    }

    // Google Ads Transparency
    if (toolName === 'search_google_ads_transparency' && result.creatives) {
      for (const creative of result.creatives) {
        if (!creative.previewUrl) continue;
        if (creative.format === 'VIDEO') {
          await safeSendMedia(sendVideo, creative.previewUrl, `Google Ad — ${creative.format}`, toolName);
        } else {
          await safeSendMedia(sendImage, creative.previewUrl, `Google Ad — ${creative.format || 'preview'}`, toolName);
        }
      }
    }

    // Landing page preview screenshot
    if (toolName === 'preview_landing_page' && result._screenshotBuffer) {
      const caption = `Landing Page Preview${result.name ? ` — ${result.name}` : ''}`;
      try {
        if (channel === 'whatsapp') {
          await sendWhatsAppImageNative(result._screenshotBuffer, 'image/png', null, caption, chatId);
        } else {
          await sendTelegramPhotoBuffer(result._screenshotBuffer, 'image/png', caption, chatId);
        }
        log.info('Landing page screenshot delivered', { channel, chatId });
      } catch (e) {
        log.warn('Landing page screenshot delivery failed', { error: e.message });
      }
    }
  } catch (mediaErr) {
    log.error('deliverMediaInline crashed — non-fatal', { toolName, error: mediaErr.message, stack: mediaErr.stack });
  }
}

// --- Owner Message Queue ---
let ownerMessageProcessing = false;
const ownerMessageQueue = [];
let _handleCommandFn = null;

export function setHandleCommandFn(fn) {
  _handleCommandFn = fn;
}

export async function enqueueOwnerMessage(body) {
  if (!ownerMessageProcessing) {
    ownerMessageProcessing = true;
    try {
      await _handleCommandFn(body);
    } finally {
      ownerMessageProcessing = false;
      if (ownerMessageQueue.length > 0) {
        const next = ownerMessageQueue.shift();
        enqueueOwnerMessage(next);
      }
    }
  } else {
    if (ownerMessageQueue.length < 5) {
      ownerMessageQueue.push(body);
      log.info('Owner message queued (previous still processing)', { queueLength: ownerMessageQueue.length });
    } else {
      log.warn('Owner message queue full, dropping message', { body: body.substring(0, 60) });
      await sendWhatsApp('I\'m still processing your previous messages. Please wait a moment and try again.');
    }
  }
}
