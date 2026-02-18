import logger from '../utils/logger.js';
import { notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as metaAds from '../api/meta-ads.js';
import * as clickup from '../api/clickup.js';
import { getAllClients, saveCreative, getTopCreatives } from '../services/knowledge-base.js';
import { safeExecute } from '../services/safety.js';
import config from '../config.js';

const log = logger.child({ workflow: 'creative-fatigue' });

// Fatigue thresholds
const FATIGUE_THRESHOLDS = {
  maxDaysRunning: 21,
  maxFrequency: 5,
  ctrDeclinePercent: 25,
  cpaIncreasePercent: 40,
};

/**
 * Workflow 14: Creative Fatigue Detection
 * Runs daily. Monitors creative performance metrics to detect fatigue
 * and recommend refreshes.
 */
export async function runCreativeFatigueCheck() {
  log.info('Starting creative fatigue check');

  const clients = getAllClients();
  const fatigued = [];
  const warnings = [];

  for (const client of clients) {
    try {
      const results = await checkClientCreatives(client);
      fatigued.push(...results.fatigued);
      warnings.push(...results.warnings);
    } catch (e) {
      log.error(`Fatigue check failed for ${client.name}`, { error: e.message });
    }
  }

  // Send alerts
  if (fatigued.length > 0) {
    let message = `*🔴 Fatigued Creatives (${fatigued.length}):*\n`;
    for (const f of fatigued) {
      message += `\n• *${f.client}* - ${f.adName}\n`;
      message += `  ${f.reasons.join(', ')}\n`;
      message += `  _Action: ${f.action}_\n`;
    }

    if (warnings.length > 0) {
      message += `\n*🟡 Approaching Fatigue (${warnings.length}):*\n`;
      for (const w of warnings) {
        message += `• ${w.client} - ${w.adName}: ${w.reason}\n`;
      }
    }

    await sendAlert('warning', `Creative Fatigue: ${fatigued.length} ads need refresh`, message);
  }

  // Create ClickUp tasks for creative refreshes
  for (const f of fatigued) {
    if (f.clickupListId) {
      try {
        await clickup.createTask(f.clickupListId, {
          name: `[Creative Refresh] ${f.client} - ${f.adName}`,
          description: `Creative fatigue detected:\n${f.reasons.join('\n')}\n\nRecommendation: Create new creative variations.`,
          priority: 2,
          tags: ['creative-refresh', 'ai-generated'],
        });
      } catch (e) {
        log.warn('Failed to create refresh task in ClickUp', { error: e.message });
      }
    }
  }

  log.info(`Fatigue check complete`, { fatigued: fatigued.length, warnings: warnings.length });
  return { fatigued, warnings };
}

async function checkClientCreatives(client) {
  const fatigued = [];
  const warnings = [];

  if (!client.meta_ad_account_id) return { fatigued, warnings };

  try {
    const campaigns = await metaAds.getCampaigns(client.meta_ad_account_id, {
      statusFilter: ['ACTIVE'],
    });

    for (const campaign of (campaigns.data || []).slice(0, 10)) {
      const adSets = await metaAds.getAdSets(campaign.id);

      for (const adSet of (adSets.data || []).slice(0, 5)) {
        const ads = await metaAds.getAds(adSet.id);

        for (const ad of (ads.data || []).slice(0, 10)) {
          if (ad.status !== 'ACTIVE') continue;

          // Get recent performance
          const recentInsights = await metaAds.getInsights(ad.id, {
            datePreset: 'last_3d',
            level: 'ad',
          });
          const recentMetrics = metaAds.extractConversions(recentInsights);

          // Get first week performance for comparison
          const startDate = ad.created_time || adSet.start_time;
          let earlyMetrics = null;
          if (startDate) {
            const start = new Date(startDate);
            const earlyEnd = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
            if (earlyEnd < new Date()) {
              const earlyInsights = await metaAds.getInsights(ad.id, {
                timeRange: {
                  since: start.toISOString().split('T')[0],
                  until: earlyEnd.toISOString().split('T')[0],
                },
                level: 'ad',
              });
              earlyMetrics = metaAds.extractConversions(earlyInsights);
            }
          }

          if (!recentMetrics) continue;

          // Calculate fatigue indicators
          const reasons = [];
          let isFatigued = false;

          // Check frequency
          if (recentMetrics.frequency > FATIGUE_THRESHOLDS.maxFrequency) {
            reasons.push(`Frequency: ${recentMetrics.frequency.toFixed(1)} (threshold: ${FATIGUE_THRESHOLDS.maxFrequency})`);
            isFatigued = true;
          }

          // Check CTR decline
          if (earlyMetrics && earlyMetrics.ctr > 0) {
            const ctrDecline = ((earlyMetrics.ctr - recentMetrics.ctr) / earlyMetrics.ctr) * 100;
            if (ctrDecline > FATIGUE_THRESHOLDS.ctrDeclinePercent) {
              reasons.push(`CTR dropped ${ctrDecline.toFixed(0)}% (${(earlyMetrics.ctr).toFixed(2)}% → ${(recentMetrics.ctr).toFixed(2)}%)`);
              isFatigued = true;
            } else if (ctrDecline > FATIGUE_THRESHOLDS.ctrDeclinePercent * 0.6) {
              warnings.push({
                client: client.name,
                adName: ad.name,
                reason: `CTR declining: down ${ctrDecline.toFixed(0)}%`,
              });
            }
          }

          // Check CPA increase
          if (earlyMetrics && earlyMetrics.cpa > 0 && recentMetrics.cpa > 0) {
            const cpaIncrease = ((recentMetrics.cpa - earlyMetrics.cpa) / earlyMetrics.cpa) * 100;
            if (cpaIncrease > FATIGUE_THRESHOLDS.cpaIncreasePercent) {
              reasons.push(`CPA increased ${cpaIncrease.toFixed(0)}% ($${earlyMetrics.cpa.toFixed(2)} → $${recentMetrics.cpa.toFixed(2)})`);
              isFatigued = true;
            }
          }

          // Check days running
          if (startDate) {
            const daysRunning = Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
            if (daysRunning > FATIGUE_THRESHOLDS.maxDaysRunning) {
              reasons.push(`Running ${daysRunning} days (threshold: ${FATIGUE_THRESHOLDS.maxDaysRunning})`);
              if (!isFatigued) {
                warnings.push({
                  client: client.name,
                  adName: ad.name,
                  reason: `Running ${daysRunning} days without refresh`,
                });
              }
            }
          }

          if (isFatigued) {
            // Auto-pause critically fatigued ads
            let action = 'Recommend creative refresh';
            if (reasons.length >= 2) {
              const pauseResult = await safeExecute(
                {
                  type: 'pause_ad',
                  clientId: client.id,
                  platform: 'meta',
                  workflow: 'creative-fatigue',
                },
                () => metaAds.updateAd(ad.id, { status: 'PAUSED' }),
              );
              if (pauseResult.executed) {
                action = 'Auto-paused (multiple fatigue signals)';
              }
            }

            fatigued.push({
              client: client.name,
              adName: ad.name,
              adId: ad.id,
              reasons,
              action,
              clickupListId: client.clickup_list_id,
            });

            // Update creative library
            saveCreative({
              clientId: client.id,
              platform: 'meta',
              campaignId: campaign.id,
              creativeType: 'ad',
              headline: ad.creative?.title || ad.name,
              status: 'fatigued',
              impressions: recentMetrics.impressions,
              clicks: recentMetrics.clicks,
              ctr: recentMetrics.ctr / 100,
              daysRunning: startDate ? Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)) : 0,
            });
          }
        }
      }
    }
  } catch (e) {
    log.warn(`Meta creative check failed for ${client.name}`, { error: e.message });
  }

  return { fatigued, warnings };
}

export default { runCreativeFatigueCheck };
