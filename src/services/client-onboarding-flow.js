import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import {
  getContactByPhone, createContact, updateContact,
  getOnboardingSession, createOnboardingSession, updateOnboardingSession,
  createClient, getClient, updateClient,
  saveMessage, getMessages,
  getPendingClientByChatId,
} from '../services/knowledge-base.js';
import * as googleDrive from '../api/google-drive.js';
import * as leadsie from '../api/leadsie.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { auditLog } from '../services/cost-tracker.js';
import config from '../config.js';

const log = logger.child({ workflow: 'onboarding-flow' });

/**
 * Onboarding steps in order.
 * Each step has:
 * - key: the answer field name
 * - next: the next step key (or null for last)
 */
const ONBOARDING_STEPS = [
  { key: 'name', next: 'business_name' },
  { key: 'business_name', next: 'website' },
  { key: 'website', next: 'business_description' },
  { key: 'business_description', next: 'product_service' },
  { key: 'product_service', next: 'target_audience' },
  { key: 'target_audience', next: 'location' },
  { key: 'location', next: 'competitors' },
  { key: 'competitors', next: 'channels_have' },
  { key: 'channels_have', next: 'channels_need' },
  { key: 'channels_need', next: 'complete' },
];

function getStepIndex(stepKey) {
  return ONBOARDING_STEPS.findIndex(s => s.key === stepKey);
}

function getNextStep(currentStep) {
  const step = ONBOARDING_STEPS.find(s => s.key === currentStep);
  return step?.next || 'complete';
}

/**
 * The Sofia onboarding system prompt — she guides the client conversationally.
 */
