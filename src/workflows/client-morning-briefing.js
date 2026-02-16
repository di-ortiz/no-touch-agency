import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram } from '../api/telegram.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import * as tiktokAds from '../api/tiktok-ads.js';
import { getAllClients, getAllClientContacts, getContactChannel } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'client-morning-briefing' });

const QUIET_HOURS_START = 21;
const QUIET_HOURS_END = 8;

function isQuietHours() {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * Send personalized morning briefings to each active client.
 * Runs daily at 8:30 AM (after the owner's briefing at 8 AM).
 */
export async function runClientMorningBriefing() {
  if (isQuietHours()) {
    log.info('Skipping client morning briefing: quiet hours');
    return { skipped: true };
  }

  log.info('Starting client morning briefings');

  const clients = getAllClients();
  const contacts = getAllClientContacts();
  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const client of clients) {
    try {
      // Find contacts for this client
      const clientContacts = contacts.filter(c => c.client_id === client.id);
      if (clientContacts.length === 0) {
        results.skipped++;
        continue;
      }

      // Only send if client has at least one ad platform configured
      if (!client.meta_ad_account_id && !client.google_ads_customer_id && !client.tiktok_advertiser_id) {
        results.skipped++;
        continue;
      }

      // Collect performance data
      const platformData = {};

      if (client.meta_ad_account_id) {
        try {
          const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: 'yesterday' });
          platformData.meta = metaAds.extractConversions ? metaAds.extractConversions(insights) : insights;
        } catch (e) {
          log.warn(`Failed to get Meta data for ${client.name}`, { error: e.message });
        }
      }

      if (client.google_ads_customer_id) {
        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const dateStr = yesterday.toISOString().split('T')[0];
          const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id, { start: dateStr, end: dateStr });
          if (perf && perf.length > 0) {
            platformData.google = googleAds.formatGoogleAdsMetrics ? googleAds.formatGoogleAdsMetrics(perf[0]) : perf[0];
          }
        } catch (e) {
          log.warn(`Failed to get Google Ads data for ${client.name}`, { error: e.message });
        }
      }

      if (client.tiktok_advertiser_id) {
        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const dateStr = yesterday.toISOString().split('T')[0];
          const report = await tiktokAds.getReport(client.tiktok_advertiser_id, { startDate: dateStr, endDate: dateStr });
          platformData.tiktok = report;
        } catch (e) {
          log.warn(`Failed to get TikTok data for ${client.name}`, { error: e.message });
        }
      }

      if (Object.keys(platformData).length === 0) {
        results.skipped++;
        continue;
      }

      // Generate personalized briefing
      const contactName = clientContacts[0]?.name || 'there';
      const contactLang = clientContacts[0]?.language || 'en';
      const briefingMessage = await generateClientBriefing(client, platformData, contactName, contactLang);

      // Send to all contacts for this client
      for (const contact of clientContacts) {
        try {
          const channel = getContactChannel(contact.phone);
          const send = channel === 'telegram' ? sendTelegram : sendWhatsApp;
          await send(briefingMessage, contact.phone);
          results.sent++;
        } catch (e) {
          results.errors++;
          log.error('Failed to send client briefing', { client: client.name, contact: contact.phone, error: e.message });
        }
      }
    } catch (e) {
      results.errors++;
      log.error('Client briefing failed', { client: client.name, error: e.message });
    }
  }

  log.info('Client morning briefings completed', results);
  return results;
}

async function generateClientBriefing(client, platformData, contactName, language) {
  let platformSummary = '';
  for (const [platform, data] of Object.entries(platformData)) {
    if (!data) continue;
    platformSummary += `${platform}: `;
    if (data.spend !== undefined) platformSummary += `Spend $${Number(data.spend).toFixed(2)}, `;
    if (data.roas !== undefined) platformSummary += `ROAS ${Number(data.roas).toFixed(2)}, `;
    if (data.cpa !== undefined) platformSummary += `CPA $${Number(data.cpa).toFixed(2)}, `;
    if (data.conversions !== undefined) platformSummary += `Conversions ${data.conversions}`;
    platformSummary += '\n';
  }

  const langInstruction = language !== 'en'
    ? `\nIMPORTANT: Write the entire message in ${language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English'}.`
    : '';

  const response = await askClaude({
    systemPrompt: `You are Sofia, a warm PPC agency account manager sending a morning performance summary to a client via WhatsApp.
Write a brief, friendly, data-rich morning update. Use WhatsApp formatting (*bold*, _italic_).
Include:
1. A personal greeting using the client's name: "Good morning, NAME!"
2. Yesterday's performance highlights (use actual numbers)
3. Any concerns or areas to watch
4. One proactive suggestion or action item
5. End with: "Would you like me to dig deeper into anything?"
Keep it under 300 words. Be warm but data-driven.${langInstruction}`,
    userMessage: `Client: ${client.name}
Contact name: ${contactName}
Industry: ${client.industry || 'N/A'}
Target ROAS: ${client.target_roas || 'N/A'}
Target CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}

Yesterday's performance:
${platformSummary || 'No data available'}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    workflow: 'client-morning-briefing',
  });

  return response.text;
}

export default runClientMorningBriefing;
