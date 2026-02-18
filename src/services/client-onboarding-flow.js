import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import {
  getContactByPhone, createContact, updateContact,
  getOnboardingSession, createOnboardingSession, updateOnboardingSession,
  createClient, getClient, updateClient,
  getMessages,
  getPendingClientByChatId, getContactsByClientId,
} from '../services/knowledge-base.js';
import * as googleDrive from '../api/google-drive.js';
import * as googleSheets from '../api/google-sheets.js';
import * as leadsie from '../api/leadsie.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram } from '../api/telegram.js';
import { notifyOwnerMessage } from '../utils/notify-owner.js';
import { auditLog } from '../services/cost-tracker.js';
import config from '../config.js';

const log = logger.child({ workflow: 'onboarding-flow' });

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French',
  de: 'German', it: 'Italian', nl: 'Dutch', ja: 'Japanese', zh: 'Chinese',
};

function getLanguageName(code) {
  return LANGUAGE_NAMES[code] || 'English';
}

/** Return bold text in the correct format for the channel. */
function bold(text, channel) {
  return channel === 'telegram' ? `<b>${text}</b>` : `*${text}*`;
}

/**
 * Onboarding steps in order.
 * Each step has:
 * - key: the answer field name
 * - next: the next step key (or null for last)
 */
