import { askClaude } from '../api/anthropic.js';
import {
  insertContentItem,
  updateContentItem,
  findPendingApproval,
} from '../api/supabase-content-queue.js';
import logger from '../utils/logger.js';

const log = logger.child({ service: 'content-scheduler' });

// ─── DETECT SCHEDULING INTENT ─────────────────────────────────────────────────

/**
 * Use Claude Haiku to determine if a message is a content scheduling request,
 * an approval/rejection, or a modification request.
 *
 * @param {string} message - The raw WhatsApp message text
 * @returns {object} Parsed intent object
 */
async function detectSchedulingIntent(message) {
  const systemPrompt = `You are parsing a WhatsApp message from a small business client to determine if they want to schedule content.
Respond ONLY with a JSON object — no markdown, no explanation.

If it is a scheduling request:
{
  "is_scheduling": true,
  "content_type": "social_post" | "meta_ad" | "blog" | "email",
  "platform": "instagram" | "facebook" | "linkedin" | "meta_ads" | "wordpress" | "mailchimp" | null,
  "content_brief": "<what they want the content to be about, in their words>",
  "scheduled_date": "<ISO date if they mentioned a date, else null>",
  "scheduled_time": "<HH:MM if they mentioned a time, else null>"
}

If it is an approval response (sim, ok, aprovado, confirmar, yes, approve, etc.):
{ "is_approval": true, "intent": "approve" }

If it is a rejection response (não, cancela, mudei de ideia, no, cancel, etc.):
{ "is_approval": true, "intent": "reject" }

If it is a modification request (muda, altera, troca, change, edit, etc.):
{ "is_modification": true, "change_request": "<what they want changed>" }

If none of the above:
{ "is_scheduling": false, "is_approval": false, "is_modification": false }`;

  try {
    const result = await askClaude({
      systemPrompt,
      userMessage: message,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 300,
      workflow: 'content-scheduler-intent',
    });

    return JSON.parse(result.text.replace(/```json|```/g, '').trim());
  } catch (error) {
    log.error('Failed to detect scheduling intent', { error: error.message });
    return { is_scheduling: false, is_approval: false, is_modification: false };
  }
}

// ─── CREATE CONTENT PREVIEW ───────────────────────────────────────────────────

/**
 * Generate content and a WhatsApp preview message for client approval.
 *
 * @param {object} intent - Parsed scheduling intent
 * @param {object} clientContext - Client profile/context from knowledge base
 * @returns {object|null} { content_text, headline, preview_message }
 */
async function createContentPreview(intent, clientContext) {
  const clientName = clientContext.clientName || clientContext.contactName || 'the client';
  const brandSummary = clientContext.productService || clientContext.industry || 'their business';
  const platform = intent.platform || 'Instagram';

  const scheduledInfo = [];
  if (intent.scheduled_date) scheduledInfo.push(`Date: ${intent.scheduled_date}`);
  if (intent.scheduled_time) scheduledInfo.push(`Time: ${intent.scheduled_time}`);
  const scheduleStr = scheduledInfo.length > 0 ? scheduledInfo.join(', ') : 'Tomorrow at noon (default)';

  const prompt = `You are SOFIA, a WhatsApp AI marketing agent.
Create content for a ${intent.content_type} for "${clientName}".
Business: ${brandSummary}
Brief: ${intent.content_brief}
Platform: ${platform}
Scheduled for: ${scheduleStr}

Write the content in Brazilian Portuguese.

Return ONLY a JSON object (no markdown fences):
{
  "content_text": "<the post copy, ready to publish>",
  "headline": "<headline if it is an ad, else null>",
  "preview_message": "<WhatsApp message showing the content to the client for approval — use *bold* for the content title, include the scheduled date/time, and end with: Responda *SIM* para aprovar ou *NÃO* para cancelar.>"
}`;

  try {
    const result = await askClaude({
      systemPrompt: 'You are SOFIA, a WhatsApp AI marketing agent. Return only valid JSON.',
      userMessage: prompt,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 800,
      workflow: 'content-scheduler-preview',
      clientId: clientContext.clientId,
    });

    return JSON.parse(result.text.replace(/```json|```/g, '').trim());
  } catch (error) {
    log.error('Failed to create content preview', { error: error.message });
    return null;
  }
}

