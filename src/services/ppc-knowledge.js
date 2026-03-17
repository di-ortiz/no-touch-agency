import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';

const log = logger.child({ service: 'ppc-knowledge' });

// ============================================================
// Platform Creative Specifications (2026)
// ============================================================

export const CREATIVE_SPECS = {
  meta: {
    feed: { ratio: '4:5', size: '1080x1350', maxFileSize: '30MB', formats: ['jpg', 'png', 'mp4', 'mov'] },
    story: { ratio: '9:16', size: '1080x1920', maxFileSize: '30MB', formats: ['jpg', 'png', 'mp4', 'mov'] },
    reels: { ratio: '9:16', size: '1080x1920', maxVideoLength: '90s', formats: ['mp4', 'mov'] },
    square: { ratio: '1:1', size: '1080x1080', maxFileSize: '30MB', formats: ['jpg', 'png'] },
    carousel: { ratio: '1:1', size: '1080x1080', maxCards: 10, formats: ['jpg', 'png', 'mp4'] },
    textLimits: { primaryText: 125, headline: 40, description: 30, primaryTextMax: 2200 },
  },
  google: {
    responsiveDisplay: { landscape: '1200x628', square: '1200x1200', portrait: '960x1200' },
    performanceMax: { images: 20, videos: 5, logos: 5, headlines: 15, descriptions: 4 },
    rsa: { headlines: 15, descriptions: 4, headlineMaxChars: 30, descriptionMaxChars: 90 },
    videoAds: { skippable: '16:9', shorts: '9:16', bumper: '16:9 ≤6s' },
  },
  tiktok: {
    inFeed: { ratio: '9:16', minSize: '540x960', recommended: '1080x1920', safeZone: '900x1320 center' },
    maxVideoLength: '60s', recommendedLength: '15-30s',
    bottomUIZone: '450px from bottom (do not place CTAs here)',
    rules: ['Native-feeling content critical', 'Corporate aesthetics = #1 performance killer', 'Must have audio'],
  },
  linkedin: {
    singleImage: { landscape: '1200x627', square: '1080x1080' },
    video: { ratio: '16:9 or 1:1', length: '15-30s recommended', maxLength: '30min' },
    textLimits: { introText: 600, headline: 200 },
    thoughtLeaderAds: { cpc: '$2.29-4.14 vs $13.23 standard', budgetAllocation: '≥30% recommended' },
  },
  microsoft: {
    rsa: { headlines: 15, descriptions: 4, headlineMaxChars: 30, descriptionMaxChars: 90 },
    advantages: ['20-35% lower CPCs than Google', 'Copilot integration 73% higher CTR', 'Users click ads 25% more often'],
  },
};

// ============================================================
// Platform Benchmarks (2026)
// ============================================================

export const BENCHMARKS = {
  google: {
    search: { avgCTR: 6.66, avgCPC: '$5.26', topIndustries: { ecommerce: '$1.15', healthcare: '$40+', legal: '$9.21' } },
    qualityScore: { good: '7+', excellent: '8+', needsAttention: '<5' },
  },
  meta: {
    advantagePlus: { avgROAS: 4.52 },
    retargeting: { avgROAS: 3.61 },
    avgCPC: { jan2026: '$0.85 (seasonal low)', q4: '+30-50% premium' },
    creativeFatigue: { frequencyThreshold: 3, prospecting: 3, retargeting: 8 },
  },
  tiktok: {
    cpmAdvantage: '40-60% cheaper than Meta',
    engagementRate: '5-16%',
    sparkAdsCTR: '~3%',
    minDailyBudget: '50x target CPA per ad group',
  },
  linkedin: {
    avgROAS: 1.13,
    leadGenFormCVR: '13% (vs landing page)',
    textLinkAdsCPC: '70% cheaper than standard',
    messageFrequency: '1 per 30-45 days max',
  },
  mer: {
    ecommerce: { healthy: '3.0-5.0', haltScaling: '<3.0' },
    note: 'MER = Total Revenue / Total Ad Spend. Platform ROAS overclaims by 20-40%. Use MER as authoritative macro metric.',
    attributionHierarchy: '1. CRM/Backend → 2. MER Aggregation → 3. Platform Dashboards',
  },
  microsoft: {
    cpcAdvantage: '20-35% lower than Google',
    copilotCTR: '73% higher',
    copilotConvRate: '63% higher vs standard search',
    userClickRate: '25% more often than Google',
  },
};

