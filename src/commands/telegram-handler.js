/**
 * Telegram message handlers — owner commands, client messages, approvals, media.
 * Extracted from whatsapp-server.js for maintainability.
 */
import { sendTelegram } from '../api/telegram.js';
import { sendWhatsApp } from '../api/whatsapp.js';
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
  TOKEN_RE_START, TOKEN_RE_INLINE,
  sendThinkingIndicator,
  getHistory, addToHistory, clearHistory, sanitizeMessages,
  tryLinkCrossChannel, getPendingClientWithFallback,
  MAX_HISTORY_MESSAGES,
} from './helpers.js';
import { CSA_TOOLS, CLIENT_TOOL_NAMES } from './csa-tool-defs.js';
import { TELEGRAM_CSA_PROMPT, buildClientSystemPrompt } from './sofia-prompts.js';
import { runChatLoop } from './chat-loop.js';

const log = logger.child({ module: 'telegram-handler' });

export async function handleTelegramCommand(message, chatId) {
  const reply = (msg) => sendTelegram(msg, chatId);

  // Handle approval responses
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleTelegramApproval(approvalMatch[1].toUpperCase(), approvalMatch[2], chatId);
  }

  // Handle "clear" / "reset"
  if (/^(clear|reset|new chat|forget)$/i.test(message.trim())) {
    clearHistory(chatId);
    return reply('Memory cleared! Starting fresh.');
  }

  // Build context
  const clients = getAllClients();
  const clientContext = clients.length > 0
    ? `\n\nCurrent clients: ${clients.map(c => c.name).join(', ')}`
    : '\n\nNo clients onboarded yet.';

  const history = getHistory(chatId);
  addToHistory(chatId, 'user', message);
  const messages = sanitizeMessages([...history, { role: 'user', content: message }]);

  try {
    const finalText = await runChatLoop({
      systemPrompt: TELEGRAM_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      channel: 'telegram',
      chatId,
      historyKey: chatId,
      workflow: 'telegram-csa',
    });
    await reply(finalText);
  } catch (error) {
    log.error('Telegram command loop failed', { error: error.message, stack: error.stack });
    const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');
    const errorMsg = isRateLimit
      ? 'I\'m currently experiencing high demand. Please wait a minute and try again.'
      : 'Something went wrong while processing your request. Please try again.';
    addToHistory(chatId, 'assistant', errorMsg);
    await reply(errorMsg);
  }
}