// ─── BUILD SCHEDULED DATE ─────────────────────────────────────────────────────

function buildScheduledAt(intent) {
  let scheduledAt = new Date();

  if (intent.scheduled_date) {
    scheduledAt = new Date(intent.scheduled_date);
  } else {
    // Default: tomorrow
    scheduledAt.setDate(scheduledAt.getDate() + 1);
  }

  if (intent.scheduled_time) {
    const [h, m] = intent.scheduled_time.split(':');
    scheduledAt.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
  } else {
    // Default: noon
    scheduledAt.setHours(12, 0, 0, 0);
  }

  return scheduledAt;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

/**
 * Handle a potential content scheduling message from a client.
 * Call this from whatsapp-server.js BEFORE passing to Sofia's main loop.
 *
 * @param {string} message - Raw message text
 * @param {object} clientContext - Client context from getClientContextByPhone
 * @param {string} from - Client WhatsApp number
 * @param {Function} sendWhatsAppFn - sendWhatsApp(message, to) function
 * @returns {boolean} true if the message was handled by this module
 */
export async function handleSchedulingMessage(message, clientContext, from, sendWhatsAppFn) {
  if (!clientContext?.clientId) return false;

  const intent = await detectSchedulingIntent(message);

  // ── New scheduling request ──────────────────────────────────────────────
  if (intent.is_scheduling) {
    log.info('Scheduling intent detected', {
      from,
      contentType: intent.content_type,
      platform: intent.platform,
    });

    const preview = await createContentPreview(intent, clientContext);
    if (!preview) {
      await sendWhatsAppFn(
        'Desculpe, não consegui gerar o conteúdo. Pode tentar novamente?',
        from,
      );
      return true;
    }

    const scheduledAt = buildScheduledAt(intent);

    const inserted = await insertContentItem({
      client_id: clientContext.clientId,
      client_whatsapp: from,
      content_type: intent.content_type,
      platform: intent.platform,
      content_text: preview.content_text,
      headline: preview.headline,
      scheduled_at: scheduledAt.toISOString(),
      client_original_request: message,
      sofia_preview_message: preview.preview_message,
    });

    if (!inserted) {
      await sendWhatsAppFn(
        'Desculpe, tive um problema ao agendar. Pode tentar novamente?',
        from,
      );
      return true;
    }

    await sendWhatsAppFn(preview.preview_message, from);
    return true;
  }

  // ── Approval / rejection response ───────────────────────────────────────
  if (intent.is_approval) {
    const pending = await findPendingApproval(from);

    if (!pending) {
      return false; // No pending item — pass to main Sofia handler
    }

    if (intent.intent === 'approve') {
      await updateContentItem(pending.id, { status: 'approved' });

      const scheduledStr = new Date(pending.scheduled_at).toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });

      await sendWhatsAppFn(
        `✅ Aprovado! Seu conteúdo está agendado para *${scheduledStr}*.\n\nVou te lembrar um dia antes para confirmar. Qualquer mudança, é só me avisar!`,
        from,
      );
    } else {
      await updateContentItem(pending.id, { status: 'rejected' });
      await sendWhatsAppFn(
        '❌ Cancelado! Se quiser agendar outro conteúdo, é só me dizer.',
        from,
      );
    }

    return true;
  }

  // ── Day-before confirmation response ────────────────────────────────────
  // Also check for awaiting_confirmation items — the client might be
  // replying to a day-before confirmation message
  if (intent.is_approval === undefined || intent.is_approval === false) {
    // Quick check: could still be a yes/no to day-before confirmation
    // handled by the is_approval block above
  }

  return false; // Message not handled by this module
}

export default { handleSchedulingMessage };