const ONBOARDING_STEPS = [
  // Identity
  { key: 'name', next: 'business_name' },
  { key: 'business_name', next: 'website' },
  { key: 'website', next: 'business_description' },
  { key: 'business_description', next: 'product_service' },
  // Offering & Pricing
  { key: 'product_service', next: 'pricing' },
  { key: 'pricing', next: 'avg_transaction_value' },
  { key: 'avg_transaction_value', next: 'target_audience' },
  // Market
  { key: 'target_audience', next: 'location' },
  { key: 'location', next: 'competitors' },
  // Company & Sales
  { key: 'competitors', next: 'company_size' },
  { key: 'company_size', next: 'sales_process' },
  { key: 'sales_process', next: 'sales_cycle' },
  // Marketing Channels
  { key: 'sales_cycle', next: 'channels_have' },
  { key: 'channels_have', next: 'channels_need' },
  { key: 'channels_need', next: 'current_campaigns' },
  // Budget & Goals
  { key: 'current_campaigns', next: 'monthly_budget' },
  { key: 'monthly_budget', next: 'goals' },
  { key: 'goals', next: 'pains' },
  // Wrap-up
  { key: 'pains', next: 'additional_info' },
  { key: 'additional_info', next: 'complete' },
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
function buildOnboardingPrompt(session, contactName, language = 'en') {
  const answers = session.answers || {};
  const currentStep = session.current_step;

  const collectedSoFar = Object.entries(answers)
    .filter(([k]) => k !== 'confirm_details')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const langInstruction = language && language !== 'en'
    ? `\n\nLANGUAGE: You MUST respond ENTIRELY in ${getLanguageName(language)}. All messages, questions, and acknowledgments must be in ${getLanguageName(language)}.\n`
    : '';

  // Determine which steps still need answers
  const allStepKeys = ONBOARDING_STEPS.map(s => s.key);
  const missingSteps = allStepKeys.filter(k => !answers[k]);

  // Special handling for confirm_details step
  const confirmDetailsInstruction = currentStep === 'confirm_details'
    ? `\nSPECIAL STEP — CONFIRM DETAILS:
The client just signed up through the website and we already have some of their information.
Your job is to check if the client confirms or wants to change anything.
- If they CONFIRM (yes, correct, looks good, etc.) → set next_step to "${missingSteps[0] || 'complete'}" and move on.
- If they want to CHANGE something → extract the updated fields into "extracted", present the correction, and set next_step to "confirm_details" again until they confirm.
- Do NOT re-ask for information already collected.\n`
    : '';

  const channelName = session.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const fmtHint = session.channel === 'telegram'
    ? 'Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>'
    : 'Use WhatsApp formatting: *bold*, _italic_';

  return `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You are currently onboarding a new client through ${channelName}.
${langInstruction}
${contactName ? `The client's name is ${bold(contactName, session.channel)}. Always address them by name naturally.` : ''}

CURRENT ONBOARDING STEP: ${currentStep}
${confirmDetailsInstruction}
INFORMATION ALREADY COLLECTED:
${collectedSoFar || '(none yet)'}

YOUR TASK:
Guide the client through the onboarding process conversationally. You are collecting the following information, one piece at a time:

1. *name* — The client's personal name (first name is fine)
2. *business_name* — Their company/business name
3. *website* — Their website or page URL
4. *business_description* — What their business does (industry, niche, core offering)
5. *product_service* — Their main product or service they want to advertise (what do you offer?)
6. *pricing* — How much their product/service costs (price range, pricing model)
7. *avg_transaction_value* — Their average transaction/ticket value
8. *target_audience* — Who are their ideal customers (demographics, interests, behavior)
9. *location* — Where is their target market (country, city, area)
10. *competitors* — Who are their main competitors (names, websites or pages)
11. *company_size* — Their company size (number of people and approximate revenue)
12. *sales_process* — How their sales process works (all online, partially online + offline, all offline)
13. *sales_cycle* — Their typical sales cycle length (how long from lead to closed sale)
14. *channels_have* — Which marketing/ad channels do they currently use? (Facebook, Instagram, Google Ads, TikTok, LinkedIn, YouTube, Twitter/X, etc.)
15. *channels_need* — Which channels do they NOT have but want to explore?
16. *current_campaigns* — What campaigns are they currently running and how much are they investing?
17. *monthly_budget* — Their monthly marketing budget (they can adjust this any time)
18. *goals* — Their key goals and targets for marketing
19. *pains* — Their key pain points, gaps, or challenges they're facing
20. *additional_info* — Based on everything collected, ask 1-2 relevant follow-up questions specific to THIS client's business. If nothing significant is missing, just wrap up.

RULES:
- Ask ONE question at a time. Be natural and conversational — not like a form.
- After they answer, acknowledge their response warmly before moving to the next question.
- If they provide multiple answers in one message, acknowledge all of them and move ahead.
- ${fmtHint}
- Be friendly, use their name when you know it.
- Keep your messages concise — 2-3 sentences max.
- If they seem confused, clarify with an example.
- NEVER ask for information you already have (check the collected info above).
- SKIP any step that is already answered — jump to the next unanswered step.
- If the client says they don't know, aren't sure, or want to skip a question — accept it gracefully, record "skipped" as the value, and move on. Occasionally say something like "No worries, we can come back to this later!"
- For the *additional_info* step: think about what else would be helpful to know for THIS specific business. If nothing important is missing, just wrap up warmly.

RESPONSE FORMAT:
You MUST respond with valid JSON in this exact format:
{
  "message": "Your message to the client (use ${channelName} formatting)",
  "extracted": { "field_name": "extracted value" },
  "next_step": "next_step_key_or_complete"
}

The "extracted" object should contain any NEW information you extracted from the client's latest message.
The "next_step" should be the NEXT UNANSWERED field to ask about, or "complete" if all info is collected.
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

  // Load conversation history so Claude can resolve references like "same as above"
  // History is saved to DB by callers (addToHistory in whatsapp-server.js)
  const conversationHistory = getMessages(phone, 40);

  // Build prompt and send to Claude for natural extraction
  const sessionLang = session.language || 'en';
  const systemPrompt = buildOnboardingPrompt(session, contactName, sessionLang);

  // Build messages array: full conversation history + current message
  const messages = [...conversationHistory, { role: 'user', content: message }];

  try {
    const response = await askClaude({
      systemPrompt,
      messages,
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
        createContact({ phone, name: answers.name, channel });
      }
    }

    // Determine next step
    const nextStep = parsed.next_step || getNextStep(session.current_step);

    // --- Transition from confirm_details: send capabilities + Leadsie + brand request ---
    if (session.current_step === 'confirm_details' && nextStep !== 'confirm_details' && nextStep !== 'complete') {
      const ch = session.channel || channel;

      // Generate Leadsie invite early (default: Facebook + Google)
      let leadsieUrl = null;
      try {
        const invite = await leadsie.createInvite({
          clientName: answers.business_name || answers.name,
          clientEmail: answers.email || '',
          platforms: ['facebook', 'google'],
          message: `Hi ${answers.name}! Please click the link below to grant us access to your ad accounts.`,
        });
        leadsieUrl = invite.inviteUrl;
        answers._leadsie_url = leadsieUrl;
        answers._leadsie_invite_id = invite.inviteId;
      } catch (e) {
        log.warn('Leadsie invite during onboarding failed', { error: e.message });
      }

      // Look up plan for capabilities message
      const pendingClient = getPendingClientByChatId(phone);
      const plan = (pendingClient?.plan || 'smb').toLowerCase();

      const nextStepsMsg = buildNextStepsMessage(answers, plan, leadsieUrl, sessionLang, ch);

      // Update session to next business question
      updateOnboardingSession(session.id, { answers, currentStep: nextStep });

      const reply = parsed.message || 'Great, everything looks good!';
      return [reply, nextStepsMsg];
    }

    // Update session
    updateOnboardingSession(session.id, {
      answers,
      currentStep: nextStep,
      status: nextStep === 'complete' ? 'completed' : 'in_progress',
    });

    // If onboarding is complete, send thinking message then finalize
    if (nextStep === 'complete') {
      const ch = session.channel || channel;
      const thinkingMsg = sessionLang === 'es'
        ? 'Casi listo! Estoy preparando tu carpeta de Google Drive, documentos y accesos... Dame un momento.'
        : sessionLang === 'pt'
          ? 'Quase lá! Configurando seu Google Drive, documentos e acessos... Me dê um momento.'
          : 'Almost there! Setting up your Google Drive, intake docs, and access requests... Give me a moment.';
      try {
        const send = ch === 'telegram' ? sendTelegram : sendWhatsApp;
        await send(thinkingMsg, phone);
      } catch (e) { /* best effort */ }
      const result = await finalizeOnboarding(phone, session.id, answers, ch);
      return result.message;
    }

    const reply = parsed.message || "Thanks for that! Let me ask you the next question...";
    return reply;
  } catch (error) {
    log.error('Onboarding flow error', { error: error.message, phone });
    return "Apologies, I had a small hiccup. Could you repeat your last answer?";
  }
}

/**
 * Finalize the onboarding: create client, Drive folders, Leadsie link, intake doc.
 */
async function finalizeOnboarding(phone, sessionId, answers, channel = 'whatsapp') {
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
      pricing: answers.pricing || null,
      pains: answers.pains || null,
      companySize: answers.company_size || null,
      salesCycle: answers.sales_cycle || null,
      avgTransactionValue: answers.avg_transaction_value || null,
      currentCampaigns: answers.current_campaigns || null,
      salesProcess: answers.sales_process || null,
      additionalInfo: answers.additional_info || null,
      goals: answers.goals ? [answers.goals] : null,
      monthlyBudgetCents: parseBudgetToCents(answers.monthly_budget),
    });
    clientId = client.id;

    // Link contact to client
    const contact = getContactByPhone(phone);
    if (contact) {
      updateContact(phone, { clientId: client.id });
    } else {
      createContact({ phone, name: answers.name, clientId: client.id, channel });
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

  // Step 3.5: Create Google Sheets Client Profile
  let profileSheetUrl = null;
  try {
    if (clientId) {
      const client = getClient(clientId);
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      if (folderId) {
        const result = await createClientProfileSheet(answers, pendingClient, clientPlan, folderId);
        if (result) {
          profileSheetUrl = result.url;
          updateClient(clientId, { drive_profile_sheet_id: result.spreadsheetId });
          try { await googleDrive.shareFolderWithAnyone(result.spreadsheetId, 'reader'); } catch (e) { /* best effort */ }
          steps.push('Client profile spreadsheet created');
        }
      }
    }
  } catch (e) {
    log.warn('Client profile sheet creation failed', { error: e.message });
    errors.push(`Profile sheet: ${e.message}`);
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

  // Step 5: Create Leadsie invite link (or reuse one already sent during onboarding)
  if (answers._leadsie_url) {
    leadsieUrl = answers._leadsie_url;
    steps.push('Leadsie invite (sent during onboarding)');

    // Check if client mentioned additional platforms — create a supplemental invite
    const channelsHave = (answers.channels_have || '').toLowerCase();
    const channelsNeed = (answers.channels_need || '').toLowerCase();
    const needsTikTok = (channelsHave.includes('tiktok') || channelsNeed.includes('tiktok'));
    if (needsTikTok) {
      try {
        const extra = await leadsie.createInvite({
          clientName: answers.business_name || answers.name,
          clientEmail: answers.email || '',
          platforms: ['tiktok'],
          message: `Hi ${answers.name}! We noticed you use TikTok — please also grant us access to your TikTok ad account.`,
        });
        leadsieUrl = extra.inviteUrl; // overwrite with the more complete invite
        steps.push('TikTok Leadsie invite created');
      } catch (e) {
        log.warn('Supplemental TikTok Leadsie invite failed', { error: e.message });
      }
    }
  } else {
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
    `*Pricing:* ${answers.pricing || 'N/A'}`,
    `*Avg Transaction:* ${answers.avg_transaction_value || 'N/A'}`,
    `*Target Audience:* ${answers.target_audience || 'N/A'}`,
    `*Location:* ${answers.location || 'N/A'}`,
    `*Competitors:* ${answers.competitors || 'N/A'}`,
    `*Company Size:* ${answers.company_size || 'N/A'}`,
    `*Sales Process:* ${answers.sales_process || 'N/A'}`,
    `*Sales Cycle:* ${answers.sales_cycle || 'N/A'}`,
    `*Channels (have):* ${answers.channels_have || 'N/A'}`,
    `*Channels (need):* ${answers.channels_need || 'N/A'}`,
    `*Current Campaigns:* ${answers.current_campaigns || 'N/A'}`,
    `*Monthly Budget:* ${answers.monthly_budget || 'N/A'}`,
    `*Goals:* ${answers.goals || 'N/A'}`,
    `*Pains:* ${answers.pains || 'N/A'}`,
    driveFolderUrl ? `\n📁 *Drive:* ${driveFolderUrl}` : '',
    profileSheetUrl ? `📊 *Profile Sheet:* ${profileSheetUrl}` : '',
    leadsieUrl ? `🔗 *Leadsie:* ${leadsieUrl}` : '',
    errors.length > 0 ? `\n⚠️ *Issues:* ${errors.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  try {
    await notifyOwnerMessage(ownerSummary);
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

  // Build the completion message for the client (channel-aware formatting)
  const b = (text) => bold(text, channel);
  const completionParts = [
    `🎉 ${b(`Amazing, ${answers.name}!`)} Your onboarding is complete!\n`,
    `I've set everything up for you. Here's what's ready:\n`,
    `✅ Your client profile is saved`,
  ];

  if (driveFolderUrl) {
    completionParts.push(`\n📁 ${b('Your Google Drive folder is ready!')}`);
    completionParts.push(driveFolderUrl);

    if (brandAssetsFolderUrl) {
      completionParts.push(`\n🎨 ${b('Upload your brand materials here:')}`);
      completionParts.push(brandAssetsFolderUrl);
      completionParts.push(`\nPlease share your ${b('logo, brand book/guidelines, color palette, fonts, past ad creatives, copy examples')} — anything that helps me understand your brand.`);
      completionParts.push(`\nThe more you share, the better I can create content that matches your brand perfectly!`);
    } else {
      completionParts.push(`\nPlease share your ${b('logo, brand guidelines, ad creatives, and any brand materials')} in the Brand Assets folder.`);
      completionParts.push(`\nThe more you share, the better I can create content that matches your brand perfectly!`);
    }
  }

  if (leadsieUrl) {
    completionParts.push(`\n🔗 ${b('One more thing — grant us access to your ad accounts:')}`);
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
 * Parse free-text budget value (e.g. "$5,000", "5k", "5000") into cents.
 */
function parseBudgetToCents(budgetStr) {
  if (!budgetStr || budgetStr === 'skipped') return 0;
  const cleaned = budgetStr.replace(/[$€£,\s]/g, '').toLowerCase();
  let num = parseFloat(cleaned);
  if (cleaned.endsWith('k')) num = parseFloat(cleaned) * 1000;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

/**
 * Create a Google Sheets client profile with all onboarding data.
 */
async function createClientProfileSheet(answers, pendingData, plan, folderId) {
  const clientName = answers.business_name || answers.name || 'New Client';
  const now = new Date().toISOString().split('T')[0];
  const title = `${clientName} - Client Profile`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const { spreadsheetId } = spreadsheet;

  const profileData = [
    ['CLIENT PROFILE', ''],
    ['Generated', now],
    ['Plan', plan || 'N/A'],
    ['Client Code', pendingData?.token || 'N/A'],
    ['', ''],
    ['CONTACT INFORMATION', ''],
    ['Name', answers.name || 'N/A'],
    ['Email', answers.email || pendingData?.email || 'N/A'],
    ['Phone', pendingData?.phone || 'N/A'],
    ['', ''],
    ['BUSINESS INFORMATION', ''],
    ['Business Name', answers.business_name || 'N/A'],
    ['Website', answers.website || 'N/A'],
    ['Business Description', answers.business_description || 'N/A'],
    ['Main Product/Service', answers.product_service || 'N/A'],
    ['Pricing', answers.pricing || 'N/A'],
    ['Avg Transaction Value', answers.avg_transaction_value || 'N/A'],
    ['Company Size', answers.company_size || 'N/A'],
    ['', ''],
    ['TARGET MARKET', ''],
    ['Target Audience', answers.target_audience || 'N/A'],
    ['Location', answers.location || 'N/A'],
    ['Competitors', answers.competitors || 'N/A'],
    ['', ''],
    ['SALES & OPERATIONS', ''],
    ['Sales Process', answers.sales_process || 'N/A'],
    ['Sales Cycle', answers.sales_cycle || 'N/A'],
    ['', ''],
    ['MARKETING CHANNELS', ''],
    ['Currently Active', answers.channels_have || 'N/A'],
    ['Interested In', answers.channels_need || 'N/A'],
    ['Current Campaigns & Investment', answers.current_campaigns || 'N/A'],
    ['Monthly Marketing Budget', answers.monthly_budget || 'N/A'],
    ['', ''],
    ['GOALS & CHALLENGES', ''],
    ['Key Goals/Targets', answers.goals || 'N/A'],
    ['Key Pains/Gaps', answers.pains || 'N/A'],
    ['', ''],
    ['ADDITIONAL NOTES', ''],
    ['Additional Info', answers.additional_info || 'N/A'],
    ['', ''],
    ['---', ''],
    ['Generated by Sofia', `Onboarding completed ${now}`],
  ];

  await googleSheets.writeData(spreadsheetId, 'Sheet1!A1', profileData);

  // Format: bold title row with dark background, auto-resize columns
  try {
    await googleSheets.formatSheet(spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.2, green: 0.3, blue: 0.6 },
              textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 },
        },
      },
    ]);
  } catch (e) {
    log.warn('Could not format profile sheet', { error: e.message });
  }

  return spreadsheet;
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
    `Pricing: ${answers.pricing || 'N/A'}`,
    `Average Transaction Value: ${answers.avg_transaction_value || 'N/A'}`,
    `Company Size: ${answers.company_size || 'N/A'}`,
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
    `SALES & OPERATIONS`,
    `------------------`,
    `Sales Process: ${answers.sales_process || 'N/A'}`,
    `Sales Cycle: ${answers.sales_cycle || 'N/A'}`,
    ``,
    `MARKETING CHANNELS`,
    `------------------`,
    `Currently Active: ${answers.channels_have || 'N/A'}`,
    `Interested In: ${answers.channels_need || 'N/A'}`,
    `Current Campaigns & Investment: ${answers.current_campaigns || 'N/A'}`,
    `Monthly Marketing Budget: ${answers.monthly_budget || 'N/A'}`,
    ``,
    `GOALS & CHALLENGES`,
    `------------------`,
    `Key Goals/Targets: ${answers.goals || 'N/A'}`,
    `Key Pains/Gaps: ${answers.pains || 'N/A'}`,
    ``,
    `ADDITIONAL NOTES`,
    `----------------`,
    `${answers.additional_info || 'N/A'}`,
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
  const b = (text) => bold(text, channel);
  const welcomeMessage = [
    `👋 ${b('Welcome!')} I'm Sofia, your dedicated account manager.\n`,
    `I'm here to get you onboarded smoothly and make sure we have everything we need to run amazing campaigns for you.\n`,
    `Let's start with the basics — ${b("what's your name?")}`,
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

  // Contact without a client_id means onboarding was never completed — not a known client yet
  if (!contact.client_id) return null;

  const client = getClient(contact.client_id);

  // Get all channels this client is connected on
  const channels = contact.client_id
    ? getContactsByClientId(contact.client_id).map(c => ({ phone: c.phone, channel: c.channel || 'whatsapp' }))
    : [{ phone: contact.phone, channel: contact.channel || 'whatsapp' }];

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
    pricing: client?.pricing,
    companySize: client?.company_size,
    salesProcess: client?.sales_process,
    salesCycle: client?.sales_cycle,
    avgTransactionValue: client?.avg_transaction_value,
    currentCampaigns: client?.current_campaigns,
    monthlyBudget: client?.monthly_budget_cents,
    goals: client?.goals,
    pains: client?.pains,
    additionalInfo: client?.additional_info,
    driveFolderId: client?.drive_root_folder_id,
    driveBrandAssetsFolderId: client?.drive_brand_assets_folder_id,
    profileSheetId: client?.drive_profile_sheet_id,
    onboardingComplete: client?.onboarding_complete === 1,
    channels,
  };
}