// ============================================================
// Bidding Strategy Ladders
// ============================================================

export const BIDDING_LADDERS = {
  google: [
    { conversions: '<15/month', strategy: 'Maximize Clicks', note: 'Cold start — build conversion data' },
    { conversions: '15-29/month', strategy: 'Maximize Conversions', note: 'Building signal' },
    { conversions: '30+/month', strategy: 'Target CPA', note: 'Set at 1.1-1.2x historical CPA' },
    { conversions: '50+/month with values', strategy: 'Target ROAS', note: 'Use exact historical ROAS as target' },
  ],
  meta: [
    { default: 'Lowest Cost (no cap)', usage: '90% of campaigns', note: 'Let Meta optimize freely' },
    { alternative: 'Cost Cap', usage: 'Predictability needed', note: 'Set at 1.2-1.5x target CPA' },
  ],
  tiktok: [
    { default: 'Lowest Cost', usage: 'Most campaigns', note: 'Similar to Meta' },
    { learningPhase: '≥50 conversions/week per ad group', note: 'Required for stable optimization' },
  ],
  learningPhaseRequirements: {
    google: '≥15 conversions/30 days',
    meta: '50 conversions/week per ad set',
    tiktok: '≥50 conversions/week per ad group',
    linkedin: '$50+/day minimum budget',
  },
};

// ============================================================
// Compliance & Special Ad Categories
// ============================================================

export const COMPLIANCE = {
  specialCategories: ['Housing', 'Employment', 'Credit', 'Financial Products (Jan 2025)', 'Healthcare'],
  privacyLaws: {
    GDPR: 'EU/EEA — Consent Mode v2 mandatory since July 2025',
    CPRA: 'California + 20 US state laws',
    LGPD: 'Brazil',
    PIPL: 'China',
  },
  trackingRequirements: {
    meta: 'CAPI (Conversions API) — server-side mandatory post-iOS 14.5. Event Match Quality target ≥8.0',
    google: 'Enhanced Conversions + Consent Mode v2 (EU). Global site tag required.',
    tiktok: 'Must capture ttclid parameter and return with all conversion events',
    linkedin: 'Insight Tag + Conversions API. Offline conversion imports for pipeline (90-day windows)',
    microsoft: 'UET tag + Enhanced Conversions',
  },
  iosImpact: {
    appOptIn: '35% rates',
    revenueDropLowConsent: '58% for apps with poor consent flows',
    privacySandbox: 'Retired October 2025',
  },
};

// ============================================================
// Industry-Specific Budget Allocation
// ============================================================

export const INDUSTRY_BUDGETS = {
  ecommerce: {
    allocation: { meta: '50%', googlePMax: '30%', tiktok: '15%', email: '5%' },
    profitabilityWindow: '0-2 months',
    minMonthly: '$3,000',
    strategy: 'Advantage+ Sales campaigns, PMax for full funnel, TikTok for discovery',
  },
  b2bSaas: {
    allocation: { google: '35-45%', linkedin: '30-40%', meta: '15-25%' },
    profitabilityWindow: '2-4 months',
    minMonthly: '$5,000',
    strategy: 'Google for intent capture, LinkedIn Thought Leader Ads, Meta for retargeting',
  },
  localServices: {
    allocation: { googleLSA: '40%', metaLocal: '35%', youtube: '25%' },
    profitabilityWindow: '1-2 months',
    minMonthly: '$2,000',
    strategy: 'Local Service Ads for high intent, geofenced Meta/YouTube retargeting',
  },
  b2bEnterprise: {
    allocation: { linkedin: '60%', googleSearch: '20%', abmDisplay: '20%' },
    profitabilityWindow: '6-12 months',
    minMonthly: '$10,000',
    strategy: 'LinkedIn ABM, Google brand/intent, Display retargeting to named accounts',
  },
  infoProducts: {
    allocation: { meta: '45%', youtube: '30%', tiktok: '25%' },
    profitabilityWindow: '1-3 months',
    minMonthly: '$2,000',
    strategy: 'Founder-led video authority, 3-second hook optimization, tripwire funnels',
  },
};

// ============================================================
// Danger Signals (auto-alert thresholds)
// ============================================================