function buildOnboardingPrompt(session, contactName) {
  const answers = session.answers || {};
  const currentStep = session.current_step;

  const collectedSoFar = Object.entries(answers)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You are currently onboarding a new client through WhatsApp.

${contactName ? `The client's name is *${contactName}*. Always address them by name naturally.` : ''}

CURRENT ONBOARDING STEP: ${currentStep}

INFORMATION ALREADY COLLECTED:
${collectedSoFar || '(none yet)'}

YOUR TASK:
Guide the client through the onboarding process conversationally. You are collecting the following information, one piece at a time:

1. *name* — The client's personal name (first name is fine)
2. *business_name* — Their company/business name
3. *website* — Their website URL
4. *business_description* — What their business does (industry, niche, core offering)
5. *product_service* — Their main product or service they want to advertise
6. *target_audience* — Who are their ideal customers (demographics, interests, pain points)
7. *location* — Where are their customers located (city, country, global?)
8. *competitors* — Who are their main competitors (names, websites)
9. *channels_have* — Which marketing/ad channels do they currently have? (Facebook, Instagram, Google Ads, TikTok, LinkedIn, YouTube, Twitter/X, etc.)
10. *channels_need* — Which channels do they NOT have but want to explore?

RULES:
- Ask ONE question at a time. Be natural and conversational — not like a form.
- After they answer, acknowledge their response warmly before moving to the next question.
- If they provide multiple answers in one message, acknowledge all of them and move ahead.
- Use WhatsApp formatting: *bold*, _italic_
- Be friendly, use their name when you know it.
- Keep your messages concise — 2-3 sentences max.
- If they seem confused, clarify with an example.
- NEVER ask for information you already have (check the collected info above).

RESPONSE FORMAT:
You MUST respond with valid JSON in this exact format:
{
  "message": "Your WhatsApp message to the client",
  "extracted": { "field_name": "extracted value" },
  "next_step": "next_step_key_or_complete"
}

The "extracted" object should contain any NEW information you extracted from the client's latest message.
The "next_step" should be the next field to ask about, or "complete" if all info is collected.
The "message" is what gets sent to the client.

IMPORTANT: Only output the JSON. No other text.`;
}

/**
 * Handle an incoming message from a client during onboarding.
 * Returns the reply message to send back.
 */
export async function handleOnboardingMessage(phone, message, channel = 'whatsapp') {
  // Check if there's an active onboarding session
  let session = getOnboardingSession(phone);
  const contact = getContactByPhone(phone);
  const contactName = contact?.name || session?.answers?.name || null;

  if (!session) {
    // No active session — this shouldn't normally happen, but start one
    session = createOnboardingSession(phone, channel);
  }

  log.info('Onboarding message received', {
    phone,
    step: session.current_step,
    contactName,
  });

  // Save the user's message to conversation history for long-term memory
  saveMessage(phone, channel, 'user', message);

  // Build prompt and send to Claude for natural extraction
  const systemPrompt = buildOnboardingPrompt(session, contactName);

  try {
    const response = await askClaude({
      systemPrompt,
      userMessage: message,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      workflow: 'onboarding-flow',
    });

    // Parse Claude's JSON response
    let parsed;
    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
      log.warn('Failed to parse onboarding response', { text: response.text });
      parsed = null;
    }

    if (!parsed) {
      return "I appreciate your patience! Could you repeat that? I want to make sure I capture everything correctly.";
    }

    // Update answers with extracted information
    const answers = { ...session.answers };
    if (parsed.extracted && typeof parsed.extracted === 'object') {
      for (const [key, value] of Object.entries(parsed.extracted)) {
        if (value && value.toString().trim()) {
          answers[key] = value.toString().trim();
        }
      }
    }

    // Update the contact name if we just learned it
    if (answers.name && !contact?.name) {
      if (contact) {
        updateContact(phone, { name: answers.name });
      } else {
        createContact({ phone, name: answers.name });
      }
    }

    // Determine next step
    const nextStep = parsed.next_step || getNextStep(session.current_step);

    // Update session
    updateOnboardingSession(session.id, {
      answers,
      currentStep: nextStep,
      status: nextStep === 'complete' ? 'completed' : 'in_progress',
    });

    // If onboarding is complete, finalize
    if (nextStep === 'complete') {
      const result = await finalizeOnboarding(phone, session.id, answers);
      saveMessage(phone, channel, 'assistant', result.message);
      return result.message;
    }

    const reply = parsed.message || "Thanks for that! Let me ask you the next question...";
    saveMessage(phone, channel, 'assistant', reply);
    return reply;
  } catch (error) {
    log.error('Onboarding flow error', { error: error.message, phone });
    return "Apologies, I had a small hiccup. Could you repeat your last answer?";
  }
}

/**
 * Finalize the onboarding: create client, Drive folders, Leadsie link, intake doc.
 */
async function finalizeOnboarding(phone, sessionId, answers) {
  log.info('Finalizing onboarding', { phone, answers });

  const steps = [];
  const errors = [];
  let clientId = null;
  let driveFolderUrl = null;
  let brandAssetsFolderUrl = null;
  let leadsieUrl = null;

  // Look up the pending client record to get the plan from Lovable
  const pendingClient = getPendingClientByChatId(phone);
  const clientPlan = pendingClient?.plan || 'smb';

  // Step 1: Create client in knowledge base
  try {
    const competitors = answers.competitors
      ? answers.competitors.split(/[,;]/).map(c => c.trim()).filter(Boolean)
      : [];

    const client = createClient({
      name: answers.business_name || answers.name,
      industry: answers.business_description || null,
      website: answers.website || null,
      description: answers.product_service || answers.business_description || null,
      targetAudience: answers.target_audience || null,
      competitors,
      location: answers.location || null,
      channelsHave: answers.channels_have || null,
      channelsNeed: answers.channels_need || null,
      productService: answers.product_service || null,
      plan: clientPlan,
    });
    clientId = client.id;

    // Link contact to client
    const contact = getContactByPhone(phone);
    if (contact) {
      updateContact(phone, { clientId: client.id });
    } else {
      createContact({ phone, name: answers.name, clientId: client.id });
    }

    steps.push('Client profile created');
  } catch (e) {
    log.error('Failed to create client', { error: e.message });
    errors.push(`Client profile: ${e.message}`);
  }

  // Step 2: Create Google Drive folder structure
  try {
    const clientName = answers.business_name || answers.name;
    const folders = await googleDrive.ensureClientFolders(clientName);
    if (folders && clientId) {
      updateClient(clientId, {
        drive_root_folder_id: folders.root.id,
        drive_reports_folder_id: folders.reports?.id,
        drive_creatives_folder_id: folders.creatives?.id,
        drive_plans_folder_id: folders.strategic_plans?.id,
        drive_brand_assets_folder_id: folders.brand_assets?.id,
      });

      // Make the Brand Assets folder publicly linkable so client can upload
      if (folders.brand_assets?.id) {
        try {
          await googleDrive.shareFolderWithAnyone(folders.brand_assets.id);
          brandAssetsFolderUrl = `https://drive.google.com/drive/folders/${folders.brand_assets.id}`;
        } catch (shareErr) {
          log.warn('Could not share brand assets folder', { error: shareErr.message });
        }
      }

      // Share the root folder so it's accessible
      if (folders.root?.id) {
        try {
          await googleDrive.shareFolderWithAnyone(folders.root.id);
          driveFolderUrl = `https://drive.google.com/drive/folders/${folders.root.id}`;
        } catch (shareErr) {
          log.warn('Could not share root folder', { error: shareErr.message });
        }
      }

      steps.push('Google Drive folders created');
    } else {
      steps.push('Google Drive skipped (not configured)');
    }
  } catch (e) {
    log.warn('Drive folder creation failed', { error: e.message });
    errors.push(`Google Drive: ${e.message}`);
  }

  // Step 3: Create onboarding intake document in Google Drive
  try {
    if (clientId) {
      const client = getClient(clientId);
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      if (folderId) {
        const docContent = buildIntakeDocument(answers);
        await googleDrive.createDocument(
          `${answers.business_name || answers.name} - Client Onboarding Intake`,
          docContent,
          folderId,
        );
        steps.push('Intake document saved');
      }
    }
  } catch (e) {
    log.warn('Intake document creation failed', { error: e.message });
    errors.push(`Intake doc: ${e.message}`);
  }

  // Step 4: Create live conversation log document on Drive
  try {
    if (clientId) {
      const client = getClient(clientId);
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      if (folderId) {
        const clientName = answers.business_name || answers.name;
        const now = new Date().toISOString().split('T')[0];
        const initialContent = `CONVERSATION LOG — ${clientName}\n${'='.repeat(40)}\nStarted: ${now}\nThis document is updated live with every conversation.\n\n`;

        // Include the onboarding conversation that just happened
        const history = getMessages(phone, 100);
        const historyText = history.map(m => {
          const speaker = m.role === 'user' ? answers.name || 'Client' : 'Sofia';
          return `[${speaker}]: ${m.content}`;
        }).join('\n\n');

        const fullContent = initialContent + (historyText ? `--- ONBOARDING CONVERSATION ---\n\n${historyText}\n` : '');

        const logDoc = await googleDrive.createDocument(
          `${clientName} - Conversation Log`,
          fullContent,
          folderId,
        );
        if (logDoc) {
          updateClient(clientId, { conversation_log_doc_id: logDoc.id });
          // Share so it's accessible
          try { await googleDrive.shareFolderWithAnyone(logDoc.id, 'reader'); } catch (e) { /* best effort */ }
          steps.push('Conversation log document created');
        }
      }
    }
  } catch (e) {
    log.warn('Conversation log doc creation failed', { error: e.message });
    errors.push(`Conversation log: ${e.message}`);
  }

  // Step 5: Create Leadsie invite link
  try {
    const platformsToRequest = [];
    const channelsHave = (answers.channels_have || '').toLowerCase();
    const channelsNeed = (answers.channels_need || '').toLowerCase();

    if (channelsHave.includes('facebook') || channelsHave.includes('instagram') || channelsHave.includes('meta') || channelsNeed.includes('facebook') || channelsNeed.includes('instagram') || channelsNeed.includes('meta')) {
      platformsToRequest.push('facebook');
    }
    if (channelsHave.includes('google') || channelsNeed.includes('google')) {
      platformsToRequest.push('google');
    }
    if (channelsHave.includes('tiktok') || channelsNeed.includes('tiktok')) {
      platformsToRequest.push('tiktok');
    }

    // Default to facebook + google if none detected
    if (platformsToRequest.length === 0) {
      platformsToRequest.push('facebook', 'google');
    }

    const invite = await leadsie.createInvite({
      clientName: answers.business_name || answers.name,
      clientEmail: answers.email || '',
      platforms: platformsToRequest,
      message: `Hi ${answers.name}! Please click the link below to grant us access to your ad accounts. It's a secure, one-click process — takes less than 2 minutes!`,
    });

    leadsieUrl = invite.inviteUrl;

    if (clientId) {
      updateOnboardingSession(sessionId, { leadsieInviteId: invite.inviteId });
    }

    steps.push('Leadsie invite created');
  } catch (e) {
    log.warn('Leadsie invite creation failed', { error: e.message });
    errors.push(`Leadsie: ${e.message}`);
  }

  // Update session as completed
  updateOnboardingSession(sessionId, {
    status: 'completed',
    clientId,
    driveFolderUrl,
  });

  // Notify agency owner via WhatsApp
  const ownerSummary = [
    `🎉 *New Client Onboarded via Chat!*\n`,
    `*Name:* ${answers.name}`,
    `*Business:* ${answers.business_name || 'N/A'}`,
    `*Website:* ${answers.website || 'N/A'}`,
    `*Industry:* ${answers.business_description || 'N/A'}`,
    `*Product/Service:* ${answers.product_service || 'N/A'}`,
    `*Target Audience:* ${answers.target_audience || 'N/A'}`,
    `*Location:* ${answers.location || 'N/A'}`,
    `*Competitors:* ${answers.competitors || 'N/A'}`,
    `*Channels (have):* ${answers.channels_have || 'N/A'}`,
    `*Channels (need):* ${answers.channels_need || 'N/A'}`,
    driveFolderUrl ? `\n📁 *Drive:* ${driveFolderUrl}` : '',
    leadsieUrl ? `🔗 *Leadsie:* ${leadsieUrl}` : '',
    errors.length > 0 ? `\n⚠️ *Issues:* ${errors.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  try {
    await sendWhatsApp(ownerSummary);
  } catch (e) {
    log.warn('Failed to notify owner', { error: e.message });
  }

  auditLog({
    action: 'client_onboarded_via_chat',
    workflow: 'onboarding-flow',
    clientId,
    details: { answers, steps, errors },
    approvedBy: 'self-service',
    result: errors.length === 0 ? 'success' : 'partial',
  });

  // Build the completion message for the client
  const completionParts = [
    `🎉 *Amazing, ${answers.name}!* Your onboarding is complete!\n`,
    `I've set everything up for you. Here's what's ready:\n`,
    `✅ Your client profile is saved`,
  ];

  if (driveFolderUrl) {
    completionParts.push(`\n📁 *Your Google Drive folder is ready!*`);
    completionParts.push(driveFolderUrl);

    if (brandAssetsFolderUrl) {
      completionParts.push(`\n🎨 *Upload your brand materials here:*`);
      completionParts.push(brandAssetsFolderUrl);
      completionParts.push(`\nPlease share your *logo, brand book/guidelines, color palette, fonts, past ad creatives, copy examples* — anything that helps me understand your brand.`);
      completionParts.push(`\nThe more you share, the better I can create content that matches your brand perfectly!`);
    } else {
      completionParts.push(`\nPlease share your *logo, brand guidelines, ad creatives, and any brand materials* in the Brand Assets folder.`);
      completionParts.push(`\nThe more you share, the better I can create content that matches your brand perfectly!`);
    }
  }

  if (leadsieUrl) {
    completionParts.push(`\n🔗 *One more thing — grant us access to your ad accounts:*`);
    completionParts.push(leadsieUrl);
    completionParts.push(`\nIt's a secure one-click process. This lets us manage your campaigns without needing your login credentials.`);
  }

  completionParts.push(`\nI'll remember everything about you, ${answers.name}. Whenever you message me, I'll know exactly who you are and where we left off. Welcome aboard! 🚀`);

  return {
    message: completionParts.join('\n'),
    clientId,
    steps,
    errors,
  };
}

