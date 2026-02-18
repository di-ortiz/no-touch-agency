/**
 * Dual-channel owner notification utility.
 * Sends every owner-facing notification to both WhatsApp and Telegram in parallel.
 * If Telegram is not configured, it gracefully skips.
 */
import {
  sendWhatsApp,
  sendAlert as sendWhatsAppAlert,
  sendMorningBriefing as sendWhatsAppBriefing,
  sendApprovalRequest as sendWhatsAppApproval,
} from '../api/whatsapp.js';
import {
  sendTelegram,
  sendAlert as sendTelegramAlert,
  sendMorningBriefing as sendTelegramBriefing,
  sendApprovalRequest as sendTelegramApproval,
} from '../api/telegram.js';
import config from '../config.js';
import logger from './logger.js';

const log = logger.child({ module: 'notify-owner' });

/**
 * Run WhatsApp + Telegram calls in parallel; log failures but don't throw.
 */
async function dual(waFn, tgFn) {
  const results = await Promise.allSettled([
    waFn(),
    config.TELEGRAM_OWNER_CHAT_ID ? tgFn() : Promise.resolve(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      log.warn('Owner notification channel failed', { error: r.reason?.message });
    }
  }
}

/** Send an alert (emoji + title + body) to the owner on both channels. */
export async function notifyOwnerAlert(level, title, body) {
  await dual(
    () => sendWhatsAppAlert(level, title, body),
    () => sendTelegramAlert(level, title, body),
  );
}

/** Send a plain text message to the owner on both channels. */
export async function notifyOwnerMessage(message) {
  await dual(
    () => sendWhatsApp(message),
    () => sendTelegram(message),
  );
}

/** Send the structured morning briefing to the owner on both channels. */
export async function notifyOwnerBriefing(briefing) {
  await dual(
    () => sendWhatsAppBriefing(briefing),
    () => sendTelegramBriefing(briefing),
  );
}

/** Send an approval request to the owner on both channels. */
export async function notifyOwnerApproval(action) {
  await dual(
    () => sendWhatsAppApproval(action),
    () => sendTelegramApproval(action),
  );
  return action.id;
}