export const DANGER_SIGNALS = [
  { signal: '20%+ CPA drift over 3-5 days', action: 'Review targeting and creative, reduce budget if trend continues' },
  { signal: '>3 days consecutive zero conversions', action: 'Check tracking, landing page, ad approvals' },
  { signal: 'Frequency exceeding platform threshold', action: 'Refresh creative, expand audience, cap frequency' },
  { signal: '>30% CTR decline over 14 days', action: 'Pause fatigued creatives, launch new variants' },
  { signal: 'CPA >3x target', action: '3x Kill Rule — pause immediately, fix before restart' },
  { signal: 'Learning phase reset (budget/targeting change)', action: 'Wait 72 hours, avoid further changes' },
  { signal: 'Audience overlap >30%', action: 'Consolidate ad sets, exclude overlapping segments' },
];

// ============================================================
// Platform-Specific Quick Wins (<15 min each)
// ============================================================

export const QUICK_WINS = {
  google: [
    'Enable Enhanced Conversions (5 min)',
    'Correct location targeting — "Presence" not "Presence or Interest" (2 min)',
    'Build negative keyword lists from search terms report (10 min)',
    'Add sitelink extensions to all campaigns (10 min)',
    'Segregate brand vs non-brand campaigns (15 min)',
    'Check for broad match without Smart Bidding — disable (5 min)',
  ],
  meta: [
    'Check Event Match Quality score — optimize to ≥8.0 (10 min)',
    'Implement CAPI server-side tracking (15 min setup)',
    'Check audience overlap — reduce to <20% (10 min)',
    'Rotate creatives (aim for 30-day refresh cycle)',
    'Enable Advantage+ audience expansion on testing ad sets',
    'Exclude purchasers/converters from prospecting (5 min)',
  ],
  tiktok: [
    'Enable Search Ads Toggle (2 min)',
    'Convert all assets to 9:16 vertical format (10 min)',
    'Test Spark Ads vs standard in-feed (5 min setup)',
    'Verify ttclid parameter capture in tracking (10 min)',
    'Add native-feeling audio to all video ads',
    'Keep CTA above bottom 450px safe zone',
  ],
  linkedin: [
    'Allocate ≥30% budget to Thought Leader Ads — $2.29 vs $13.23 CPC (5 min)',
    'Reduce Lead Gen Form fields to ≤5 (10 min)',
    'Set up real-time CRM sync for lead forms (15 min)',
    'Cap InMail frequency to 1 per 30-45 days (2 min)',
    'Test Text Link Ads — 70% cheaper CPC (5 min)',
  ],
  microsoft: [
    'Enable Copilot placement — 73% higher CTR (2 min)',
    'Activate LinkedIn targeting for B2B campaigns (5 min)',
    'Review syndicated partner performance — exclude low quality (10 min)',
    'Verify conversion tracking post-import from Google (10 min)',
  ],
};

// ============================================================
// Account Health Audit Checks (190+ across platforms)
// ============================================================