export async function handleTelegramApproval(action, approvalId, chatId) {
  const reply = (msg) => sendTelegram(msg, chatId);
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return reply(`❌ Approval "${approvalId}" not found or expired.`);
  if (action === 'DENY') { pendingApprovals.delete(approvalId); return reply(`❌ Action denied and cancelled.`); }
  if (action === 'DETAILS') return reply(`📋 <b>Action Details:</b>\n${JSON.stringify(pending, null, 2)}`);
  try {
    if (pending.type === 'pause' && pending.platform === 'meta') {
      await metaAds.pauseCampaign(pending.campaignId);
      pendingApprovals.delete(approvalId);
      return reply(`✅ Campaign ${pending.campaignId} paused on Meta.`);
    }

    if (pending.type === 'publish_blog') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp) {
        pendingApprovals.delete(approvalId);
        return reply(`❌ WordPress is not connected for ${pending.clientName}. The blog post is available in your Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''} — you can post it manually.`);
      }
      const { postData } = pending;
      const wpPost = await wp.createPost({
        title: postData.title, content: postData.content, excerpt: postData.excerpt,
        slug: postData.slug, status: postData.publishDate ? 'future' : 'publish', date: postData.publishDate,
        meta: { _yoast_wpseo_title: postData.seoTitle, _yoast_wpseo_metadesc: postData.seoDescription, _yoast_wpseo_focuskw: postData.focusKeyword },
      });
      pendingApprovals.delete(approvalId);
      return reply(`✅ Blog post <b>"${postData.title}"</b> published to your website!\n${wpPost.link}`);
    }

    if (pending.type === 'apply_meta') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp || !pending.pageId) {
        pendingApprovals.delete(approvalId);
        return reply(`❌ WordPress is not connected or page ID missing. The proposed changes are in your Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''}.`);
      }
      await wp.updatePageSEO(pending.pageId, pending.seoData, pending.pageType || 'posts');
      pendingApprovals.delete(approvalId);
      return reply(`✅ Meta tags updated on your website for page #${pending.pageId}!`);
    }

    if (pending.type === 'update_post') {
      const client = getClient(pending.clientName);
      const wp = client ? seoEngine.getWordPressClient(client) : null;
      if (!wp) {
        pendingApprovals.delete(approvalId);
        return reply(`❌ WordPress is not connected for ${pending.clientName}. Changes available in Google Doc${pending.docUrl ? `: ${pending.docUrl}` : ''}.`);
      }
      const updates = {};
      if (pending.updates.title) updates.title = pending.updates.title;
      if (pending.updates.content) updates.content = pending.updates.content;
      if (pending.updates.status) updates.status = pending.updates.status;
      await wp.updatePost(pending.postId, updates);
      if (pending.seoUpdates) await wp.updatePageSEO(pending.postId, pending.seoUpdates);
      pendingApprovals.delete(approvalId);
      return reply(`✅ Post #${pending.postId} updated on your website!`);
    }

    pendingApprovals.delete(approvalId);
    return reply(`✅ Action approved and executed.`);
  } catch (error) { return reply(`❌ Action failed: ${error.message}`); }
}

