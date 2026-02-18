import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram } from '../api/telegram.js';
import { getAllClientContacts, getLastClientMessageTime, getContactChannel } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'client-check-in' });

const QUIET_HOURS_START = 21; // 9 PM
const QUIET_HOURS_END = 8;   // 8 AM

// Follow-up intervals (milliseconds)
const INTERVALS = {
  postOnboarding: 24 * 60 * 60 * 1000,  // 24h after onboarding if no response
  inactive: 48 * 60 * 60 * 1000,         // 48h of inactivity
};

function isQuietHours() {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * Daily proactive client check-in.
 * Iterates through all active clients and sends follow-ups where needed.
 */
export async function runClientCheckIn() {
  if (isQuietHours()) {
    log.info('Skipping client check-in: quiet hours');
    return { skipped: true, reason: 'quiet hours' };
  }

  log.info('Starting daily client check-in');

  const contacts = getAllClientContacts();
  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const contact of contacts) {
    try {
      const chatId = contact.phone;
      const channel = getContactChannel(chatId);
      const lastMessage = getLastClientMessageTime(chatId);
      const now = new Date();

      // Determine what kind of check-in is needed
      let checkInType = null;

      if (!lastMessage) {
        // Never responded after onboarding
        checkInType = 'postOnboarding';
      } else {
        const timeSinceLastMessage = now - lastMessage;
        if (timeSinceLastMessage > INTERVALS.inactive) {
          checkInType = 'inactive';
        }
      }

      if (!checkInType) {
        results.skipped++;
        continue;
      }

      // Generate personalized check-in message
      const clientName = contact.name || 'there';
      const businessName = contact.client_name || '';
      const message = await generateCheckInMessage(clientName, businessName, checkInType, contact.language || 'en');

      // Send via appropriate channel
      const send = channel === 'telegram' ? sendTelegram : sendWhatsApp;
      await send(message, chatId);

      results.sent++;
      log.info('Client check-in sent', { contact: chatId, type: checkInType, channel });
    } catch (e) {
      results.errors++;
      log.error('Client check-in failed', { contact: contact.phone, error: e.message });
    }
  }

  log.info('Client check-in completed', results);
  return results;
}

async function generateCheckInMessage(contactName, clientName, type, language) {
  const prompts = {
    postOnboarding: `Generate a warm follow-up message from Sofia (agency account manager) to ${contactName}${clientName ? ` from ${clientName}` : ''}. They just completed onboarding but haven't sent any messages yet. Ask if they have any questions, remind them about sharing brand assets and creative materials, and offer to help set up their first campaign. Keep it under 150 words. Be warm and proactive, not pushy.`,
    inactive: `Generate a friendly check-in message from Sofia (agency account manager) to ${contactName}${clientName ? ` from ${clientName}` : ''}. They haven't been in touch for a couple of days. Ask how things are going, mention you're here to help with campaigns, creative, reporting, or strategy. Keep it under 100 words. Be helpful, not pushy.`,
  };

  const langInstruction = language !== 'en'
    ? ` Write the message entirely in ${language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English'}.`
    : '';

  const response = await askClaude({
    systemPrompt: `You are Sofia, a warm PPC agency account manager. Write a short, natural WhatsApp check-in message. Use WhatsApp formatting (*bold*, _italic_). Do not include any system/meta text, just the message itself.${langInstruction}`,
    userMessage: prompts[type] || prompts.inactive,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    workflow: 'client-check-in',
  });

  return response.text;
}

export default runClientCheckIn;