const AUDIT_CATEGORIES = {
  google: {
    conversionTracking: { weight: 0.25, checks: [
      'Global site tag installed on all pages',
      'Enhanced Conversions enabled and verified',
      'Consent Mode v2 configured (if EU traffic)',
      'Conversion actions defined — macro (revenue/leads) vs micro (engagement)',
      'Conversion values assigned accurately',
      'Attribution model set (data-driven preferred)',
      'Offline conversion imports configured (if applicable)',
      'Phone call tracking enabled (if phone conversions matter)',
      'Cross-domain tracking configured (if multiple domains)',
      'Conversion lag accounted for in reporting',
      'Test conversions firing correctly',
    ]},
    wastedSpend: { weight: 0.20, checks: [
      'Negative keyword lists applied to all campaigns',
      'Search terms report reviewed (last 30 days)',
      'Wasted spend <5% of total spend',
      'No broad match without Smart Bidding',
      'Location targeting set to "Presence" not "Presence or Interest"',
      'Display network excluded from search campaigns',
      'Partner network performance reviewed',
      'Low QS keywords (<5) identified and addressed',
    ]},
    structure: { weight: 0.15, checks: [
      'Brand and non-brand campaigns segregated',
      'Campaigns organized by theme/intent',
      'Ad groups have tight keyword themes (≤15 keywords)',
      'Single Keyword Ad Groups (SKAGs) for top performers',
      'Match types segregated or strategically mixed',
      'Campaign naming convention consistent',
      'Labels applied for easy filtering',
      'Performance Max asset groups well-organized',
      'Budget allocation follows 70/20/10 rule',
      'Shared budgets used only when appropriate',
      'Campaign priorities set (shopping)',
      'Experiments/drafts used for testing',
    ]},
    keywordsQS: { weight: 0.15, checks: [
      'Average Quality Score ≥7',
      'No keywords with QS <5 running >30 days',
      'Ad relevance rated "Average" or "Above Average"',
      'Landing page experience rated "Average" or "Above Average"',
      'Expected CTR rated "Average" or "Above Average"',
      'Keyword-to-ad copy relevance verified',
      'Landing page content matches keyword intent',
      'Long-tail keywords included for specificity',
    ]},
    adsAssets: { weight: 0.15, checks: [
      'RSAs have 8+ unique headlines',
      'RSAs have 3+ unique descriptions',
      'Ad Strength rated "Good" or "Excellent"',
      'Critical headline pinned to position 1',
      'All ads include clear CTA',
      'Performance Max has 20+ images, 5+ videos, 5+ logos',
      'Dynamic keyword insertion used where appropriate',
      'Ad customizers for scale',
      'A/B testing active (at least 2 ads per ad group)',
      'Responsive display ads configured',
      'Video ads in appropriate formats',
      'Assets (extensions) quality checked',
    ]},
    settings: { weight: 0.10, checks: [
      'Sitelink extensions on all campaigns',
      'Callout extensions highlighting USPs',
      'Structured snippet extensions added',
      'Call extensions enabled (if phone matters)',
      'Location extensions (if local business)',
      'Price extensions (if e-commerce)',
      'Promotion extensions (if running offers)',
      'Audience segments added for observation',
      'Remarketing lists applied',
      'Customer match lists uploaded',
      'Landing page URLs verified (no 404s)',
      'Ad schedule optimized for peak hours',
    ]},
  },
  meta: {
    pixelCAPI: { weight: 0.30, checks: [
      'Meta Pixel installed and firing on all pages',
      'CAPI (Conversions API) implemented server-side',
      'Event Match Quality (EMQ) ≥8.0',
      'Event deduplication configured (pixel + CAPI)',
      'Standard events mapped correctly (Purchase, Lead, AddToCart, etc.)',
      'Custom conversions defined for business-specific goals',
      'Domain verification completed',
      'iOS 14.5+ aggregated event measurement configured',
      'Value optimization enabled with accurate values',
      'Test events verified in Events Manager',
    ]},
    creativeDiversity: { weight: 0.30, checks: [
      'Minimum 3+ creative formats per campaign',
      'Static images, video, and carousel all tested',
      'Creative refresh cycle ≤30 days',
      'Ad frequency <3/week for prospecting',
      'Ad frequency <8/week for retargeting',
      'CTR decline >20% triggers creative refresh',
      'UGC-style creatives tested (2-3x higher performance)',
      'Reels/Stories format (9:16) included',
      'Feed format (4:5) included',
      'Dynamic creative optimization tested',
      'Creative testing framework in place',
      'Winning creative elements identified and scaled',
    ]},
    accountStructure: { weight: 0.20, checks: [
      'CBO used for scaling campaigns',
      'ABO used for testing campaigns',
      'Advantage+ campaigns tested for prospecting',
      '3-5 ad sets per campaign',
      '3-6 ads per ad set',
      'Learning phase: ≥50 conversions/week per ad set',
      'Campaign naming convention consistent',
      'Prospecting and retargeting separated',
    ]},
    audienceTargeting: { weight: 0.20, checks: [
      'Lookalike audiences starting at 1% (expanding to 3-5%)',
      'Custom audiences: website visitors (30/60/90 day)',
      'Customer list uploaded and matched',
      'Video viewer audiences created',
      'Audience overlap <20% between ad sets',
      'Converters excluded from prospecting',
      'Broad targeting tested with strong creative',
      'Interest stacking: 2-3 related interests per ad set',
    ]},
  },
  tiktok: {
    creativeQuality: { weight: 0.30, checks: [
      'All videos in 9:16 vertical format',
      'Hook in first 3 seconds',
      'Native-feeling content (not corporate)',
      'Audio included on all video ads',
      'CTA above bottom 450px safe zone',
      'Spark Ads tested vs standard in-feed',
      '15-30s optimal video length',
      'Multiple creative variations tested (3-5 per ad group)',
    ]},
    technicalSetup: { weight: 0.25, checks: [
      'TikTok Pixel installed and verified',
      'ttclid parameter captured and passed back',
      'Events API (server-side) configured',
      'Standard events mapped (CompletePayment, SubmitForm, etc.)',
      'Search Ads Toggle enabled',
    ]},
    biddingLearning: { weight: 0.15, checks: [
      'Daily budget ≥50x target CPA per ad group',
      '≥50 conversions/week per ad group for learning',
      'Lowest Cost bidding for most campaigns',
      'Cost Cap at 1.2-1.5x CPA if needed',
    ]},
    structureSettings: { weight: 0.15, checks: [
      'Prospecting and retargeting separated',
      'Interest-based and broad targeting both tested',
      'Custom audiences from pixel data',
      'Lookalike audiences created',
    ]},
    performance: { weight: 0.15, checks: [
      'CTR ≥1.0%',
      'CPA within target range',
      '6+ second video completion rates tracked',
      'Frequency monitored and controlled',
    ]},
  },
  linkedin: {
    technicalSetup: { weight: 0.25, checks: [
      'Insight Tag installed on all pages',
      'Conversions API configured',
      'Conversion tracking events defined',
      'Offline conversion imports set up (90-day window)',
    ]},
    audienceQuality: { weight: 0.25, checks: [
      'Job title targeting precise (not overly broad)',
      'Company size and industry filtering applied',
      'ABM account lists uploaded',
      'Matched Audiences from website visitors',
      'Lookalike audiences from customer lists',
    ]},
    creativeFormats: { weight: 0.20, checks: [
      'Thought Leader Ads allocated ≥30% budget',
      'Multiple formats tested (image, video, carousel, document)',
      'Single image: 1200x627 or 1080x1080',
      'Video: 15-30s recommended length',
      'Creative refresh every 4-6 weeks',
    ]},
    leadGen: { weight: 0.15, checks: [
      'Lead Gen Forms have ≤5 fields',
      'CRM integration for real-time sync',
      'Thank you page/message configured',
      'Pre-filled fields used where possible',
    ]},
    biddingBudget: { weight: 0.15, checks: [
      'Minimum $50/day budget per campaign',
      'Bid strategy appropriate for goal',
      'InMail frequency capped at 1 per 30-45 days',
      'Cost per lead within industry benchmarks',
    ]},
  },
};

