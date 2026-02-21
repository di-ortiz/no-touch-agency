import * as googleDrive from '../api/google-drive.js';
import { askClaude } from '../api/anthropic.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'report-builder' });

/**
 * Build a formatted Google Doc report and export as PDF.
 * Returns both the Doc URL (editable) and PDF download URL.
 *
 * @param {object} opts
 * @param {string} opts.title - Report title
 * @param {string} opts.content - Full report content (plain text with newlines)
 * @param {string} opts.folderId - Google Drive folder ID
 * @returns {object} { docId, docUrl, pdfUrl }
 */
export async function buildReport(opts = {}) {
  const doc = await googleDrive.createDocument(opts.title, opts.content, opts.folderId);

  // Export as PDF
  let pdfUrl = null;
  try {
    pdfUrl = `https://docs.google.com/document/d/${doc.id}/export?format=pdf`;
  } catch (e) {
    log.warn('PDF export URL generation failed', { error: e.message });
  }

  log.info(`Report built: ${opts.title}`, { docId: doc.id });
  return {
    docId: doc.id,
    docUrl: doc.webViewLink || `https://docs.google.com/document/d/${doc.id}/edit`,
    pdfUrl,
  };
}

/**
 * Generate a performance report document (Google Doc + PDF).
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.reportType - 'weekly' | 'monthly'
 * @param {object} opts.metrics - Ad platform metrics
 * @param {object} opts.analytics - GA4 analytics data
 * @param {Array} opts.campaigns - Campaign data
 * @param {Array} opts.topKeywords - Top keywords
 * @param {object} opts.audienceData - Audience demographics
 * @param {string} opts.folderId
 */
export async function generatePerformanceReport(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const period = opts.reportType === 'monthly' ? 'Monthly' : 'Weekly';

  // Build the report sections
  const sections = [];
  sections.push(`${opts.clientName} — ${period} Performance Report`);
  sections.push(`Generated: ${date}`);
  sections.push(`Date Range: ${opts.dateRange || 'Last 7 days'}`);
  sections.push('');

  // Core Metrics
  if (opts.metrics) {
    const m = opts.metrics;
    sections.push('═══ KEY PERFORMANCE METRICS ═══');
    sections.push('');
    if (m.spend != null) sections.push(`Total Spend: $${m.spend}`);
    if (m.impressions != null) sections.push(`Impressions: ${m.impressions}`);
    if (m.clicks != null) sections.push(`Clicks: ${m.clicks}`);
    if (m.conversions != null) sections.push(`Conversions: ${m.conversions}`);
    if (m.ctr != null) sections.push(`CTR: ${m.ctr}%`);
    if (m.cpa != null) sections.push(`CPA: $${m.cpa}`);
    if (m.roas != null) sections.push(`ROAS: ${m.roas}x`);
    if (m.cpc != null) sections.push(`Avg CPC: $${m.cpc}`);
    sections.push('');
  }

  // Campaign Breakdown
  if (opts.campaigns && opts.campaigns.length > 0) {
    sections.push('═══ CAMPAIGN BREAKDOWN ═══');
    sections.push('');
    for (const c of opts.campaigns) {
      sections.push(`Campaign: ${c.name}`);
      sections.push(`  Spend: $${c.spend || '—'}  |  Clicks: ${c.clicks || '—'}  |  Conv: ${c.conversions || '—'}  |  CPA: $${c.cpa || '—'}  |  ROAS: ${c.roas || '—'}x`);
      sections.push('');
    }
  }

  // Website Analytics
  if (opts.analytics) {
    const a = opts.analytics;
    sections.push('═══ WEBSITE ANALYTICS ═══');
    sections.push('');
    if (a.sessions != null) sections.push(`Sessions: ${a.sessions}`);
    if (a.totalUsers != null) sections.push(`Total Users: ${a.totalUsers}`);
    if (a.pageViews != null) sections.push(`Page Views: ${a.pageViews}`);
    if (a.bounceRate != null) sections.push(`Bounce Rate: ${a.bounceRate}%`);
    if (a.engagementRate != null) sections.push(`Engagement Rate: ${a.engagementRate}%`);
    sections.push('');

    if (a.trafficSources) {
      sections.push('Traffic Sources:');
      for (const s of a.trafficSources) {
        sections.push(`  ${s.channel}: ${s.sessions} sessions, ${s.users} users, ${s.conversions} conv`);
      }
      sections.push('');
    }

    if (a.topPages) {
      sections.push('Top Pages:');
      for (const p of a.topPages.slice(0, 10)) {
        sections.push(`  ${p.path}: ${p.pageViews} views, ${p.avgDuration}s avg duration`);
      }
      sections.push('');
    }
  }

  // Top Keywords
  if (opts.topKeywords && opts.topKeywords.length > 0) {
    sections.push('═══ TOP KEYWORDS ═══');
    sections.push('');
    for (const k of opts.topKeywords.slice(0, 15)) {
      sections.push(`  ${k.keyword}: ${k.impressions || '—'} imp, ${k.clicks || '—'} clicks, ${k.ctr || '—'}% CTR, ${k.conversions || '—'} conv`);
    }
    sections.push('');
  }

  // Audience
  if (opts.audienceData) {
    sections.push('═══ AUDIENCE INSIGHTS ═══');
    sections.push('');
    if (opts.audienceData.devices) {
      sections.push('By Device:');
      for (const d of opts.audienceData.devices) {
        sections.push(`  ${d.device}: ${d.sessions} sessions`);
      }
    }
    if (opts.audienceData.countries) {
      sections.push('Top Countries:');
      for (const c of opts.audienceData.countries.slice(0, 5)) {
        sections.push(`  ${c.country}: ${c.sessions} sessions`);
      }
    }
    sections.push('');
  }

  // AI Analysis
  if (opts.analysis) {
    sections.push('═══ ANALYSIS & INSIGHTS ═══');
    sections.push('');
    sections.push(opts.analysis);
    sections.push('');
  }

  // Recommendations
  if (opts.recommendations) {
    sections.push('═══ RECOMMENDATIONS ═══');
    sections.push('');
    sections.push(opts.recommendations);
  }

  const content = sections.join('\n');
  const title = `${opts.clientName} — ${period} Report — ${date}`;

  return buildReport({ title, content, folderId: opts.folderId });
}

