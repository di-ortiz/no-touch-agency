import axios from 'axios';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'pagespeed' });

const API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * Run a PageSpeed Insights audit on a URL.
 * Free API — no key required (key optional for higher quota).
 *
 * @param {string} url - The URL to audit
 * @param {object} opts
 * @param {string} opts.strategy - 'mobile' or 'desktop' (default: 'mobile')
 * @param {string[]} opts.categories - Categories to audit (default: all)
 * @returns {object} Structured audit results
 */
export async function runPageSpeedAudit(url, opts = {}) {
  const strategy = opts.strategy || 'mobile';
  const categories = opts.categories || ['performance', 'accessibility', 'best-practices', 'seo'];

  return retry(async () => {
    const params = {
      url,
      strategy,
      category: categories,
    };

    log.info('Running PageSpeed audit', { url, strategy });

    const res = await axios.get(API_URL, { params, timeout: 60000 });
    const data = res.data;

    // Extract scores
    const lighthouseResult = data.lighthouseResult || {};
    const categoryScores = {};
    for (const [key, val] of Object.entries(lighthouseResult.categories || {})) {
      categoryScores[key] = {
        title: val.title,
        score: Math.round((val.score || 0) * 100),
      };
    }

    // Extract Core Web Vitals from field data
    const fieldMetrics = {};
    const loadingExperience = data.loadingExperience || {};
    if (loadingExperience.metrics) {
      for (const [key, val] of Object.entries(loadingExperience.metrics)) {
        fieldMetrics[key] = {
          percentile: val.percentile,
          category: val.category, // FAST, AVERAGE, SLOW
        };
      }
    }

    // Extract key lab metrics from lighthouse
    const audits = lighthouseResult.audits || {};
    const labMetrics = {
      firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
      largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
      totalBlockingTime: audits['total-blocking-time']?.displayValue || null,
      cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue || null,
      speedIndex: audits['speed-index']?.displayValue || null,
      timeToInteractive: audits['interactive']?.displayValue || null,
    };

    // Extract top opportunities (things to fix)
    const opportunities = [];
    for (const [key, audit] of Object.entries(audits)) {
      if (audit.details?.type === 'opportunity' && audit.score !== null && audit.score < 1) {
        opportunities.push({
          title: audit.title,
          description: audit.description,
          savings: audit.details?.overallSavingsMs
            ? `${Math.round(audit.details.overallSavingsMs)}ms`
            : null,
          score: Math.round((audit.score || 0) * 100),
        });
      }
    }
    opportunities.sort((a, b) => a.score - b.score);

    // Extract diagnostics (informational audits that failed)
    const diagnostics = [];
    for (const [key, audit] of Object.entries(audits)) {
      if (audit.details?.type === 'table' && audit.score !== null && audit.score < 1) {
        diagnostics.push({
          title: audit.title,
          description: audit.description,
          score: Math.round((audit.score || 0) * 100),
        });
      }
    }
    diagnostics.sort((a, b) => a.score - b.score);

    const result = {
      url,
      strategy,
      fetchTime: data.analysisUTCTimestamp,
      scores: categoryScores,
      coreWebVitals: fieldMetrics,
      labMetrics,
      topOpportunities: opportunities.slice(0, 8),
      topDiagnostics: diagnostics.slice(0, 5),
      overallPerformance: categoryScores.performance?.score || 0,
    };

    log.info('PageSpeed audit complete', { url, performance: result.overallPerformance });
    return result;
  }, { retries: 2, label: 'PageSpeed audit', shouldRetry: isRetryableHttpError });
}

/**
 * Quick performance check — returns just the scores.
 */
export async function quickPerformanceCheck(url) {
  const result = await runPageSpeedAudit(url, {
    strategy: 'mobile',
    categories: ['performance', 'seo'],
  });
  return {
    url,
    performanceScore: result.scores.performance?.score || 0,
    seoScore: result.scores.seo?.score || 0,
    lcp: result.labMetrics.largestContentfulPaint,
    cls: result.labMetrics.cumulativeLayoutShift,
    tbt: result.labMetrics.totalBlockingTime,
  };
}

export default { runPageSpeedAudit, quickPerformanceCheck };
