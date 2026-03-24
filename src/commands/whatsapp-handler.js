/**
 * WhatsApp message handlers — owner commands, client messages, approvals, media.
 * Extracted from whatsapp-server.js for maintainability.
 */
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram, sendAlert as sendTelegramAlert } from '../api/telegram.js';
import {
  getAllClients, getClient, getOnboardingSession,
  getLatestPendingClient, activatePendingClient,
  createOnboardingSession, updateOnboardingSession,
  createContact, checkClientMessageLimit,
  getContactsByClientId, getCrossChannelHistory,
} from '../services/knowledge-base.js';
import { handleOnboardingMessage, hasActiveOnboarding, getClientContextByPhone, buildPersonalizedWelcome } from '../services/client-onboarding-flow.js';
import * as metaAds from '../api/meta-ads.js';
import * as seoEngine from '../services/seo-engine.js';
import * as googleDrive from '../api/google-drive.js';
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import {
  pendingApprovals,
  TOKEN_RE_INLINE,
  sendThinkingIndicator,
  getHistory, addToHistory, clearHistory, sanitizeMessages,
  tryLinkCrossChannel, getPendingClientWithFallback,
  MAX_HISTORY_MESSAGES,
} from './helpers.js';
import { CSA_TOOLS, CLIENT_TOOL_NAMES } from './csa-tool-defs.js';
import { WHATSAPP_CSA_PROMPT, buildClientSystemPrompt } from './sofia-prompts.js';
import { runChatLoop } from './chat-loop.js';

const log = logger.child({ module: 'whatsapp-handler' });

// --- Owner Command Handler ---
export async function handleCommand(message) {
  log.info('handleCommand entered', { message: message.substring(0, 80) });
  const ownerChatId = 'whatsapp-owner'; // history key — NOT a phone number
  const ownerPhone = config.WHATSAPP_OWNER_PHONE; // actual phone number for media delivery

  // Handle approval responses first (exact format, bypass AI)
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleApproval(approvalMatch[1].toUpperCase(), approvalMatch[2]);
  }

  // Handle "clear" / "reset" / "restart" to wipe memory
  if (/^(clear|reset|restart|new chat|forget)$/i.test(message.trim())) {
    clearHistory(ownerChatId);
    return sendWhatsApp('Memory cleared! Starting fresh.');
  }

  try {
    const clients = getAllClients();
    const clientContext = clients.length > 0
      ? `\n\nCurrent managed clients: ${clients.map(c => c.name).join(', ')}`
      : '\n\nNo clients onboarded yet. You can still do ad-hoc research using search_ad_library and search_facebook_pages tools.';

    const history = getHistory(ownerChatId);
    addToHistory(ownerChatId, 'user', message);
    const messages = sanitizeMessages([...history, { role: 'user', content: message }]);

    const finalText = await runChatLoop({
      systemPrompt: WHATSAPP_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      channel: 'whatsapp',
      chatId: ownerPhone,
      historyKey: ownerChatId,
      workflow: 'whatsapp-csa',
    });
    await sendWhatsApp(finalText);
  } catch (error) {
    log.error('WhatsApp command loop failed', { error: error.message, stack: error.stack });
    const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');
    const errorHint = error.message ? error.message.substring(0, 200) : 'unknown';
    const errorMsg = isRateLimit
      ? 'I\'m currently experiencing high demand. Please wait a minute and try again.'
      : `Something went wrong while processing your request. Please try again.\n\n_Debug: ${errorHint}_`;
    addToHistory(ownerChatId, 'assistant', errorMsg);
    try {
      await sendWhatsApp(errorMsg);
    } catch (sendErr) {
      log.error('CRITICAL: Cannot send ANY WhatsApp message (owner handler)', {
        originalError: error.message,
        sendError: sendErr.message,
        sendStatus: sendErr.response?.status,
        sendDetail: sendErr.response?.data?.error?.message,
      });
    }
  }
}