/**
 * Build a formatted intake document string from onboarding answers.
 */
function buildIntakeDocument(answers) {
  const now = new Date().toISOString().split('T')[0];
  return [
    `CLIENT ONBOARDING INTAKE`,
    `========================`,
    `Date: ${now}`,
    ``,
    `CONTACT INFORMATION`,
    `-------------------`,
    `Name: ${answers.name || 'N/A'}`,
    `Email: ${answers.email || 'N/A'}`,
    ``,
    `BUSINESS INFORMATION`,
    `--------------------`,
    `Business Name: ${answers.business_name || 'N/A'}`,
    `Website: ${answers.website || 'N/A'}`,
    `Business Description: ${answers.business_description || 'N/A'}`,
    `Main Product/Service: ${answers.product_service || 'N/A'}`,
    ``,
    `TARGET MARKET`,
    `-------------`,
    `Target Audience: ${answers.target_audience || 'N/A'}`,
    `Location: ${answers.location || 'N/A'}`,
    ``,
    `COMPETITIVE LANDSCAPE`,
    `---------------------`,
    `Competitors: ${answers.competitors || 'N/A'}`,
    ``,
    `MARKETING CHANNELS`,
    `------------------`,
    `Currently Active: ${answers.channels_have || 'N/A'}`,
    `Interested In: ${answers.channels_need || 'N/A'}`,
    ``,
    `---`,
    `This document was generated automatically by Sofia during client onboarding.`,
  ].join('\n');
}