export async function handleTelegramClientMessage(chatId, message) {
  try {
    let actualMessage = message;
    let pendingData = null;
    const startMatch = message.match(TOKEN_RE_START);
    if (startMatch) {
      const pending = await getPendingClientWithFallback(startMatch[1]);
      if (pending) {
        activatePendingClient(pending.token, chatId, 'telegram');
        pendingData = pending;
        log.info('Activated pending client from Telegram /start', { token: pending.token, chatId });
      } else {
        const linked = tryLinkCrossChannel(startMatch[1], chatId, 'telegram');
        if (linked) {
          log.info('Cross-channel link via Telegram /start', { chatId });
          await sendTelegram(
            `Hey${linked.contactName ? ` <b>${linked.contactName}</b>` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on Telegram too! How can I help you today?`,
            chatId,
          );
          return;
        }
      }
    }

    // Bare /start
    if (!startMatch && /^\/start$/i.test(message.trim())) {
      const latestPending = getLatestPendingClient();
      if (latestPending) {
        activatePendingClient(latestPending.token, chatId, 'telegram');
        pendingData = latestPending;
        log.info('Activated latest pending client from bare /start', { token: latestPending.token, chatId });
      }
    }

    // Build formatted message from pending data
    if (pendingData) {
      actualMessage = `Hi Sofia, I am ${pendingData.name || 'a new client'}${pendingData.business_name ? `, representing ${pendingData.business_name}` : ''}${pendingData.website ? ` (${pendingData.website})` : ''}. My Unique Client Code is ${pendingData.token}.`;

      const staleSession = getOnboardingSession(chatId);
      if (staleSession) {
        updateOnboardingSession(staleSession.id, { status: 'cancelled' });
        log.info('Cancelled stale Telegram onboarding session for fresh signup', { chatId, sessionId: staleSession.id });
      }
    }

    // Check for active onboarding
    if (hasActiveOnboarding(chatId)) {
      log.info('Routing Telegram to onboarding flow', { chatId });
      addToHistory(chatId, 'user', actualMessage, 'telegram');
      const result = await handleOnboardingMessage(chatId, actualMessage, 'telegram');
      if (Array.isArray(result)) {
        for (const msg of result) {
          addToHistory(chatId, 'assistant', msg, 'telegram');
          await sendTelegram(msg, chatId);
        }
      } else if (result) {
        addToHistory(chatId, 'assistant', result, 'telegram');
        await sendTelegram(result, chatId);
      }
      return;
    }

    // Check if known client
    let clientCtx = getClientContextByPhone(chatId);
    if (!clientCtx) {
      // Check for token in message
      if (!startMatch && !pendingData) {
        const tokenMatch = message.match(TOKEN_RE_INLINE);
        if (tokenMatch) {
          const found = await getPendingClientWithFallback(tokenMatch[1]);
          if (found) {
            activatePendingClient(found.token, chatId, 'telegram');
            pendingData = found;
            log.info('Activated pending client from token (Telegram)', { token: found.token, chatId });
          } else {
            const linked = tryLinkCrossChannel(tokenMatch[1], chatId, 'telegram');
            if (linked) {
              await sendTelegram(
                `Hey${linked.contactName ? ` <b>${linked.contactName}</b>` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on Telegram too! How can I help you today?`,
                chatId,
              );
              return;
            }
          }
        }
      }

      const lang = pendingData?.language || 'en';
      log.info('New Telegram contact, auto-starting onboarding', { chatId, language: lang });

      if (pendingData && pendingData.name) {
        try {
          createContact({ phone: chatId, name: pendingData.name, email: pendingData.email, channel: 'telegram', language: lang });
        } catch (e) { /* might already exist */ }

        const prefillAnswers = {};
        if (pendingData.name) prefillAnswers.name = pendingData.name;
        if (pendingData.website) prefillAnswers.website = pendingData.website;
        if (pendingData.business_name) prefillAnswers.business_name = pendingData.business_name;
        if (pendingData.business_description) prefillAnswers.business_description = pendingData.business_description;
        if (pendingData.product_service) prefillAnswers.product_service = pendingData.product_service;
        if (pendingData.email) prefillAnswers.email = pendingData.email;

        const session = createOnboardingSession(chatId, 'telegram', lang, prefillAnswers);
        const hasFormData = Object.keys(prefillAnswers).length > 1;
        if (hasFormData) {
          updateOnboardingSession(session.id, { currentStep: 'confirm_details' });
        }

        const welcome = buildPersonalizedWelcome(pendingData, lang, 'telegram');
        addToHistory(chatId, 'user', actualMessage, 'telegram');
        addToHistory(chatId, 'assistant', welcome, 'telegram');
        await sendTelegram(welcome, chatId);
      } else {
        createOnboardingSession(chatId, 'telegram', lang);
        addToHistory(chatId, 'user', actualMessage, 'telegram');
        const result = await handleOnboardingMessage(chatId, actualMessage, 'telegram');
        if (Array.isArray(result)) {
          for (const msg of result) {
            addToHistory(chatId, 'assistant', msg, 'telegram');
            await sendTelegram(msg, chatId);
          }
        } else if (result) {
          addToHistory(chatId, 'assistant', result, 'telegram');
          await sendTelegram(result, chatId);
        }
      }

      // Notify owner
      try {
        await sendWhatsApp(`📥 *New client started onboarding via Telegram*\nChat ID: ${chatId}${pendingData?.name ? `\nName: ${pendingData.name}` : ''}${pendingData?.plan ? `\nPlan: ${pendingData.plan}` : ''}\nFirst message: "${message.substring(0, 100)}"`);
      } catch (e) { /* best effort */ }
      return;
    }

    // Check daily message limit
    const limitCheck = checkClientMessageLimit(chatId);
    if (!limitCheck.allowed) {
      await sendTelegram(
        `Hey ${clientCtx.contactName || 'there'}! You've reached your daily message limit (${limitCheck.limit} messages on the <b>${limitCheck.plan.toUpperCase()}</b> plan). Your limit resets tomorrow.\n\nNeed more? Ask us about upgrading your plan!`,
        chatId,
      );
      return;
    }

    // Known client — build context and run chat loop
    const contactName = clientCtx?.contactName;
    const contacts = clientCtx.clientId ? getContactsByClientId(clientCtx.clientId) : [];
    const systemPrompt = buildClientSystemPrompt(clientCtx, 'telegram', contacts);
    const CLIENT_TOOLS = CSA_TOOLS.filter(t => CLIENT_TOOL_NAMES.includes(t.name));

    // Load history (cross-channel if available)
    let history;
    if (clientCtx.clientId && contacts.length > 1) {
      history = getCrossChannelHistory(clientCtx.clientId, MAX_HISTORY_MESSAGES * 2);
    } else {
      history = getHistory(chatId);
    }
    addToHistory(chatId, 'user', message, 'telegram');
    const messages = sanitizeMessages([...history, { role: 'user', content: message }]);

    await sendThinkingIndicator('telegram', chatId, 'Give me a moment...');

    try {
      const finalText = await runChatLoop({
        systemPrompt,
        messages,
        tools: CLIENT_TOOLS,
        channel: 'telegram',
        chatId,
        historyKey: chatId,
        workflow: 'client-chat',
        clientContext: clientCtx,
        contactName,
      });
      await sendTelegram(finalText, chatId);

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
      log.error('Telegram client message handling failed', { chatId, error: error.message, stack: error.stack });
      const isApiError = error.message?.includes('401') || error.message?.includes('api_key') || error.message?.includes('authentication');
      const hint = isApiError
        ? ' (API authentication issue — check ANTHROPIC_API_KEY)'
        : ` (${error.message?.substring(0, 80)})`;
      const fallbackMsg = `Sorry, I ran into a temporary issue${hint}. Please try again in a moment.`;
      addToHistory(chatId, 'assistant', fallbackMsg, 'telegram');
      try {
        await sendTelegram(fallbackMsg, chatId);
      } catch (e) { /* best effort */ }
    }
  } catch (error) {
    log.error('Telegram client message handling failed (outer)', { chatId, error: error.message });
    const fallbackMsg = 'Sorry, I ran into a temporary issue. Please try again in a moment.';
    addToHistory(chatId, 'assistant', fallbackMsg, 'telegram');
    try { await sendTelegram(fallbackMsg, chatId); } catch (e) { /* best effort */ }
  }
}

