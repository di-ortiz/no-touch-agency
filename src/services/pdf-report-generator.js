import { createRequire } from 'module';
import { askClaude } from '../api/anthropic.js';
import { askKimi, isConfigured as isKimiConfigured } from '../api/kimi.js';
import { uploadWhatsAppMedia, sendWhatsApp } from '../api/whatsapp.js';
import config from '../config.js';
import axios from 'axios';
import logger from '../utils/logger.js';

const require = createRequire(import.meta.url);
const PdfPrinter = require('pdfmake/src/printer');

const log = logger.child({ service: 'pdf-report-generator' });

// ─── FONTS (standard PDF fonts — no external TTF needed) ──────────────────────
const fonts = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const printer = new PdfPrinter(fonts);

// ─── BRAND COLORS ─────────────────────────────────────────────────────────────
const BRAND = {
  primary: '#212237',
  secondary: '#3c78f6',
  accent: '#00d1ab',
  lightGray: '#f5f5f7',
  darkGray: '#4a4a5a',
  white: '#ffffff',
};

// ─── PDF BUFFER HELPER ────────────────────────────────────────────────────────

function generatePdfBuffer(docDefinition) {
  return new Promise((resolve, reject) => {
    try {
      const doc = printer.createPdfKitDocument(docDefinition);
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ─── AI ANALYSIS GENERATION ───────────────────────────────────────────────────

async function generateAnalysis(prompt, clientId, workflow) {
  const systemPrompt = 'You are a senior PPC/digital marketing strategist. Write clear, data-driven analysis with actionable recommendations. Be concise — no fluff. Use bullet points for recommendations.';

  // Try Kimi first (cheaper), fallback to Claude
  if (isKimiConfigured()) {
    try {
      const result = await askKimi({
        systemPrompt,
        userMessage: prompt,
        maxTokens: 3000,
        workflow: workflow || 'pdf-report-analysis',
        clientId,
      });
      return result.text;
    } catch (error) {
      log.warn('Kimi analysis failed, falling back to Claude', { error: error.message });
    }
  }

  const result = await askClaude({
    systemPrompt,
    userMessage: prompt,
    maxTokens: 3000,
    workflow: workflow || 'pdf-report-analysis',
    clientId,
  });
  return result.text;
}

// ─── DOCUMENT DEFINITION BUILDERS ─────────────────────────────────────────────

function makeHeader(title, subtitle) {
  return [
    {
      canvas: [{
        type: 'rect', x: 0, y: 0, w: 515, h: 80,
        color: BRAND.primary,
      }],
    },
    {
      text: title,
      fontSize: 22,
      bold: true,
      color: BRAND.white,
      margin: [20, -65, 20, 0],
    },
    {
      text: subtitle || new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }),
      fontSize: 11,
      color: BRAND.accent,
      margin: [20, 4, 20, 20],
    },
  ];
}

function makeSectionTitle(text) {
  return [
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND.secondary }] },
    { text, fontSize: 14, bold: true, color: BRAND.primary, margin: [0, 10, 0, 8] },
  ];
}

function makeMetricsRow(metrics) {
  const cols = Object.entries(metrics).map(([label, value]) => ({
    stack: [
      { text: String(value), fontSize: 18, bold: true, color: BRAND.secondary, alignment: 'center' },
      { text: label, fontSize: 8, color: BRAND.darkGray, alignment: 'center', margin: [0, 2, 0, 0] },
    ],
    width: '*',
  }));

  return {
    columns: cols,
    margin: [0, 5, 0, 15],
    columnGap: 10,
  };
}

