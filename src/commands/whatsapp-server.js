/**
 * Express server — webhook routes, API endpoints, startup.
 * All handler logic lives in dedicated modules:
 *   - whatsapp-handler.js  (owner commands, client messages, approvals, media)
 *   - telegram-handler.js  (owner commands, client messages, approvals, media)
 *   - helpers.js            (shared state, dedup, history, media delivery, queue)
 *   - sofia-prompts.js      (system prompts)
 *   - csa-tool-defs.js      (tool definitions)
 *   - csa-tool-executor.js  (tool execution switch)
 *   - chat-loop.js          (unified AI conversation loop)
 */
import express from 'express';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram, sendAlert as sendTelegramAlert } from '../api/telegram.js';
import { getMe as getTelegramMe } from '../api/telegram.js';
import {
  getPendingClientByToken, getPendingClientByTokenAny,
  getContactByPhone, updateClient, updatePendingClient,
  getPendingClientByLeadsieInvite, createPendingClient,
} from '../services/knowledge-base.js';
import { handleOnboardingMessage, hasActiveOnboarding } from '../services/client-onboarding-flow.js';
import * as leadsie from '../api/leadsie.js';
import * as supabase from '../api/supabase.js';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Handlers
import {
  handleCommand, handleClientMessage, handleMediaUpload, handleApproval,
  getWhatsAppMediaUrl, downloadWhatsAppMedia,
} from './whatsapp-handler.js';
import {
  handleTelegramCommand, handleTelegramClientMessage,
  handleTelegramApproval, handleTelegramMediaUpload,
} from './telegram-handler.js';
import {
  isMessageAlreadyProcessed, enqueueOwnerMessage, setHandleCommandFn,
  landingPageStore, setDetectedPublicUrl, addToHistory,
  getPendingClientWithFallback,
  storeTempMedia, getTempMedia, getTempMediaUrl,
} from './helpers.js';

const log = logger.child({ workflow: 'whatsapp-command' });

// Wire up the owner message queue to the handleCommand function
setHandleCommandFn(handleCommand);

// Cache for Telegram bot username (fetched once at startup)
let telegramBotUsername = config.TELEGRAM_BOT_USERNAME || '';

// --- Express App ---
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Auto-detect public URL from first real incoming request
app.use((req, res, next) => {
  if (req.hostname && req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    const url = `${req.protocol}://${req.get('host')}`;
    setDetectedPublicUrl(url);
  }
  next();
});

// Rate limit webhook endpoint
app.use('/webhook', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: 'Too many requests',
  validate: { xForwardedForHeader: false, default: true },
}));

// CORS for /api routes
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limit /api endpoints
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many requests',
  validate: { xForwardedForHeader: false, default: true },
}));