// --- WhatsApp Approval Handler ---
export async function handleApproval(action, approvalId) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return sendWhatsApp(`❌ Approval "${approvalId}" not found or expired.`);
  }

  if (action === 'DENY') {
    pendingApprovals.delete(approvalId);
    return sendWhatsApp(`❌ Action denied and cancelled.`);
  }

  if (action === 'DETAILS') {
    return sendWhatsApp(`📋 *Action Details:*\n${JSON.stringify(pending, null, 2)}`);
  }

  // APPROVE
  try {
    if (pending.type === 'pause' && pending.platform === 'meta') {
      await metaAds.pauseCampaign(pending.campaignId);
      pendingApprovals.delete(approvalId);
      return sendWhatsApp(`✅ Campaign ${pending.campaignId} paused on Meta.`);
    }

    if (pending.type === 'publish_blog') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp) {
        pendingApprovals.delete(approvalId);
        return sendWhatsApp(`❌ WordPress is not connected for ${pending.clientName}. The blog post is available in your Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''} — you can post it manually.`);
      }
      const { postData } = pending;
      const wpPost = await wp.createPost({
        title: postData.title, content: postData.content, excerpt: postData.excerpt,
        slug: postData.slug, status: postData.publishDate ? 'future' : 'publish', date: postData.publishDate,
        meta: { _yoast_wpseo_title: postData.seoTitle, _yoast_wpseo_metadesc: postData.seoDescription, _yoast_wpseo_focuskw: postData.focusKeyword },
      });
      pendingApprovals.delete(approvalId);
      return sendWhatsApp(`✅ Blog post *"${postData.title}"* published to your website!\n${wpPost.link}`);
    }

    if (pending.type === 'apply_meta') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp || !pending.pageId) {
        pendingApprovals.delete(approvalId);
        return sendWhatsApp(`❌ WordPress is not connected or page ID missing. The proposed changes are in your Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''} — you can apply them manually.`);
      }
      await wp.updatePageSEO(pending.pageId, pending.seoData, pending.pageType || 'posts');
      pendingApprovals.delete(approvalId);
      return sendWhatsApp(`✅ Meta tags updated on your website for page #${pending.pageId}!`);
    }

    if (pending.type === 'update_post') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp) {
        pendingApprovals.delete(approvalId);
        return sendWhatsApp(`❌ WordPress is not connected for ${pending.clientName}. The changes are in your Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''} — you can apply them manually.`);
      }
      const updates = {};
      if (pending.updates.title) updates.title = pending.updates.title;
      if (pending.updates.content) updates.content = pending.updates.content;
      if (pending.updates.status) updates.status = pending.updates.status;
      await wp.updatePost(pending.postId, updates);
      if (pending.seoUpdates) {
        await wp.updatePageSEO(pending.postId, pending.seoUpdates);
      }
      pendingApprovals.delete(approvalId);
      return sendWhatsApp(`✅ Post #${pending.postId} updated on your website!`);
    }

    pendingApprovals.delete(approvalId);
    return sendWhatsApp(`✅ Action approved and executed.`);
  } catch (error) {
    return sendWhatsApp(`❌ Action failed: ${error.message}`);
  }
}

// --- Client Message Handler (non-owner contacts) ---
/**
 * Handle a client message (text or multimodal with image).
 * @param {string} from - Phone number
 * @param {string} message - Text message or caption
 * @param {object} [mediaAttachment] - Optional image attachment for Claude Vision
 * @param {string} mediaAttachment.type - 'image'
 * @param {string} mediaAttachment.base64 - Base64-encoded image data
 * @param {string} mediaAttachment.mimeType - MIME type (e.g. 'image/jpeg')
 */