/**
 * Generate a competitor analysis report document (Google Doc + PDF).
 */
export async function generateCompetitorReport(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const sections = [];

  sections.push(`${opts.clientName} — Competitor Analysis Report`);
  sections.push(`Generated: ${date}`);
  sections.push('');

  if (opts.summary) {
    sections.push('═══ EXECUTIVE SUMMARY ═══');
    sections.push('');
    sections.push(opts.summary);
    sections.push('');
  }

  if (opts.competitors && opts.competitors.length > 0) {
    sections.push('═══ COMPETITOR LANDSCAPE ═══');
    sections.push('');
    for (const c of opts.competitors) {
      sections.push(`${c.name || c.domain}`);
      sections.push(`  Domain: ${c.domain || '—'}`);
      sections.push(`  Est. Traffic: ${c.traffic || c.estimatedTraffic || '—'}`);
      sections.push(`  Keywords: ${c.keywords || '—'}`);
      if (c.strengths) sections.push(`  Strengths: ${c.strengths}`);
      if (c.weaknesses) sections.push(`  Weaknesses: ${c.weaknesses}`);
      sections.push('');
    }
  }

  if (opts.keywordGap && opts.keywordGap.length > 0) {
    sections.push('═══ KEYWORD GAP ANALYSIS ═══');
    sections.push('');
    for (const k of opts.keywordGap.slice(0, 30)) {
      sections.push(`  ${k.keyword}: Vol ${k.volume || '—'}, Their Rank: ${k.competitorPosition || '—'}, Your Rank: ${k.yourPosition || 'Not ranking'}`);
    }
    sections.push('');
  }

  if (opts.competitorAds && opts.competitorAds.length > 0) {
    sections.push('═══ COMPETITOR AD CREATIVES ═══');
    sections.push('');
    for (const ad of opts.competitorAds) {
      sections.push(`Advertiser: ${ad.pageName || '—'}`);
      if (ad.headline) sections.push(`  Headline: ${ad.headline}`);
      if (ad.body) sections.push(`  Copy: ${ad.body}`);
      sections.push('');
    }
  }

  if (opts.recommendations) {
    sections.push('═══ STRATEGIC RECOMMENDATIONS ═══');
    sections.push('');
    sections.push(opts.recommendations);
  }

  const content = sections.join('\n');
  const title = `${opts.clientName} — Competitor Report — ${date}`;

  return buildReport({ title, content, folderId: opts.folderId });
}

/**
 * Generate an AI-written analysis for a report using the provided data.
 */
export async function generateReportAnalysis(opts = {}) {
  const response = await askClaude({
    systemPrompt: 'You are a senior PPC strategist writing a performance analysis section for a client report. Be data-driven, specific, and actionable. Focus on what the numbers mean and what should be done next.',
    userMessage: `Write a concise performance analysis and recommendations section for this client report:

Client: ${opts.clientName}
Report Type: ${opts.reportType || 'weekly'}

Data:
${JSON.stringify(opts.data, null, 2)}

Write two sections:
1. ANALYSIS (3-5 paragraphs analyzing the data, trends, and key observations)
2. RECOMMENDATIONS (5-8 bullet points with specific, actionable next steps)`,
    maxTokens: 2048,
    workflow: 'report-analysis',
    clientId: opts.clientId,
  });

  return response.text;
}

export default {
  buildReport,
  generatePerformanceReport,
  generateCompetitorReport,
  generateReportAnalysis,
};