// ============================================================
// WhatsApp Cloud API Webhook Verification (GET)
// ============================================================
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
    log.info('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ============================================================
// WhatsApp Cloud API Webhook (POST)
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const hasMessages = !!value?.messages?.length;
    const hasStatuses = !!value?.statuses?.length;
    if (hasMessages) {
      log.info('WhatsApp webhook: incoming message', {
        from: value.messages[0].from, type: value.messages[0].type, msgId: value.messages[0].id,
      });
    } else if (hasStatuses) {
      log.debug('WhatsApp webhook: status update', {
        status: value.statuses[0]?.status, recipientId: value.statuses[0]?.recipient_id,
      });
    } else {
      log.debug('WhatsApp webhook: non-message event', { field: changes?.field });
    }

    // Check for error statuses from Meta
    if (hasStatuses) {
      for (const status of value.statuses) {
        if (status.status === 'failed' && status.errors?.length) {
          log.error('WhatsApp message delivery FAILED', {
            recipientId: status.recipient_id,
            errorCode: status.errors[0]?.code,
            errorTitle: status.errors[0]?.title,
            errorMessage: status.errors[0]?.message,
            errorHref: status.errors[0]?.href,
          });
        }
      }
    }

    const message = value?.messages?.[0];
    if (!message) return;

    // Deduplicate — Meta often resends the same webhook 2-3 times
    if (isMessageAlreadyProcessed(message.id)) {
      log.debug('WhatsApp webhook: skipping duplicate message', { msgId: message.id });
      return;
    }

    const from = message.from;

    // Handle file uploads (images, documents, video, audio)
    if (['image', 'document', 'video', 'audio'].includes(message.type)) {
      const media = message[message.type];
      const caption = media?.caption || message.caption || '';
      log.info('WhatsApp media received', { from, type: message.type, mimeType: media?.mime_type });

      // For ALL image messages (owner or client): download and pass to Claude Vision
      // so Sofia can actually SEE the image and act on it (create ads, analyze, etc.)
      if (message.type === 'image') {
        let imageBase64 = null;
        let imageBuffer = null;
        let mimeType = media?.mime_type || 'image/jpeg';
        try {
          const mediaUrl = await getWhatsAppMediaUrl(media.id);
          if (mediaUrl) {
            const mediaData = await downloadWhatsAppMedia(mediaUrl);
            if (mediaData) {
              imageBuffer = Buffer.from(mediaData);
              imageBase64 = imageBuffer.toString('base64');
            }
          }
        } catch (e) {
          log.warn('Failed to download image for vision', { error: e.message });
        }

        // Store image temporarily so video generation tools can access it via URL
        let tempImageUrl = null;
        if (imageBuffer) {
          const mediaId = storeTempMedia(imageBuffer, mimeType);
          tempImageUrl = getTempMediaUrl(mediaId);
          if (tempImageUrl) {
            log.info('Stored temp image for tool access', { tempImageUrl: tempImageUrl.slice(0, 80) });
          }
        }

        // Append image URL context so Sofia can pass it to generate_video_from_image
        let textPart = caption || 'The user sent this image. Describe what you see and ask how you can help with it.';
        if (tempImageUrl) {
          textPart += `\n\n[SYSTEM: The uploaded image is available at this URL for tool use: ${tempImageUrl} — use this URL as imageUrl with generate_video_from_image for video, OR as uploadedImageUrl with generate_ad_creative_with_text for static creatives with the user's photo]`;
        }

        const normalizePhone = (p) => p?.replace(/[^0-9]/g, '');
        const isOwner = normalizePhone(from) === normalizePhone(config.WHATSAPP_OWNER_PHONE);
        if (isOwner) {
          await handleCommand(textPart, {
            type: 'image',
            base64: imageBase64,
            mimeType,
          });
        } else {
          await handleClientMessage(from, textPart, {
            type: 'image',
            base64: imageBase64,
            mimeType,
          });
        }
      } else {
        // Non-image media (documents, video, audio)
        const normalizePhone = (p) => p?.replace(/[^0-9]/g, '');
        const isOwner = normalizePhone(from) === normalizePhone(config.WHATSAPP_OWNER_PHONE);
        if (isOwner) {
          await handleMediaUpload(from, message.type, media, caption);
        } else if (caption) {
          await handleClientMessage(from, caption);
        } else {
          await sendWhatsApp('Thanks for sharing that! If you have any questions or need help, just send me a text message.', from);
        }
      }
      return;
    }

    if (message.type !== 'text') return;
    const body = message.text?.body?.trim();
    if (!body) return;

    log.info('WhatsApp message received', { from, body: body.substring(0, 100) });

    const normalizePhone = (p) => p?.replace(/[^0-9]/g, '');
    const isOwner = normalizePhone(from) === normalizePhone(config.WHATSAPP_OWNER_PHONE);

    log.info('WhatsApp routing', { from, isOwner, ownerPhone: config.WHATSAPP_OWNER_PHONE?.slice(-4) });

    if (isOwner) {
      await enqueueOwnerMessage(body);
    } else {
      await handleClientMessage(from, body);
    }
  } catch (error) {
    log.error('Command handling failed', { error: error.message, stack: error.stack });
    try {
      await sendWhatsApp(`❌ Error: ${error.message}`);
    } catch (sendErr) {
      log.error('CRITICAL: Failed to send ANY WhatsApp message', {
        originalError: error.message,
        sendError: sendErr.message,
        sendStatus: sendErr.response?.status,
        sendDetail: sendErr.response?.data?.error?.message,
      });
      if (config.TELEGRAM_OWNER_CHAT_ID) {
        try {
          await sendTelegramAlert('error', 'WhatsApp DEAD',
            `Cannot send ANY WhatsApp messages.\nOriginal error: ${error.message}\nSend error: ${sendErr.message}\n\nCheck WHATSAPP_ACCESS_TOKEN in Railway.`);
        } catch (_) { /* truly nothing we can do */ }
      }
    }
  }
});