export async function handleClientMessage(from, message, mediaAttachment = null) {
  try {
    // Pre-check for signup token — cancel stale sessions so fresh signups aren't blocked
    const preTokenMatch = message.match(TOKEN_RE_INLINE);
    if (preTokenMatch) {
      const preCheck = await getPendingClientWithFallback(preTokenMatch[1]);
      if (preCheck) {
        const staleSession = getOnboardingSession(from);
        if (staleSession) {
          updateOnboardingSession(staleSession.id, { status: 'cancelled' });
          log.info('Cancelled stale onboarding session for fresh signup', { from, sessionId: staleSession.id });
        }
      }
    }

    // 1. Check if client has an active onboarding session
    if (hasActiveOnboarding(from)) {
      log.info('Routing to onboarding flow', { from });
      addToHistory(from, 'user', message, 'whatsapp');
      const result = await handleOnboardingMessage(from, message, 'whatsapp');
      if (Array.isArray(result)) {
        for (const msg of result) {
          addToHistory(from, 'assistant', msg, 'whatsapp');
          await sendWhatsApp(msg, from);
        }
      } else if (result) {
        addToHistory(from, 'assistant', result, 'whatsapp');
        await sendWhatsApp(result, from);
      }
      return;
    }

    // 2. Check if this is a NEW person (not a known contact)
    let clientCtx = getClientContextByPhone(from);
    if (!clientCtx) {
      let pendingData = null;
      const tokenMatch = message.match(TOKEN_RE_INLINE);
      if (tokenMatch) {
        const found = await getPendingClientWithFallback(tokenMatch[1]);
        if (found) {
          activatePendingClient(found.token, from, 'whatsapp');
          pendingData = found;
          log.info('Activated pending client from token', { token: found.token, from });
        } else {
          const linked = tryLinkCrossChannel(tokenMatch[1], from, 'whatsapp');
          if (linked) {
            log.info('Cross-channel link: client already onboarded on another channel', { from });
            await sendWhatsApp(
              `Hey${linked.contactName ? ` *${linked.contactName}*` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on WhatsApp too! How can I help you today?`,
              from,
            );
            return;
          }
        }
      }

      const lang = pendingData?.language || 'en';
      log.info('New contact detected, auto-starting onboarding via WhatsApp', { from, language: lang });

      if (pendingData && pendingData.name) {
        try {
          createContact({ phone: from, name: pendingData.name, email: pendingData.email, channel: 'whatsapp', language: lang });
        } catch (e) { /* might already exist */ }

        const prefillAnswers = {};
        if (pendingData.name) prefillAnswers.name = pendingData.name;
        if (pendingData.website) prefillAnswers.website = pendingData.website;
        if (pendingData.business_name) prefillAnswers.business_name = pendingData.business_name;
        if (pendingData.business_description) prefillAnswers.business_description = pendingData.business_description;
        if (pendingData.product_service) prefillAnswers.product_service = pendingData.product_service;
        if (pendingData.email) prefillAnswers.email = pendingData.email;

        const session = createOnboardingSession(from, 'whatsapp', lang, prefillAnswers);
        const hasFormData = Object.keys(prefillAnswers).length > 1;
        if (hasFormData) {
          updateOnboardingSession(session.id, { currentStep: 'confirm_details' });
        }

        const welcome = buildPersonalizedWelcome(pendingData, lang);
        addToHistory(from, 'user', message, 'whatsapp');
        addToHistory(from, 'assistant', welcome, 'whatsapp');
        await sendWhatsApp(welcome, from);
      } else {
        createOnboardingSession(from, 'whatsapp', lang);
        addToHistory(from, 'user', message, 'whatsapp');
        const result = await handleOnboardingMessage(from, message, 'whatsapp');
        if (Array.isArray(result)) {
          for (const msg of result) {
            addToHistory(from, 'assistant', msg, 'whatsapp');
            await sendWhatsApp(msg, from);
          }
        } else if (result) {
          addToHistory(from, 'assistant', result, 'whatsapp');
          await sendWhatsApp(result, from);
        }
      }

      // Notify owner
      try {
        await sendWhatsApp(`📥 *New client started onboarding via WhatsApp*\nPhone: ${from}${pendingData?.name ? `\nName: ${pendingData.name}` : ''}${pendingData?.plan ? `\nPlan: ${pendingData.plan}` : ''}\nFirst message: "${message.substring(0, 100)}"`);
      } catch (e) { /* best effort */ }
      return;
    }

    // 3. Check daily message limit based on plan
    const limitCheck = checkClientMessageLimit(from);
    if (!limitCheck.allowed) {
      await sendWhatsApp(
        `Hey ${clientCtx.contactName || 'there'}! You've reached your daily message limit (${limitCheck.limit} messages on the *${limitCheck.plan.toUpperCase()}* plan). Your limit resets tomorrow.\n\nNeed more? Ask us about upgrading your plan!`,
        from,
      );
      return;
    }

    // 4. Known client — build context and run chat loop
    const contactName = clientCtx?.contactName;
    const contacts = clientCtx.clientId ? getContactsByClientId(clientCtx.clientId) : [];
    const systemPrompt = buildClientSystemPrompt(clientCtx, 'whatsapp', contacts);
    const CLIENT_TOOLS = CSA_TOOLS.filter(t => CLIENT_TOOL_NAMES.includes(t.name));

    // Load history (cross-channel if available)
    let history;
    if (clientCtx.clientId && contacts.length > 1) {
      history = getCrossChannelHistory(clientCtx.clientId, MAX_HISTORY_MESSAGES * 2);
    } else {
      history = getHistory(from);
    }
    // Store text part in history (images are ephemeral — too large for SQLite)
    addToHistory(from, 'user', message, 'whatsapp');

    // Build the current user message — multimodal if image attached
    let currentUserContent;
    if (mediaAttachment?.base64 && mediaAttachment.type === 'image') {
      // Claude Vision multimodal format: image + text content blocks
      currentUserContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaAttachment.mimeType || 'image/jpeg',
            data: mediaAttachment.base64,
          },
        },
        { type: 'text', text: message },
      ];
    } else {
      currentUserContent = message;
    }

    const messages = sanitizeMessages([...history, { role: 'user', content: currentUserContent }]);

    await sendThinkingIndicator('whatsapp', from, 'Give me a moment...');

    try {
      const finalText = await runChatLoop({
        systemPrompt,
        messages,
        tools: CLIENT_TOOLS,
        channel: 'whatsapp',
        chatId: from,
        historyKey: from,
        workflow: 'client-chat',
        clientContext: clientCtx,
        contactName,
      });
      await sendWhatsApp(finalText, from);

      // Append to live conversation log on Google Drive
      if (clientCtx.clientId) {
        const client = getClient(clientCtx.clientId);
        if (client?.conversation_log_doc_id) {
          const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
          const logEntry = `\n[${timestamp}] ${contactName || 'Client'}: ${message}\n[${timestamp}] Sofia: ${finalText}\n`;
          googleDrive.appendToDocument(client.conversation_log_doc_id, logEntry).catch(e =>
            log.warn('Failed to append to conversation log', { error: e.message })
          );
        }
      }
    } catch (error) {
      log.error('Client message handling failed', { from, error: error.message, stack: error.stack });
      const fallbackMsg = 'Thank you for your message. Our team will get back to you shortly.';
      addToHistory(from, 'assistant', fallbackMsg, 'whatsapp');
      try {
        await sendWhatsApp(fallbackMsg, from);
      } catch (sendErr) {
        log.error('CRITICAL: Cannot send ANY WhatsApp message (client handler)', {
          from,
          originalError: error.message,
          sendError: sendErr.message,
          sendStatus: sendErr.response?.status,
          sendDetail: sendErr.response?.data?.error?.message,
        });
      }
    }
  } catch (error) {
    log.error('Client message handling failed (outer)', { from, error: error.message });
    const fallbackMsg = 'Thank you for your message. Our team will get back to you shortly.';
    addToHistory(from, 'assistant', fallbackMsg, 'whatsapp');
    try { await sendWhatsApp(fallbackMsg, from); } catch (e) { /* best effort */ }
  }
}