function makeTable(headers, rows) {
  return {
    table: {
      headerRows: 1,
      widths: headers.map(() => '*'),
      body: [
        headers.map(h => ({ text: h, bold: true, fontSize: 9, color: BRAND.white, fillColor: BRAND.primary, margin: [4, 4, 4, 4] })),
        ...rows.map((row, i) =>
          row.map(cell => ({
            text: String(cell ?? '—'),
            fontSize: 9,
            margin: [4, 3, 4, 3],
            fillColor: i % 2 === 0 ? BRAND.lightGray : BRAND.white,
          })),
        ),
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => '#e0e0e0',
      vLineColor: () => '#e0e0e0',
    },
    margin: [0, 5, 0, 15],
  };
}

function makeTextBlock(text) {
  return { text, fontSize: 10, color: BRAND.darkGray, lineHeight: 1.4, margin: [0, 0, 0, 10] };
}

function makeBulletList(items) {
  return {
    ul: items.map(item => ({ text: item, fontSize: 10, color: BRAND.darkGray, margin: [0, 2, 0, 2] })),
    margin: [0, 0, 0, 15],
  };
}

function makeFooter() {
  return function (currentPage, pageCount) {
    return {
      columns: [
        { text: 'Confidential — Prepared by Sofia AI', fontSize: 7, color: '#999', margin: [40, 0, 0, 0] },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: '#999', alignment: 'right', margin: [0, 0, 40, 0] },
      ],
      margin: [0, 10, 0, 0],
    };
  };
}

// ─── PERFORMANCE REPORT ───────────────────────────────────────────────────────

export async function generatePerformancePdf(opts = {}) {
  log.info('Generating performance PDF report', { client: opts.clientName, type: opts.reportType });

  const date = new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const period = opts.reportType === 'monthly' ? 'Relatório Mensal' : 'Relatório Semanal';

  const content = [];

  // Header
  content.push(...makeHeader(`${opts.clientName || 'Client'} — ${period}`, `${opts.dateRange || 'Últimos 7 dias'} | ${date}`));

  // Key Metrics
  if (opts.metrics) {
    const m = opts.metrics;
    content.push(...makeSectionTitle('Key Performance Metrics'));
    const metricsObj = {};
    if (m.spend != null) metricsObj['Spend'] = `$${m.spend}`;
    if (m.impressions != null) metricsObj['Impressions'] = m.impressions.toLocaleString();
    if (m.clicks != null) metricsObj['Clicks'] = m.clicks.toLocaleString();
    if (m.conversions != null) metricsObj['Conversions'] = m.conversions;
    if (m.ctr != null) metricsObj['CTR'] = `${m.ctr}%`;
    if (m.roas != null) metricsObj['ROAS'] = `${m.roas}x`;
    if (Object.keys(metricsObj).length > 0) content.push(makeMetricsRow(metricsObj));
  }

  // Campaign Breakdown
  if (opts.campaigns?.length > 0) {
    content.push(...makeSectionTitle('Campaign Breakdown'));
    const headers = ['Campaign', 'Spend', 'Clicks', 'Conv.', 'CPA', 'ROAS'];
    const rows = opts.campaigns.map(c => [
      c.name, `$${c.spend || '—'}`, c.clicks || '—', c.conversions || '—', `$${c.cpa || '—'}`, `${c.roas || '—'}x`,
    ]);
    content.push(makeTable(headers, rows));
  }

  // Website Analytics
  if (opts.analytics) {
    content.push(...makeSectionTitle('Website Analytics'));
    const a = opts.analytics;
    const analyticsMetrics = {};
    if (a.sessions != null) analyticsMetrics['Sessions'] = a.sessions.toLocaleString();
    if (a.totalUsers != null) analyticsMetrics['Users'] = a.totalUsers.toLocaleString();
    if (a.pageViews != null) analyticsMetrics['Page Views'] = a.pageViews.toLocaleString();
    if (a.bounceRate != null) analyticsMetrics['Bounce Rate'] = `${a.bounceRate}%`;
    if (Object.keys(analyticsMetrics).length > 0) content.push(makeMetricsRow(analyticsMetrics));

    if (a.trafficSources?.length > 0) {
      content.push(makeTable(
        ['Channel', 'Sessions', 'Users', 'Conversions'],
        a.trafficSources.map(s => [s.channel, s.sessions, s.users, s.conversions || '—']),
      ));
    }
  }

  // Top Keywords
  if (opts.topKeywords?.length > 0) {
    content.push(...makeSectionTitle('Top Keywords'));
    content.push(makeTable(
      ['Keyword', 'Impressions', 'Clicks', 'CTR', 'Conv.'],
      opts.topKeywords.slice(0, 15).map(k => [k.keyword, k.impressions || '—', k.clicks || '—', `${k.ctr || '—'}%`, k.conversions || '—']),
    ));
  }

  // AI Analysis
  if (opts.analysis) {
    content.push(...makeSectionTitle('Analysis & Insights'));
    content.push(makeTextBlock(opts.analysis));
  } else if (opts.metrics || opts.campaigns) {
    try {
      const analysisText = await generateAnalysis(
        `Analyze this performance data for ${opts.clientName}:\n${JSON.stringify({ metrics: opts.metrics, campaigns: opts.campaigns, analytics: opts.analytics }, null, 2)}\n\nProvide: 1) Key insights (2-3 paragraphs), 2) Top 5 recommendations`,
        opts.clientId,
        'pdf-performance-analysis',
      );
      content.push(...makeSectionTitle('Analysis & Insights'));
      content.push(makeTextBlock(analysisText));
    } catch (e) {
      log.warn('AI analysis generation failed', { error: e.message });
    }
  }

  // Recommendations
  if (opts.recommendations?.length > 0) {
    content.push(...makeSectionTitle('Recommendations'));
    content.push(makeBulletList(opts.recommendations));
  }

  const docDefinition = {
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    pageMargins: [40, 40, 40, 50],
    footer: makeFooter(),
    info: {
      title: `${opts.clientName} — ${period}`,
      author: 'Sofia AI — PPC Agency',
    },
  };

  const buffer = await generatePdfBuffer(docDefinition);
  log.info('Performance PDF generated', { size: buffer.length, client: opts.clientName });
  return buffer;
}

