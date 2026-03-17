import logger from '../utils/logger.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import {
  findByStatusAndDateRange,
  findStaleConfirmations,
  findDueForPublishing,
  updateContentItem,
} from '../api/supabase-content-queue.js';
import { getContactByPhone, getClient } from '../services/knowledge-base.js';
import { buildPlatformAccessStatus } from '../services/client-onboarding-flow.js';
import { createInvite as createLeadsieInvite } from '../api/leadsie.js';

const log = logger.child({ workflow: 'content-confirmation' });

// ─── JOB 1: Day-before confirmations ──────────────────────────────────────────
// Finds approved content scheduled for tomorrow and sends a confirmation request.

export async function runDayBeforeConfirmation() {
  log.info('Checking for tomorrow\'s scheduled content');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const items = await findByStatusAndDateRange(
    'approved',
    tomorrowStart.toISOString(),
    tomorrowEnd.toISOString(),
  );

  const results = { sent: 0, errors: 0 };

  for (const item of items) {
    try {
      const scheduledStr = new Date(item.scheduled_at).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const platform = item.platform || item.content_type;
      const contentPreview = item.content_text
        ? item.content_text.slice(0, 100) + (item.content_text.length > 100 ? '...' : '')
        : 'conteúdo agendado';

      const msg = [
        '🔔 *Lembrete de publicação*',
        '',
        `Amanhã às *${scheduledStr}* está agendado para *${platform}*:`,
        '',
        `_"${contentPreview}"_`,
        '',
        'Ainda quer publicar? Responda:',
        '✅ *SIM* — confirmar',
        '❌ *NÃO* — cancelar',
      ].join('\n');

      await sendWhatsApp(msg, item.client_whatsapp);

      await updateContentItem(item.id, {
        status: 'awaiting_confirmation',
        confirmation_sent_at: new Date().toISOString(),
      });

      results.sent++;
      log.info('Day-before confirmation sent', { id: item.id, client: item.client_whatsapp });
    } catch (error) {
      results.errors++;
      log.error('Failed to send day-before confirmation', {
        id: item.id,
        error: error.message,
      });
    }
  }

  log.info('Day-before confirmation complete', results);
  return results;
}

// ─── JOB 2: Auto-cancel stale confirmations ──────────────────────────────────
// If a confirmation was sent >20h ago with no response, cancel it.

export async function runStaleConfirmationCleanup() {
  log.info('Checking for stale awaiting_confirmation items');

  const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const staleItems = await findStaleConfirmations(cutoff);

  const results = { cancelled: 0, errors: 0 };

  for (const item of staleItems) {
    try {
      await updateContentItem(item.id, { status: 'cancelled' });

      await sendWhatsApp(
        '⚠️ Cancelei o conteúdo agendado pois não recebi confirmação. Se quiser reagendar, é só me pedir!',
        item.client_whatsapp,
      );

      results.cancelled++;
      log.info('Stale content cancelled', { id: item.id, client: item.client_whatsapp });
    } catch (error) {
      results.errors++;
      log.error('Failed to cancel stale content', {
        id: item.id,
        error: error.message,
      });
    }
  }

  log.info('Stale confirmation cleanup complete', results);
  return results;
}

// ─── JOB 3: Publish due content ──────────────────────────────────────────────
// Every 5 minutes, publishes confirmed content that's due.