// ============================================================
// Telegram Bot Webhook (POST)
// ============================================================
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message) return;

    const chatId = String(message.chat?.id);
    const isOwner = chatId === config.TELEGRAM_OWNER_CHAT_ID;

    // Handle file uploads (photos, documents, video, audio)
    const fileObj = message.document || message.photo?.slice(-1)?.[0] || message.video || message.audio;
    if (fileObj) {
      const caption = message.caption || '';
      const mediaType = message.document ? 'document' : message.photo ? 'image' : message.video ? 'video' : 'audio';
      log.info('Telegram file received', { chatId, mediaType, fileId: fileObj.file_id });

      if (isOwner) {
        await handleTelegramMediaUpload(chatId, mediaType, fileObj, caption);
        return;
      }

      // For client images: download and pass to Claude Vision
      if (message.photo) {
        let imageBase64 = null;
        try {
          const { default: telegramApi } = await import('../api/telegram.js');
          const fileUrl = await telegramApi.getFileUrl(fileObj.file_id);
          if (fileUrl) {
            const { default: axios } = await import('axios');
            const resp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
            imageBase64 = Buffer.from(resp.data).toString('base64');
          }
        } catch (e) {
          log.warn('Failed to download Telegram image for vision', { error: e.message });
        }

        const textPart = caption || 'The user sent this image. Describe what you see and ask how you can help with it.';
        await handleTelegramClientMessage(chatId, textPart, {
          type: 'image',
          base64: imageBase64,
          mimeType: 'image/jpeg',
        });
        return;
      }

      // Non-image media — handle caption as text or ignore
      if (caption) {
        await handleTelegramClientMessage(chatId, caption);
      }
      return;
    }

    if (!message.text) return;
    const body = message.text.trim();
    if (!body) return;

    log.info('Telegram message received', { chatId, body: body.substring(0, 100) });

    if (isOwner) {
      // Check if owner has an active onboarding session (e.g., testing client flow)
      if (hasActiveOnboarding(chatId)) {
        log.info('Owner has active onboarding — routing to onboarding flow', { chatId });
        addToHistory(chatId, 'user', body, 'telegram');
        const result = await handleOnboardingMessage(chatId, body, 'telegram');
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

      // Check if this is a /start TOKEN deep link — owner may be testing as a client
      const TOKEN_RE_START = /^\/start\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{12})$/i;
      const ownerStartMatch = body.match(TOKEN_RE_START);
      if (ownerStartMatch) {
        const pending = await getPendingClientWithFallback(ownerStartMatch[1]);
        if (pending) {
          log.info('Owner triggered client onboarding via /start token', { chatId, token: pending.token });
          await handleTelegramClientMessage(chatId, body);
          return;
        }
      }

      // Bare /start (no token) — route to client handler to start/resume onboarding
      if (/^\/start$/i.test(body.trim())) {
        log.info('Owner sent bare /start, routing to client onboarding handler', { chatId });
        await handleTelegramClientMessage(chatId, body);
        return;
      }

      // Normal owner command access
      await handleTelegramCommand(body, chatId);
    } else {
      await handleTelegramClientMessage(chatId, body);
    }
  } catch (error) {
    log.error('Telegram command handling failed', { error: error.message, stack: error.stack });
    try {
      await sendTelegram(`Error: ${error.message}`);
    } catch (e) { /* best effort */ }
  }
});