// --- WhatsApp Media Upload Handler ---
export async function handleMediaUpload(from, mediaType, media, caption) {
  try {
    const mediaId = media.id;
    const mediaUrl = await getWhatsAppMediaUrl(mediaId);
    if (!mediaUrl) {
      return sendWhatsApp('Could not retrieve the file. Please try again.');
    }

    const mediaData = await downloadWhatsAppMedia(mediaUrl);
    if (!mediaData) {
      return sendWhatsApp('Could not download the file. Please try again.');
    }

    let clientName = null;
    let folderType = 'brand_assets';
    if (caption) {
      const forMatch = caption.match(/(?:for|para|cliente?)\s+["']?([^"'\n,]+)/i);
      if (forMatch) clientName = forMatch[1].trim();
      if (/brand|marca|logo|guideline|identidade/i.test(caption)) folderType = 'brand_assets';
      else if (/creative|criativo|mockup|ad/i.test(caption)) folderType = 'creatives';
      else if (/report|relatório/i.test(caption)) folderType = 'reports';
      else if (/competitor|concorr/i.test(caption)) folderType = 'competitor_research';
    }

    const client = clientName ? getClient(clientName) : null;
    const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

    if (!folderId) {
      return sendWhatsApp('Google Drive not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env to enable file storage.');
    }

    const ext = getExtFromMime(media.mime_type);
    const fileName = media.filename || `${mediaType}_${Date.now()}${ext}`;

    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(Buffer.from(mediaData));
    stream.push(null);

    const uploaded = await googleDrive.uploadFile(fileName, stream, media.mime_type, folderId);

    if (uploaded) {
      const msg = [
        `✅ *File saved to Google Drive*`,
        `📁 ${fileName}`,
        client ? `📋 Client: ${client.name}` : '',
        uploaded.webViewLink ? `🔗 ${uploaded.webViewLink}` : '',
      ].filter(Boolean).join('\n');
      await sendWhatsApp(msg);
    } else {
      await sendWhatsApp('File received but Google Drive upload failed. Check Drive configuration.');
    }
  } catch (error) {
    log.error('Media upload failed', { error: error.message, mediaType });
    await sendWhatsApp(`Could not save file: ${error.message}`);
  }
}

// --- WhatsApp Media Helpers ---
export async function getWhatsAppMediaUrl(mediaId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` } }
    );
    return res.data?.url;
  } catch (e) {
    log.error('Failed to get media URL', { error: e.message });
    return null;
  }
}

export async function downloadWhatsAppMedia(url) {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return res.data;
  } catch (e) {
    log.error('Failed to download media', { error: e.message });
    return null;
  }
}

export function getExtFromMime(mimeType) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[mimeType] || '';
}