export async function runContentPublisher() {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const dueItems = await findDueForPublishing(
    fiveMinAgo.toISOString(),
    now.toISOString(),
  );

  if (dueItems.length === 0) return { published: 0 };

  log.info('Publishing due content', { count: dueItems.length });

  const results = { published: 0, errors: 0, blocked: 0 };

  for (const item of dueItems) {
    try {
      // Verify platform access before publishing
      const access = await checkPlatformAccess(item);
      if (!access.hasAccess) {
        results.blocked++;
        await updateContentItem(item.id, { status: 'approved' }); // revert to approved so it retries later

        const platformLabel = access.platform || item.platform;
        await sendWhatsApp(
          `⚠️ Não consegui publicar em *${platformLabel}* porque ainda não tenho acesso à plataforma.\n\n` +
          'Para liberar, clique no link da Leadsie que enviei anteriormente ou me peça um novo convite. ' +
          'Assim que o acesso for concedido, publico automaticamente! 🔑',
          item.client_whatsapp,
        );

        // Try to send a fresh Leadsie invite
        try {
          if (access.client?.email) {
            const invite = await createLeadsieInvite({
              clientName: access.client.name,
              clientEmail: access.client.email,
              platforms: [access.credPlatform],
              message: `Preciso de acesso ao ${platformLabel} para publicar seu conteúdo agendado.`,
            });
            if (invite?.inviteUrl) {
              await sendWhatsApp(
                `🔗 Novo link de acesso: ${invite.inviteUrl}\nClique para autorizar o *${platformLabel}*.`,
                item.client_whatsapp,
              );
            }
          }
        } catch (leadsieErr) {
          log.warn('Failed to send Leadsie invite for blocked content', { error: leadsieErr.message });
        }

        log.info('Content blocked — missing platform access', { id: item.id, platform: item.platform });
        continue;
      }

      await publishContent(item);
      await updateContentItem(item.id, { status: 'published' });

      await sendWhatsApp(
        `🚀 Publicado! Seu conteúdo foi ao ar agora em *${item.platform || item.content_type}*.`,
        item.client_whatsapp,
      );

      results.published++;
      log.info('Content published', { id: item.id, platform: item.platform });
    } catch (error) {
      results.errors++;
      log.error('Failed to publish content', { id: item.id, error: error.message });

      await sendWhatsApp(
        '⚠️ Tive um problema para publicar. Vou tentar novamente em 5 minutos.',
        item.client_whatsapp,
      ).catch(() => {}); // best effort notification
    }
  }

  log.info('Content publishing complete', results);
  return results;
}

// ─── PLATFORM ACCESS CHECK ────────────────────────────────────────────────────
// Verifies that the client has granted platform access via Leadsie before publishing.
// Maps content platforms to the credential platforms checked by buildPlatformAccessStatus.

const contentPlatformToCredential = {
  instagram: 'facebook',  // Meta umbrella
  facebook: 'facebook',
  google: 'google',
  tiktok: 'tiktok',
  wordpress: 'wordpress',
};

async function checkPlatformAccess(item) {
  const credPlatform = contentPlatformToCredential[item.platform];
  if (!credPlatform) return { hasAccess: true }; // manual platforms — no check needed

  try {
    const contact = getContactByPhone(item.client_whatsapp);
    if (!contact?.client_id) return { hasAccess: true }; // unknown contact, allow (best effort)

    const client = getClient(contact.client_id);
    if (!client) return { hasAccess: true };

    const accessStatus = buildPlatformAccessStatus(client);
    const hasPlatformAccess = accessStatus.granted.some(g => g.platform === credPlatform);

    if (!hasPlatformAccess) {
      log.warn('Platform access not granted for publishing', {
        id: item.id, platform: item.platform, credPlatform, client: client.name,
      });
      return { hasAccess: false, client, credPlatform, platform: item.platform };
    }

    return { hasAccess: true };
  } catch (error) {
    log.error('Platform access check failed', { id: item.id, error: error.message });
    return { hasAccess: true }; // fail open — don't block on check errors
  }
}

// ─── PUBLISHER: routes to correct platform ────────────────────────────────────

async function publishContent(item) {
  switch (item.platform) {
    case 'instagram':
    case 'facebook':
      return publishToMeta(item);
    case 'wordpress':
      return publishToWordPress(item);
    default:
      // No automated publisher — send content as manual copy-paste
      log.info('No auto-publisher for platform, sending as manual', { platform: item.platform });
      await sendWhatsApp(
        `📋 *Publicação manual:* O conteúdo abaixo está pronto para você publicar em *${item.platform || item.content_type}*:\n\n${item.content_text}`,
        item.client_whatsapp,
      );
  }
}

async function publishToMeta(item) {
  // NOTE: Full Meta publishing requires per-client page access tokens.
  // For now, deliver content as ready-to-publish copy.
  await sendWhatsApp(
    `📱 *Pronto para publicar no ${item.platform}!*\n\n${item.content_text}\n\n_(Copie e cole no ${item.platform} para publicar)_`,
    item.client_whatsapp,
  );
}

async function publishToWordPress(item) {
  // NOTE: Requires WP_URL, WP_USERNAME, WP_APP_PASSWORD in client profile.
  // For now, send content as ready-to-post.
  await sendWhatsApp(
    `📝 *Post pronto para o WordPress:*\n\n*${item.headline || 'Novo post'}*\n\n${item.content_text}`,
    item.client_whatsapp,
  );
}

export default {
  runDayBeforeConfirmation,
  runStaleConfirmationCleanup,
  runContentPublisher,
};