// ─── COMPETITOR REPORT ────────────────────────────────────────────────────────

export async function generateCompetitorPdf(opts = {}) {
  log.info('Generating competitor PDF report', { client: opts.clientName });

  const date = new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const content = [];

  content.push(...makeHeader(`${opts.clientName || 'Client'} — Competitive Analysis`, date));

  // Executive Summary
  if (opts.summary) {
    content.push(...makeSectionTitle('Executive Summary'));
    content.push(makeTextBlock(opts.summary));
  }

  // Competitor Landscape
  if (opts.competitors?.length > 0) {
    content.push(...makeSectionTitle('Competitor Landscape'));
    const headers = ['Competitor', 'Domain', 'Est. Traffic', 'Keywords', 'Strengths'];
    const rows = opts.competitors.map(c => [
      c.name || c.domain, c.domain || '—', c.traffic || c.estimatedTraffic || '—',
      c.keywords || '—', c.strengths || '—',
    ]);
    content.push(makeTable(headers, rows));
  }

  // Keyword Gap
  if (opts.keywordGap?.length > 0) {
    content.push(...makeSectionTitle('Keyword Gap Analysis'));
    content.push(makeTable(
      ['Keyword', 'Volume', 'Their Rank', 'Your Rank'],
      opts.keywordGap.slice(0, 20).map(k => [k.keyword, k.volume || '—', k.competitorPosition || '—', k.yourPosition || 'N/A']),
    ));
  }

  // SERP Analysis
  if (opts.serpData) {
    content.push(...makeSectionTitle('SERP Landscape'));
    content.push(makeTextBlock(typeof opts.serpData === 'string' ? opts.serpData : JSON.stringify(opts.serpData)));
  }

  // Competitor Ads
  if (opts.competitorAds?.length > 0) {
    content.push(...makeSectionTitle('Competitor Ad Creatives'));
    for (const ad of opts.competitorAds.slice(0, 10)) {
      content.push({
        stack: [
          { text: ad.pageName || ad.advertiser || 'Unknown', fontSize: 11, bold: true, color: BRAND.primary },
          ad.headline ? { text: ad.headline, fontSize: 10, italics: true, color: BRAND.secondary, margin: [0, 2, 0, 0] } : null,
          ad.body ? { text: ad.body, fontSize: 9, color: BRAND.darkGray, margin: [0, 2, 0, 8] } : null,
        ].filter(Boolean),
        margin: [0, 0, 0, 8],
      });
    }
  }

  // AI Analysis
  if (opts.analysis) {
    content.push(...makeSectionTitle('Strategic Analysis'));
    content.push(makeTextBlock(opts.analysis));
  } else if (opts.competitors?.length > 0) {
    try {
      const analysisText = await generateAnalysis(
        `Provide a competitive analysis for ${opts.clientName}. Competitors: ${JSON.stringify(opts.competitors)}. Keyword gaps: ${JSON.stringify(opts.keywordGap?.slice(0, 10))}. Give strategic recommendations.`,
        opts.clientId,
        'pdf-competitor-analysis',
      );
      content.push(...makeSectionTitle('Strategic Analysis'));
      content.push(makeTextBlock(analysisText));
    } catch (e) {
      log.warn('AI competitor analysis generation failed', { error: e.message });
    }
  }

  // Recommendations
  if (opts.recommendations?.length > 0) {
    content.push(...makeSectionTitle('Recommendations'));
    content.push(makeBulletList(opts.recommendations));
  }

  const docDefinition = {
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    pageMargins: [40, 40, 40, 50],
    footer: makeFooter(),
    info: {
      title: `${opts.clientName} — Competitive Analysis`,
      author: 'Sofia AI — PPC Agency',
    },
  };

  const buffer = await generatePdfBuffer(docDefinition);
  log.info('Competitor PDF generated', { size: buffer.length, client: opts.clientName });
  return buffer;
}