// ============================================================
// Leadsie Webhook (completion callback)
// ============================================================
app.post('/webhook/leadsie', async (req, res) => {
  res.sendStatus(200);

  try {
    const secret = config.LEADSIE_WEBHOOK_SECRET;
    if (secret && req.headers['x-leadsie-secret'] !== secret) {
      log.warn('Leadsie webhook: invalid secret');
      return;
    }

    const { invite_id, status, client_name, granted_accounts } = req.body || {};
    if (!invite_id || status !== 'completed') return;

    log.info('Leadsie onboarding completed', { inviteId: invite_id, clientName: client_name });

    const updates = {};
    const grantedPlatforms = [];
    for (const account of (granted_accounts || [])) {
      grantedPlatforms.push(account.platform);

      if (account.platform === 'facebook' && account.account_id) {
        updates.meta_ad_account_id = account.account_id;
      } else if (account.platform === 'google' && account.account_id) {
        updates.google_ads_customer_id = account.account_id;
      } else if (account.platform === 'tiktok' && account.account_id) {
        updates.tiktok_advertiser_id = account.account_id;
      } else if (account.platform === 'wordpress') {
        if (account.site_url) updates.wordpress_url = account.site_url;
        if (account.username) updates.wordpress_username = account.username;
        if (account.access_token || account.app_password) updates.wordpress_app_password = account.access_token || account.app_password;
        updates.cms_platform = 'wordpress';
      } else if (account.platform === 'shopify') {
        if (account.store_url || account.site_url) updates.shopify_store_url = account.store_url || account.site_url;
        if (account.access_token) updates.shopify_access_token = account.access_token;
        updates.cms_platform = 'shopify';
      } else if (account.platform === 'godaddy') {
        if (account.domain) updates.godaddy_domain = account.domain;
        if (account.api_key || account.access_token) updates.godaddy_api_key = account.api_key || account.access_token;
      } else if (account.platform === 'hubspot') {
        if (account.access_token) updates.hubspot_access_token = account.access_token;
      }
    }

    // Find the client linked to this Leadsie invite
    const { default: Database } = await import('better-sqlite3');
    const DB_PATH = process.env.KB_DB_PATH || 'data/knowledge.db';
    const db = new Database(DB_PATH);
    const session = db.prepare('SELECT * FROM onboarding_sessions WHERE leadsie_invite_id = ?').get(invite_id);
    const pendingByInvite = getPendingClientByLeadsieInvite(invite_id);

    let clientId = session?.client_id || null;
    if (!clientId && pendingByInvite?.chat_id) {
      const contact = getContactByPhone(pendingByInvite.chat_id);
      clientId = contact?.client_id || null;
    }

    if (clientId && Object.keys(updates).length > 0) {
      updateClient(clientId, updates);
      log.info('Leadsie webhook: stored granted credentials on client', { clientId, grantedPlatforms });
    } else if (!clientId && pendingByInvite && Object.keys(updates).length > 0) {
      try {
        updatePendingClient(pendingByInvite.token, updates);
        log.info('Leadsie webhook: stored granted credentials on pending client', { token: pendingByInvite.token, grantedPlatforms });
      } catch (e) {
        log.warn('Failed to store Leadsie credentials on pending client', { error: e.message });
      }
    }

    // Notify owner
    const adPlatforms = grantedPlatforms.filter(p => ['facebook', 'google', 'tiktok'].includes(p));
    const cmsPlatforms = grantedPlatforms.filter(p => ['wordpress', 'shopify'].includes(p));
    const otherPlatforms = grantedPlatforms.filter(p => ['godaddy', 'hubspot', 'mailchimp'].includes(p));

    let notifyMsg = `✅ *${client_name || 'Client'}* completed Leadsie onboarding!\n`;
    if (adPlatforms.length) notifyMsg += `\n📊 *Ad accounts:* ${adPlatforms.join(', ')}`;
    if (cmsPlatforms.length) notifyMsg += `\n🌐 *CMS access:* ${cmsPlatforms.join(', ')} — Sofia can now manage website content & SEO`;
    if (otherPlatforms.length) notifyMsg += `\n🔧 *Other:* ${otherPlatforms.join(', ')}`;
    if (!clientId) notifyMsg += `\n\n⏳ Client hasn't connected with Sofia yet — credentials saved to pending record.`;
    notifyMsg += '\n\nAll credentials have been saved automatically.';
    await sendWhatsApp(notifyMsg);

    db.close();
  } catch (error) {
    log.error('Leadsie webhook handling failed', { error: error.message });
  }
});