// ============================================================
// PPC Account Health Audit
// ============================================================

/**
 * Run a PPC account health audit for a specific platform.
 * Uses account data + AI analysis to score health across weighted categories.
 *
 * @param {string} platform - Platform to audit: google, meta, tiktok, linkedin, microsoft
 * @param {object} accountData - Account performance data (campaigns, metrics, settings)
 * @returns {object} Health score, category breakdowns, critical issues, quick wins
 */
export async function auditPPCHealth(platform, accountData = {}) {
  const platformLower = platform.toLowerCase().replace(/\s+/g, '');
  const platformKey = platformLower === 'facebook' || platformLower === 'instagram' ? 'meta' : platformLower;

  const categories = AUDIT_CATEGORIES[platformKey];
  if (!categories) {
    return {
      error: `Unsupported platform: ${platform}. Supported: google, meta, tiktok, linkedin`,
      supportedPlatforms: Object.keys(AUDIT_CATEGORIES),
    };
  }

  log.info('Starting PPC health audit', { platform: platformKey });

  const specs = CREATIVE_SPECS[platformKey] || {};
  const benchmarks = BENCHMARKS[platformKey] || {};
  const biddingLadder = BIDDING_LADDERS[platformKey] || [];
  const quickWins = QUICK_WINS[platformKey] || [];
  const compliance = COMPLIANCE.trackingRequirements[platformKey] || '';

  const prompt = `You are a senior PPC account auditor. Analyze this ${platform} ads account data and score it across the audit categories below.

ACCOUNT DATA PROVIDED:
${JSON.stringify(accountData, null, 2) || 'No specific account data — provide general assessment based on best practices'}

AUDIT CATEGORIES AND CHECKS:
${Object.entries(categories).map(([cat, { weight, checks }]) =>
    `\n### ${cat} (Weight: ${(weight * 100).toFixed(0)}%)\n${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
  ).join('\n')}