// ─── GENERIC CUSTOM REPORT ────────────────────────────────────────────────────

export async function generateCustomPdf(opts = {}) {
  log.info('Generating custom PDF report', { title: opts.title });

  const content = [];
  content.push(...makeHeader(opts.title || 'Report', opts.subtitle));

  for (const section of (opts.sections || [])) {
    if (section.title) content.push(...makeSectionTitle(section.title));

    if (section.metrics) content.push(makeMetricsRow(section.metrics));

    if (section.text) content.push(makeTextBlock(section.text));

    if (section.bullets) content.push(makeBulletList(section.bullets));

    if (section.table) {
      content.push(makeTable(section.table.headers, section.table.rows));
    }
  }

  const docDefinition = {
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    pageMargins: [40, 40, 40, 50],
    footer: makeFooter(),
    info: { title: opts.title || 'Report', author: 'Sofia AI — PPC Agency' },
  };

  const buffer = await generatePdfBuffer(docDefinition);
  log.info('Custom PDF generated', { size: buffer.length, title: opts.title });
  return buffer;
}

// ─── SEND PDF VIA WHATSAPP ────────────────────────────────────────────────────

export async function sendPdfViaWhatsApp(buffer, fileName, caption, to) {
  const recipient = to || config.WHATSAPP_OWNER_PHONE;
  try {
    // Upload PDF buffer to WhatsApp Media API
    const mediaId = await uploadWhatsAppMedia(buffer, 'application/pdf', fileName || 'report.pdf');

    // Send as document message
    const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';
    await axios.post(
      `${GRAPH_API_BASE}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'document',
        document: {
          id: mediaId,
          filename: fileName || 'report.pdf',
          ...(caption ? { caption } : {}),
        },
      },
      { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } },
    );

    log.info('PDF sent via WhatsApp', { fileName, to: recipient, mediaId });
    return true;
  } catch (error) {
    log.error('Failed to send PDF via WhatsApp', { fileName, error: error.message });
    // Fallback: send text notification
    try {
      await sendWhatsApp(`${caption || 'Report ready'} (PDF generation succeeded but delivery failed — please contact support)`, recipient);
    } catch (e) { /* best effort */ }
    return false;
  }
}

export default {
  generatePerformancePdf,
  generateCompetitorPdf,
  generateCustomPdf,
  sendPdfViaWhatsApp,
};