/**
 * Build the personalized welcome message that presents all form data for confirmation.
 * Sent when a client arrives via token (already signed up on the website).
 */
// Plan metadata for welcome messages
const PLAN_INFO = {
  smb:        { modules: 3, dailyMessages: 20, label: 'SMB' },
  medium:     { modules: 6, dailyMessages: 50, label: 'Medium' },
  enterprise: { modules: 8, dailyMessages: 200, label: 'Enterprise' },
};

export function buildPersonalizedWelcome(pendingData, language = 'en', channel = 'whatsapp') {
  const b = (text) => bold(text, channel);
  const name = pendingData.name || '';
  const token = pendingData.token || '';
  const plan = (pendingData.plan || 'smb').toLowerCase();
  const planInfo = PLAN_INFO[plan] || PLAN_INFO.smb;

  // Translated labels for the data summary
  const labels = {
    en: { plan: 'Plan', website: 'Website', business: 'Business', description: 'Description', product: 'Product/Service', email: 'Email' },
    es: { plan: 'Plan', website: 'Sitio web', business: 'Empresa', description: 'Descripción', product: 'Producto/Servicio', email: 'Email' },
    pt: { plan: 'Plano', website: 'Website', business: 'Empresa', description: 'Descrição', product: 'Produto/Serviço', email: 'Email' },
  };
  const l = labels[language] || labels.en;

  // Plan description in the correct language
  const planDesc = {
    en: `${planInfo.label} (${planInfo.modules} modules, ${planInfo.dailyMessages} messages/day)`,
    es: `${planInfo.label} (${planInfo.modules} módulos, ${planInfo.dailyMessages} mensajes/día)`,
    pt: `${planInfo.label} (${planInfo.modules} módulos, ${planInfo.dailyMessages} mensagens/dia)`,
  };

  // Build data summary lines
  const dataLines = [];
  dataLines.push(`  • ${b(l.plan + ':')} ${planDesc[language] || planDesc.en}`);
  if (pendingData.website) dataLines.push(`  • ${b(l.website + ':')} ${pendingData.website}`);
  if (pendingData.business_name) dataLines.push(`  • ${b(l.business + ':')} ${pendingData.business_name}`);
  if (pendingData.business_description) dataLines.push(`  • ${b(l.description + ':')} ${pendingData.business_description}`);
  if (pendingData.product_service) dataLines.push(`  • ${b(l.product + ':')} ${pendingData.product_service}`);
  if (pendingData.email) dataLines.push(`  • ${b(l.email + ':')} ${pendingData.email}`);
  const dataSummary = dataLines.join('\n');

  if (language === 'pt') {
    return [
      `Oi${name ? `, ${b(name)}` : ''}! Eu sou a Sofia, Estrategista da Chama e agora sua e da sua equipe assistente de marketing pessoal 24/7. É ótimo ter você a bordo!`,
      ``,
      `Seu código de cliente: ${b(token)}`,
      ``,
      `Vejo que você se cadastrou recentemente com os seguintes dados:\n${dataSummary}`,
      ``,
      `Está tudo correto?\n\n1️⃣ ✅ Correto — vamos continuar\n2️⃣ ❌ Incorreto — gostaria de fazer alterações`,
    ].join('\n');
  }

  if (language === 'es') {
    return [
      `¡Hola${name ? `, ${b(name)}` : ''}! Soy Sofia, Estratega de Chama y ahora tu asistente de marketing personal 24/7 y la de tu equipo. ¡Es genial tenerte a bordo!`,
      ``,
      `Tu código de cliente: ${b(token)}`,
      ``,
      `Veo que te has registrado recientemente con los siguientes datos:\n${dataSummary}`,
      ``,
      `¿Está todo correcto?\n\n1️⃣ ✅ Correcto — continuemos\n2️⃣ ❌ Incorrecto — quiero hacer cambios`,
    ].join('\n');
  }

  // Default: English
  return [
    `Hi${name ? `, ${b(name)}` : ''}! I am Sofia, Chama's Strategist and now yours and your team's personal 24/7 marketing assistant. It is great to have you onboard!`,
    ``,
    `Your client code: ${b(token)}`,
    ``,
    `I see you've recently signed up with the following details:\n${dataSummary}`,
    ``,
    `Is this correct?\n\n1️⃣ ✅ Correct — let's continue\n2️⃣ ❌ Incorrect — I'd like to make changes`,
  ].join('\n');
}

