import logger from '../utils/logger.js';
import { getAllClients, getClient } from '../services/knowledge-base.js';
import * as seoEngine from '../services/seo-engine.js';
import * as pagespeed from '../api/pagespeed.js';
import * as dataforseo from '../api/dataforseo.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram } from '../api/telegram.js';
import { getContactsByClientId } from '../services/knowledge-base.js';
import { auditLog } from '../services/cost-tracker.js';

const log = logger.child({ workflow: 'seo-monitor' });

/**
 * Weekly SEO health check for all clients with websites.
 * Runs every Monday at 9 AM.
 *
 * Checks:
 * - Core Web Vitals (LCP, CLS, TBT)
 * - SEO score changes
 * - Missing/poor meta tags (if WordPress connected)
 * - New content freshness
 *
 * Alerts owner and client on critical issues.
 */
export async function runWeeklySEOCheck() {
  log.info('Starting weekly SEO health check');

  const clients = getAllClients().filter(c => c.website && c.status === 'active');
  if (!clients.length) {
    log.info('No clients with websites to check');
    return;
  }

  const results = [];

  for (const client of clients) {
    try {
      const url = client.website.startsWith('http') ? client.website : `https://${client.website}`;
      const hostname = new URL(url).hostname;

      // Run PageSpeed check
      const perf = await pagespeed.quickPerformanceCheck(url);

      const issues = [];
      const improvements = [];

      // Performance thresholds
      if (perf.performanceScore < 50) issues.push(`Performance score critical: ${perf.performanceScore}/100`);
      else if (perf.performanceScore < 70) improvements.push(`Performance score: ${perf.performanceScore}/100 (target: 70+)`);

      if (perf.seoScore < 80) issues.push(`SEO score low: ${perf.seoScore}/100`);

      // Core Web Vitals
      if (perf.lcp > 4000) issues.push(`LCP slow: ${(perf.lcp / 1000).toFixed(1)}s (target: <2.5s)`);
      else if (perf.lcp > 2500) improvements.push(`LCP needs work: ${(perf.lcp / 1000).toFixed(1)}s (target: <2.5s)`);

      if (perf.cls > 0.25) issues.push(`CLS high: ${perf.cls.toFixed(3)} (target: <0.1)`);
      if (perf.tbt > 600) issues.push(`TBT slow: ${perf.tbt}ms (target: <200ms)`);

      // WordPress meta audit (if connected)
      let wpReport = null;
      const wp = seoEngine.getWordPressClient(client);
      if (wp) {
        try {
          const validation = await wp.validateConnection();
          if (validation.connected) {
            const allSEO = await wp.getAllPagesSEO();
            const missingTitle = allSEO.filter(p => !p.seoTitle || p.seoTitle === '(missing)');
            const missingDesc = allSEO.filter(p => !p.seoDescription || p.seoDescription === '(missing)');

            if (missingTitle.length > 0) issues.push(`${missingTitle.length} pages missing SEO titles`);
            if (missingDesc.length > 0) issues.push(`${missingDesc.length} pages missing meta descriptions`);

            // Check content freshness (no new posts in 30+ days)
            const posts = await wp.listPosts({ status: 'publish', perPage: 5 });
            if (posts.length > 0) {
              const lastPostDate = new Date(posts[0].date);
              const daysSinceLastPost = Math.floor((Date.now() - lastPostDate) / 86400000);
              if (daysSinceLastPost > 30) {
                improvements.push(`No new blog posts in ${daysSinceLastPost} days — content freshness dropping`);
              }
            }

            wpReport = {
              totalPages: allSEO.length,
              missingTitles: missingTitle.length,
              missingDescriptions: missingDesc.length,
              lastPostDaysAgo: posts.length > 0 ? Math.floor((Date.now() - new Date(posts[0].date)) / 86400000) : null,
            };
          }
        } catch (e) {
          log.warn('WordPress check failed for client', { client: client.name, error: e.message });
        }
      }

      const clientResult = {
        clientName: client.name,
        url,
        performance: perf,
        wordpress: wpReport,
        issues,
        improvements,
        status: issues.length > 0 ? 'needs_attention' : improvements.length > 0 ? 'good' : 'excellent',
      };

      results.push(clientResult);

      // Alert owner on critical issues
      if (issues.length > 0) {
        const alertMsg = `⚠️ *SEO Alert — ${client.name}*\n\n${issues.map(i => `• ${i}`).join('\n')}\n\n${improvements.length > 0 ? `Also:\n${improvements.map(i => `• ${i}`).join('\n')}` : ''}`;
        try { await sendWhatsApp(alertMsg); } catch (e) { /* best effort */ }
      }

    } catch (e) {
      log.error('SEO check failed for client', { client: client.name, error: e.message });
      results.push({ clientName: client.name, status: 'error', error: e.message });
    }
  }

  // Summary to owner
  const attention = results.filter(r => r.status === 'needs_attention');
  const good = results.filter(r => r.status === 'good');
  const excellent = results.filter(r => r.status === 'excellent');

  if (results.length > 0) {
    let summary = `📊 *Weekly SEO Health Check*\n\n`;
    summary += `Checked: ${results.length} client websites\n`;
    if (excellent.length) summary += `✅ Excellent: ${excellent.map(r => r.clientName).join(', ')}\n`;
    if (good.length) summary += `🟡 Good (minor improvements): ${good.map(r => r.clientName).join(', ')}\n`;
    if (attention.length) summary += `🔴 Needs attention: ${attention.map(r => r.clientName).join(', ')}\n`;

    try { await sendWhatsApp(summary); } catch (e) { /* best effort */ }
  }

  auditLog('seo-monitor', 'weekly-check', { clientsChecked: results.length, needsAttention: attention.length });
  log.info('Weekly SEO check completed', { checked: results.length, needsAttention: attention.length });

  return results;
}

/**
 * Monthly content gap analysis for all clients.
 * Runs first Monday of each month.
 *
 * Identifies keyword gaps vs competitors and suggests new blog topics.
 */
export async function runMonthlyContentAnalysis() {
  log.info('Starting monthly content gap analysis');

  const clients = getAllClients().filter(c => c.website && c.status === 'active');

  for (const client of clients) {
    try {
      const hostname = new URL(client.website.startsWith('http') ? client.website : `https://${client.website}`).hostname;
      const competitors = client.competitors ? (typeof client.competitors === 'string' ? JSON.parse(client.competitors) : client.competitors) : [];

      if (competitors.length === 0) continue;

      // Run keyword gap analysis against top competitor
      const gap = await dataforseo.getKeywordGap({
        yourDomain: hostname,
        competitorDomain: competitors[0],
        limit: 20,
      });

      if (gap?.length > 0) {
        const topOpportunities = gap
          .filter(k => k.searchVolume > 100)
          .sort((a, b) => b.searchVolume - a.searchVolume)
          .slice(0, 5);

        if (topOpportunities.length > 0) {
          const msg = `📈 *Monthly Content Opportunity — ${client.name}*\n\nKeyword gaps vs ${competitors[0]}:\n${topOpportunities.map(k => `• "${k.keyword}" — ${k.searchVolume} searches/mo (they rank #${k.competitorPosition}, you: ${k.yourPosition || 'not ranking'})`).join('\n')}\n\nWant me to generate blog posts for any of these? Just say the word.`;
          try { await sendWhatsApp(msg); } catch (e) { /* best effort */ }
        }
      }
    } catch (e) {
      log.warn('Content analysis failed for client', { client: client.name, error: e.message });
    }
  }

  log.info('Monthly content analysis completed');
}

export default { runWeeklySEOCheck, runMonthlyContentAnalysis };