PLATFORM BENCHMARKS:
${JSON.stringify(benchmarks, null, 2)}

BIDDING STRATEGY LADDER:
${JSON.stringify(biddingLadder, null, 2)}

TRACKING REQUIREMENTS:
${compliance}

Score each category 0-100 based on the data available. If data is insufficient for a check, note it as "needs_verification".

Respond with ONLY valid JSON:
{
  "platform": "${platformKey}",
  "overallScore": 0-100,
  "grade": "A|B|C|D|F",
  "categories": {
    "${Object.keys(categories)[0]}": { "score": 0-100, "weight": ${Object.values(categories)[0].weight}, "passed": 0, "total": ${Object.values(categories)[0].checks.length}, "criticalIssues": [], "recommendations": [] }
  },
  "criticalIssues": ["issue1"],
  "quickWins": ["win1", "win2", "win3"],
  "biddingRecommendation": "current strategy assessment and recommendation",
  "trackingStatus": "assessment of conversion tracking setup",
  "creativeHealth": "assessment of creative diversity and performance",
  "summary": "2-3 sentence overall health assessment"
}`;

  try {
    const response = await askClaude({
      systemPrompt: `You are a senior PPC account auditor specializing in ${platform} advertising. Score accounts using weighted health methodology across conversion tracking, creative quality, account structure, and targeting. Use 2026 benchmarks and best practices. Output ONLY valid JSON.`,
      userMessage: prompt,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow: 'ppc-health-audit',
    });

    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse audit response');

    // Add quick wins from knowledge base
    result.platformQuickWins = quickWins;
    result.creativeSpecs = specs;

    log.info('PPC health audit complete', { platform: platformKey, score: result.overallScore, grade: result.grade });
    return result;
  } catch (e) {
    log.error('PPC health audit failed', { platform: platformKey, error: e.message });
    throw new Error(`PPC health audit failed for ${platform}: ${e.message}`);
  }
}

/**
 * Get platform-specific creative specs, benchmarks, and best practices.
 * Quick reference tool — no AI call needed.
 */
export function getPlatformSpecs(platform) {
  const platformLower = platform.toLowerCase().replace(/\s+/g, '');
  const platformKey = platformLower === 'facebook' || platformLower === 'instagram' ? 'meta' : platformLower;

  return {
    platform: platformKey,
    creativeSpecs: CREATIVE_SPECS[platformKey] || null,
    benchmarks: BENCHMARKS[platformKey] || null,
    biddingLadder: BIDDING_LADDERS[platformKey] || BIDDING_LADDERS[platformLower] || null,
    quickWins: QUICK_WINS[platformKey] || [],
    trackingRequirements: COMPLIANCE.trackingRequirements[platformKey] || null,
    specialCategories: COMPLIANCE.specialCategories,
    dangerSignals: DANGER_SIGNALS,
    merBenchmarks: BENCHMARKS.mer,
  };
}

/**
 * Get the recommended bidding strategy based on conversion volume.
 */
export function getBiddingRecommendation(platform, monthlyConversions) {
  const ladder = BIDDING_LADDERS[platform.toLowerCase()];
  if (!ladder || !Array.isArray(ladder)) {
    return { platform, recommendation: 'Use platform default bidding', note: 'No specific ladder for this platform' };
  }

  for (const step of ladder) {
    if (step.conversions) {
      const match = step.conversions.match(/(\d+)/);
      if (match && monthlyConversions < parseInt(match[1])) {
        return { platform, monthlyConversions, recommended: step.strategy, note: step.note };
      }
    }
  }

  // Return last (highest) tier
  const last = ladder[ladder.length - 1];
  return { platform, monthlyConversions, recommended: last.strategy || last.default, note: last.note };
}

export default {
  auditPPCHealth,
  getPlatformSpecs,
  getBiddingRecommendation,
  CREATIVE_SPECS,
  BENCHMARKS,
  BIDDING_LADDERS,
  COMPLIANCE,
  QUICK_WINS,
  INDUSTRY_BUDGETS,
  DANGER_SIGNALS,
};