/**
 * Start an onboarding session for a client (triggered by owner).
 * Creates the session and sends the first message.
 */
export async function initiateOnboarding(clientPhone, { channel = 'whatsapp', sendFn } = {}) {
  const normalized = clientPhone.replace(/[^0-9]/g, '');

  // Check if there's already an active session
  const existing = getOnboardingSession(normalized);
  if (existing) {
    return { status: 'already_active', session: existing };
  }

  // Create new session with channel
  const session = createOnboardingSession(normalized, channel);

  // Send the welcome message
  const welcomeMessage = [
    `👋 *Welcome!* I'm Sofia, your dedicated account manager.\n`,
    `I'm here to get you onboarded smoothly and make sure we have everything we need to run amazing campaigns for you.\n`,
    `Let's start with the basics — *what's your name?*`,
  ].join('\n');

  try {
    const send = sendFn || sendWhatsApp;
    await send(welcomeMessage, normalized);
  } catch (e) {
    log.error('Failed to send onboarding welcome', { error: e.message, phone: normalized });
  }

  return { status: 'started', session, welcomeMessage };
}

/**
 * Check if a phone number has an active onboarding session.
 */
export function hasActiveOnboarding(phone) {
  const session = getOnboardingSession(phone);
  return session?.status === 'in_progress';
}

/**
 * Get client context for a returning client (by phone).
 * Used by Sofia to greet returning clients by name and pick up context.
 */
export function getClientContextByPhone(phone) {
  const contact = getContactByPhone(phone);
  if (!contact) return null;

  const client = contact.client_id ? getClient(contact.client_id) : null;

  return {
    contactName: contact.name,
    clientId: contact.client_id,
    clientName: client?.name,
    industry: client?.industry,
    website: client?.website,
    description: client?.description,
    productService: client?.product_service,
    targetAudience: client?.target_audience,
    location: client?.location,
    competitors: client?.competitors,
    channelsHave: client?.channels_have,
    channelsNeed: client?.channels_need,
    brandVoice: client?.brand_voice,
    driveFolderId: client?.drive_root_folder_id,
    driveBrandAssetsFolderId: client?.drive_brand_assets_folder_id,
    onboardingComplete: client?.onboarding_complete === 1,
  };
}

export default {
  handleOnboardingMessage,
  initiateOnboarding,
  hasActiveOnboarding,
  getClientContextByPhone,
};