/**
 * Build the "next steps" message sent after the client confirms their signup data.
 * Explains capabilities based on plan, includes Leadsie link, and asks for brand materials.
 */
function buildNextStepsMessage(answers, plan, leadsieUrl, language = 'en', channel = 'whatsapp') {
  const b = (text) => bold(text, channel);
  const name = answers.name || '';

  // Build capabilities list based on plan (progressively more features)
  function capsList(lang) {
    const c = {
      en: {
        strategic: `📊 ${b('Strategic Planning')} — Campaign briefs and media plans`,
        competitor: `🔍 ${b('Competitor Intelligence')} — Analyze competitor ads and strategies`,
        creative: `🎨 ${b('Creative Production')} — Ad images, copy, and video content`,
        audience: `👥 ${b('Audience Analysis')} — Target audience research and segmentation`,
        keyword: `📝 ${b('Keyword Research')} — Search volume, keyword ideas, and SEO opportunities`,
        performance: `📈 ${b('Performance Tracking')} — Campaign reports and trend analysis`,
        automation: `🔄 ${b('Automation')} — Scheduled monitoring, anomaly detection, and budget optimization`,
        reporting: `📋 ${b('Advanced Reporting')} — Google Slides presentations and executive reviews`,
      },
      es: {
        strategic: `📊 ${b('Planificación Estratégica')} — Briefings de campaña y planes de medios`,
        competitor: `🔍 ${b('Inteligencia Competitiva')} — Análisis de anuncios y estrategias de la competencia`,
        creative: `🎨 ${b('Producción Creativa')} — Imágenes, textos y vídeos para anuncios`,
        audience: `👥 ${b('Análisis de Audiencia')} — Investigación y segmentación del público objetivo`,
        keyword: `📝 ${b('Investigación de Keywords')} — Volumen de búsqueda, ideas y oportunidades SEO`,
        performance: `📈 ${b('Seguimiento de Rendimiento')} — Informes de campañas y análisis de tendencias`,
        automation: `🔄 ${b('Automatización')} — Monitoreo programado, detección de anomalías y optimización`,
        reporting: `📋 ${b('Reportes Avanzados')} — Presentaciones en Google Slides y revisiones ejecutivas`,
      },
      pt: {
        strategic: `📊 ${b('Planejamento Estratégico')} — Briefings de campanha e planos de mídia`,
        competitor: `🔍 ${b('Inteligência Competitiva')} — Análise de anúncios e estratégias da concorrência`,
        creative: `🎨 ${b('Produção Criativa')} — Imagens, textos e vídeos para anúncios`,
        audience: `👥 ${b('Análise de Audiência')} — Pesquisa e segmentação do público-alvo`,
        keyword: `📝 ${b('Pesquisa de Keywords')} — Volume de busca, ideias e oportunidades de SEO`,
        performance: `📈 ${b('Acompanhamento de Performance')} — Relatórios de campanha e análise de tendências`,
        automation: `🔄 ${b('Automação')} — Monitoramento agendado, detecção de anomalias e otimização`,
        reporting: `📋 ${b('Relatórios Avançados')} — Apresentações em Google Slides e revisões executivas`,
      },
    };
    const t = c[lang] || c.en;
    const items = [t.strategic, t.competitor, t.creative];
    if (plan !== 'smb') items.push(t.audience, t.keyword, t.performance);
    if (plan === 'enterprise') items.push(t.automation, t.reporting);
    return items.join('\n');
  }

  const caps = capsList(language);

  if (language === 'pt') {
    const parts = [
      `Ótimo${name ? `, ${name}` : ''}! Agora deixa eu te contar o que posso fazer por você como sua assistente de marketing 24/7:\n`,
      caps,
      `\nPara começar a trabalhar nas suas campanhas, preciso de algumas coisas:`,
    ];
    if (leadsieUrl) {
      parts.push(`\n1️⃣ 🔗 ${b('Conceda acesso às suas contas de anúncios:')}`);
      parts.push(leadsieUrl);
      parts.push(`É um processo seguro de um clique — leva menos de 2 minutos!`);
    }
    parts.push(`\n${leadsieUrl ? '2️⃣' : '1️⃣'} 🎨 ${b('Comece a reunir seus materiais de marca')} (logo, guia de marca, paleta de cores, fontes, criativos anteriores) — vou criar uma pasta dedicada para você em breve.`);
    parts.push(`\nAgora, vou fazer mais algumas perguntas sobre seu negócio para personalizar suas campanhas...`);
    return parts.join('\n');
  }

  if (language === 'es') {
    const parts = [
      `¡Genial${name ? `, ${name}` : ''}! Ahora déjame contarte lo que puedo hacer por ti como tu asistente de marketing 24/7:\n`,
      caps,
      `\nPara empezar a trabajar en tus campañas, necesito un par de cosas:`,
    ];
    if (leadsieUrl) {
      parts.push(`\n1️⃣ 🔗 ${b('Concede acceso a tus cuentas publicitarias:')}`);
      parts.push(leadsieUrl);
      parts.push(`¡Es un proceso seguro de un clic — toma menos de 2 minutos!`);
    }
    parts.push(`\n${leadsieUrl ? '2️⃣' : '1️⃣'} 🎨 ${b('Empieza a reunir tus materiales de marca')} (logo, guía de marca, paleta de colores, fuentes, creativos anteriores) — te crearé una carpeta dedicada en breve.`);
    parts.push(`\nAhora, déjame hacerte algunas preguntas más sobre tu negocio para personalizar tus campañas...`);
    return parts.join('\n');
  }

  // English (default)
  const parts = [
    `Great${name ? `, ${name}` : ''}! Now let me tell you what I can help you with as your 24/7 marketing assistant:\n`,
    caps,
    `\nTo get started with your campaigns, I need a couple of things:`,
  ];
  if (leadsieUrl) {
    parts.push(`\n1️⃣ 🔗 ${b('Grant us access to your ad accounts:')}`);
    parts.push(leadsieUrl);
    parts.push(`It's a secure one-click process — takes less than 2 minutes!`);
  }
  parts.push(`\n${leadsieUrl ? '2️⃣' : '1️⃣'} 🎨 ${b('Start gathering your brand materials')} (logo, brand guidelines, color palette, fonts, past ad creatives) — I'll set up a dedicated folder for you shortly.`);
  parts.push(`\nNow, let me ask you a few more questions about your business to personalize your campaigns...`);
  return parts.join('\n');
}

export default {
  handleOnboardingMessage,
  initiateOnboarding,
  hasActiveOnboarding,
  getClientContextByPhone,
  buildPersonalizedWelcome,
};