// ============================================================
// API Routes
// ============================================================

// POST /api/client-init (called by Lovable after payment)
app.post('/api/client-init', async (req, res) => {
  try {
    if (config.CLIENT_INIT_API_KEY) {
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      if (apiKey !== config.CLIENT_INIT_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
    }

    const { email, plan, name, language, phone, website, business_name, business_description, product_service, submissionId } = req.body || {};
    const token = submissionId || crypto.randomUUID();

    let enrichedData = { email, plan, name, language: language || 'en', phone, website, business_name, business_description, product_service };
    if (submissionId) {
      try {
        const supabaseData = await supabase.getOnboardingSubmission(submissionId);
        if (supabaseData) {
          for (const [key, value] of Object.entries(supabaseData)) {
            if (key !== 'token' && !enrichedData[key] && value) {
              enrichedData[key] = value;
            }
          }
        }
      } catch (e) {
        log.warn('Supabase enrichment failed, continuing with provided data', { error: e.message });
      }
    }

    createPendingClient({ token, ...enrichedData });

    const waPhone = config.WHATSAPP_BUSINESS_PHONE || config.WHATSAPP_OWNER_PHONE;
    const waMessage = `Hi Sofia, I am ${name || 'a new client'}${business_name ? `, representing ${business_name}` : ''}${website ? ` (${website})` : ''}. My Unique Client Code is ${token}.`;
    const whatsappLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(waMessage)}`;

    let telegramLink = null;
    if (telegramBotUsername) {
      telegramLink = `https://t.me/${telegramBotUsername}?start=${token}`;
    } else if (config.TELEGRAM_BOT_TOKEN) {
      try {
        const me = await getTelegramMe();
        telegramBotUsername = me.username;
        telegramLink = `https://t.me/${telegramBotUsername}?start=${token}`;
      } catch (e) {
        log.warn('Could not fetch Telegram bot username', { error: e.message });
      }
    }

    log.info('Client init created', { token, email, plan, name, language: language || 'en', website, business_name });

    res.json({
      success: true,
      token,
      links: { whatsapp: whatsappLink, telegram: telegramLink },
    });
  } catch (error) {
    log.error('Client init failed', { error: error.message });
    res.status(500).json({ error: 'Failed to create client session' });
  }
});

// GET /api/leadsie-connect (redirect client to Leadsie access grant page)
app.get('/api/leadsie-connect', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Missing token parameter. Usage: /api/leadsie-connect?token=<client-token>' });
    }

    const pending = getPendingClientByToken(token) || getPendingClientByTokenAny(token);
    if (!pending) {
      return res.status(404).json({ error: 'Client not found. Please complete checkout first.' });
    }

    const clientName = pending.business_name || pending.name || pending.email || 'New Client';
    const platforms = ['facebook', 'google', 'wordpress', 'hubspot'];
    if (pending.website) platforms.push('wordpress');
    const uniquePlatforms = [...new Set(platforms)];

    const invite = await leadsie.createInvite({
      clientName,
      clientEmail: pending.email || '',
      platforms: uniquePlatforms,
      message: `Hi ${pending.name || clientName}! Welcome aboard. Please grant us access to your accounts below — it's a secure, one-click process. This lets us manage your ad campaigns and optimize your results right away.`,
    });

    try {
      updatePendingClient(token, {
        leadsie_invite_id: invite.inviteId,
        requested_platforms: JSON.stringify(uniquePlatforms),
      });
    } catch (e) {
      log.warn('Failed to store Leadsie invite on pending client', { error: e.message });
    }

    log.info('Leadsie connect redirect', { token, clientName, inviteUrl: invite.inviteUrl, platforms: uniquePlatforms });
    return res.redirect(invite.inviteUrl);
  } catch (error) {
    log.error('Leadsie connect failed', { error: error.message, token: req.query.token });
    return res.status(500).json({ error: 'Failed to create access request. Please contact support.' });
  }
});