export async function handleTelegramMediaUpload(chatId, mediaType, fileObj, caption) {
  try {
    const botToken = config.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return sendTelegram('Telegram bot token not configured.', chatId);
    }

    const fileRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
      params: { file_id: fileObj.file_id },
    });
    const filePath = fileRes.data?.result?.file_path;
    if (!filePath) {
      return sendTelegram('Could not retrieve the file. Please try again.', chatId);
    }

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const fileData = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
    if (!fileData.data) {
      return sendTelegram('Could not download the file. Please try again.', chatId);
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
      return sendTelegram('Google Drive not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env.', chatId);
    }

    const mimeType = fileObj.mime_type || 'application/octet-stream';
    const extMap = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
      'video/mp4': '.mp4', 'video/3gpp': '.3gp',
      'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    };
    const ext = extMap[mimeType] || '';
    const fileName = fileObj.file_name || `${mediaType}_${Date.now()}${ext}`;

    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(Buffer.from(fileData.data));
    stream.push(null);

    const uploaded = await googleDrive.uploadFile(fileName, stream, mimeType, folderId);

    if (uploaded) {
      const msg = [
        `✅ <b>File saved to Google Drive</b>`,
        `📁 ${fileName}`,
        client ? `📋 Client: ${client.name}` : '',
        uploaded.webViewLink ? `🔗 ${uploaded.webViewLink}` : '',
      ].filter(Boolean).join('\n');
      await sendTelegram(msg, chatId);
    } else {
      await sendTelegram('File received but Google Drive upload failed. Check Drive configuration.', chatId);
    }
  } catch (error) {
    log.error('Telegram media upload failed', { error: error.message, mediaType });
    await sendTelegram(`Could not save file: ${error.message}`, chatId);
  }
}