// ============================================================
// Landing Page Preview
// ============================================================
app.get('/lp/:id', (req, res) => {
  const page = landingPageStore.get(req.params.id);
  if (!page) return res.status(404).send('Landing page not found or expired.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page.html);
});

// ============================================================
// Health Check
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Serve temporary media (uploaded WhatsApp images for video generation tools)
app.get('/media/temp/:id', (req, res) => {
  const media = getTempMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found or expired' });
  res.set('Content-Type', media.mimeType);
  res.set('Cache-Control', 'private, max-age=900');
  res.send(media.buffer);
});

// ============================================================
// WhatsApp Connectivity Diagnostic
// ============================================================
app.get('/debug/whatsapp', async (req, res) => {
  const checks = { timestamp: new Date().toISOString(), phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID };
  try {
    const { default: axios } = await import('axios');
    const metaRes = await axios.get(
      `https://graph.facebook.com/v22.0/${config.WHATSAPP_PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` }, timeout: 10000 }
    );
    checks.tokenValid = true;
    checks.phoneNumber = metaRes.data?.display_phone_number || metaRes.data?.verified_name || 'OK';
    checks.qualityRating = metaRes.data?.quality_rating;
    checks.messagingLimit = metaRes.data?.messaging_limit_tier;
  } catch (e) {
    checks.tokenValid = false;
    checks.error = e.response?.data?.error?.message || e.message;
    checks.errorCode = e.response?.data?.error?.code;
    checks.httpStatus = e.response?.status;
  }

  try {
    checks.anthropicKey = config.ANTHROPIC_API_KEY ? `${config.ANTHROPIC_API_KEY.slice(0, 8)}...` : 'MISSING';
  } catch (e) {
    checks.anthropicKey = 'ERROR';
  }

  checks.ownerPhone = config.WHATSAPP_OWNER_PHONE ? `...${config.WHATSAPP_OWNER_PHONE.slice(-4)}` : 'MISSING';
  res.json(checks);
});

// ============================================================
// Start Server
// ============================================================
export function startServer(port) {
  const p = port || config.PORT || 3000;
  return new Promise((resolve) => {
    app.listen(p, async () => {
      log.info(`WhatsApp server listening on port ${p}`);
      console.log(`Webhook server running on port ${p}`);
      console.log(`WhatsApp webhook: http://your-server:${p}/webhook/whatsapp`);
      console.log(`Telegram webhook: http://your-server:${p}/webhook/telegram`);
      console.log(`Leadsie webhook: http://your-server:${p}/webhook/leadsie`);
      console.log(`Client init API: http://your-server:${p}/api/client-init`);
      console.log(`Leadsie connect: http://your-server:${p}/api/leadsie-connect?token=<TOKEN>`);
      console.log(`Health check: http://your-server:${p}/health`);

      resolve(app);

      if (!telegramBotUsername && config.TELEGRAM_BOT_TOKEN) {
        try {
          const me = await getTelegramMe();
          telegramBotUsername = me.username;
          log.info('Telegram bot username fetched', { username: telegramBotUsername });
          console.log(`Telegram bot: @${telegramBotUsername}`);
        } catch (e) {
          log.warn('Could not fetch Telegram bot username', { error: e.message });
        }
      }
    });
  });
}

// CLI entry point
if (process.argv[1]?.endsWith('whatsapp-server.js')) {
  startServer();
}

export default { startServer, app };
