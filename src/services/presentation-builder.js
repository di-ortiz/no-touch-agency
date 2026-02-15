import * as googleSlides from '../api/google-slides.js';
import * as chartBuilder from './chart-builder.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'presentation-builder' });

// Shared brand colors (same as google-slides.js)
const C = {
  primary:   { red: 0.13, green: 0.15, blue: 0.23 },
  secondary: { red: 0.24, green: 0.47, blue: 0.96 },
  accent:    { red: 0.0,  green: 0.82, blue: 0.67 },
  white:     { red: 1.0,  green: 1.0,  blue: 1.0  },
  lightGray: { red: 0.95, green: 0.95, blue: 0.95 },
  darkText:  { red: 0.2,  green: 0.2,  blue: 0.2  },
  mutedText: { red: 0.5,  green: 0.5,  blue: 0.5  },
  red:       { red: 0.9,  green: 0.2,  blue: 0.2  },
  green:     { red: 0.13, green: 0.72, blue: 0.35 },
};

let uid = 0;
function id(prefix) { return `${prefix}_${Date.now()}_${uid++}`; }

function textBox(slideId, boxId, opts) {
  const reqs = [];
  reqs.push({
    createShape: {
      objectId: boxId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: slideId,
        size: { width: { magnitude: opts.width, unit: 'PT' }, height: { magnitude: opts.height, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, translateX: opts.x, translateY: opts.y, unit: 'PT' },
      },
    },
  });
  reqs.push({ insertText: { objectId: boxId, text: opts.text || '' } });
  const style = { fontSize: { magnitude: opts.fontSize || 14, unit: 'PT' }, fontFamily: 'Inter' };
  if (opts.bold) style.bold = true;
  if (opts.color) style.foregroundColor = { opaqueColor: { rgbColor: opts.color } };
  reqs.push({
    updateTextStyle: { objectId: boxId, style, textRange: { type: 'ALL' }, fields: Object.keys(style).join(',') },
  });
  if (opts.bg) {
    reqs.push({
      updateShapeProperties: {
        objectId: boxId,
        shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: opts.bg } } } },
        fields: 'shapeBackgroundFill',
      },
    });
  }
  return reqs;
}

function addSlide(requests, slideId, slideIndex) {
  requests.push({
    createSlide: { objectId: slideId, insertionIndex: slideIndex, slideLayoutReference: { predefinedLayout: 'BLANK' } },
  });
}

function addTitleSlide(requests, slideIndex, title, subtitle, dateLine) {
  const slideId = id('slide_title');
  addSlide(requests, slideId, slideIndex);
  requests.push(...textBox(slideId, id('t_main'), { x: 50, y: 120, width: 620, height: 80, text: title, fontSize: 36, bold: true, color: C.primary }));
  if (subtitle) requests.push(...textBox(slideId, id('t_sub'), { x: 50, y: 210, width: 620, height: 50, text: subtitle, fontSize: 20, color: C.secondary }));
  if (dateLine) requests.push(...textBox(slideId, id('t_date'), { x: 50, y: 275, width: 620, height: 30, text: dateLine, fontSize: 12, color: C.mutedText }));
  return slideIndex + 1;
}

function addSectionDivider(requests, slideIndex, title, subtitle) {
  const slideId = id('slide_div');
  addSlide(requests, slideId, slideIndex);
  requests.push(...textBox(slideId, id('d_title'), { x: 50, y: 150, width: 620, height: 60, text: title, fontSize: 32, bold: true, color: C.primary }));
  if (subtitle) requests.push(...textBox(slideId, id('d_sub'), { x: 50, y: 220, width: 620, height: 30, text: subtitle, fontSize: 14, color: C.mutedText }));
  return slideIndex + 1;
}

function addContentSlide(requests, slideIndex, heading, body, footnote) {
  const slideId = id('slide_content');
  addSlide(requests, slideId, slideIndex);
  requests.push(...textBox(slideId, id('c_head'), { x: 50, y: 25, width: 620, height: 35, text: heading, fontSize: 22, bold: true, color: C.primary }));
  requests.push(...textBox(slideId, id('c_body'), { x: 50, y: 70, width: 620, height: 280, text: body, fontSize: 12, color: C.darkText }));
  if (footnote) requests.push(...textBox(slideId, id('c_fn'), { x: 50, y: 355, width: 620, height: 18, text: footnote, fontSize: 9, color: C.mutedText }));
  return slideIndex + 1;
}

function addMetricsSlide(requests, slideIndex, heading, metrics) {
  const slideId = id('slide_metrics');
  addSlide(requests, slideId, slideIndex);
  requests.push(...textBox(slideId, id('m_head'), { x: 50, y: 25, width: 620, height: 35, text: heading, fontSize: 22, bold: true, color: C.primary }));

  const cols = Math.min(metrics.length, 4);
  const boxW = 140;
  const gap = (620 - cols * boxW) / (cols + 1);
  metrics.slice(0, 8).forEach((m, i) => {
    const row = Math.floor(i / 4);
    const col = i % 4;
    const x = 50 + gap + col * (boxW + gap);
    const y = 80 + row * 130;
    requests.push(...textBox(slideId, id('m_val'), { x, y, width: boxW, height: 50, text: m.value, fontSize: 28, bold: true, color: C.secondary, bg: C.lightGray }));
    requests.push(...textBox(slideId, id('m_lbl'), { x, y: y + 55, width: boxW, height: 25, text: m.label, fontSize: 11, color: C.mutedText }));
  });
  return slideIndex + 1;
}

function addTableSlide(requests, slideIndex, heading, headers, rows) {
  const slideId = id('slide_table');
  addSlide(requests, slideId, slideIndex);
  requests.push(...textBox(slideId, id('tb_head'), { x: 50, y: 20, width: 620, height: 30, text: heading, fontSize: 20, bold: true, color: C.primary }));

  // Build text table (Slides API tables are complex, text tables are more reliable)
  const colW = headers.map(() => 15);
  let table = headers.join('  |  ') + '\n' + headers.map(() => '———').join('———') + '\n';
  for (const row of rows.slice(0, 20)) {
    table += row.join('  |  ') + '\n';
  }

  requests.push(...textBox(slideId, id('tb_body'), { x: 40, y: 58, width: 640, height: 300, text: table, fontSize: 10, color: C.darkText }));
  if (rows.length > 20) {
    requests.push(...textBox(slideId, id('tb_more'), { x: 50, y: 360, width: 620, height: 18, text: `+ ${rows.length - 20} more rows`, fontSize: 9, color: C.mutedText }));
  }
  return slideIndex + 1;
}

/**
 * Add a chart slide to a presentation. Creates the chart in Sheets and embeds it.
 * IMPORTANT: This must be called AFTER the initial batchUpdate, since it does its
 * own batchUpdate to embed the Sheets chart.
 *
 * @param {string} presentationId
 * @param {string} title - Chart title
 * @param {string} chartType - pie | bar | column | line | area | stacked_bar | stacked_column
 * @param {string[]} labels - Category labels
 * @param {Array<{name: string, values: number[]}>} series - Data series
 * @param {string} folderId
 */
async function addChartSlidePost(presentationId, title, chartType, labels, series, folderId) {
  try {
    const chart = await chartBuilder.createChart({ title, chartType, labels, series, folderId });
    if (!chart || !chart.chartId) {
      log.warn('Chart creation failed, skipping chart slide', { title });
      return;
    }

    const slideId = id('chart_slide');
    const reqs = [];
    reqs.push({
      createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } },
    });
    // Chart heading
    const headId = id('ch_head');
    reqs.push({
      createShape: {
        objectId: headId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 30, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 12, unit: 'PT' },
        },
      },
    });
    reqs.push({ insertText: { objectId: headId, text: title } });
    reqs.push({
      updateTextStyle: {
        objectId: headId,
        style: {
          fontSize: { magnitude: 20, unit: 'PT' },
          fontFamily: 'Inter',
          bold: true,
          foregroundColor: { opaqueColor: { rgbColor: C.primary } },
        },
        textRange: { type: 'ALL' },
        fields: 'fontSize,fontFamily,bold,foregroundColor',
      },
    });
    // Embed chart
    reqs.push(chartBuilder.embedChartRequest(slideId, id('ch_embed'), chart.spreadsheetId, chart.chartId, { x: 60, y: 48, width: 590, height: 330 }));

    await googleSlides.batchUpdate(presentationId, reqs);
  } catch (e) {
    log.warn('Failed to add chart slide', { title, error: e.message });
  }
}

// ============================================================
// Media Plan Presentation
// ============================================================

/**
 * Build a media plan presentation deck.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.campaignName
 * @param {object} opts.mediaPlan - { objective, budget, timeline, channels[], audiences[], projections }
 * @param {Array} opts.creatives - Creative mockup info (optional)
 * @param {string} opts.folderId
 */
export async function buildMediaPlanDeck(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${opts.clientName} — Media Plan — ${opts.campaignName || 'Campaign'} — ${date}`;

  const presentation = await googleSlides.createPresentation(title, opts.folderId);
  if (!presentation) return null;

  const { presentationId } = presentation;
  const defaultSlideId = await googleSlides.getDefaultSlideId(presentationId);

  const requests = [];
  let idx = 0;
  const mp = opts.mediaPlan || {};

  // Title
  idx = addTitleSlide(requests, idx, opts.clientName, `Media Plan: ${opts.campaignName || 'Campaign'}`, `${date} • Budget: ${mp.budget || 'TBD'} • ${mp.timeline || ''}`);

  // Executive Summary
  if (mp.summary) {
    idx = addContentSlide(requests, idx, 'Executive Summary', mp.summary);
  }

  // Objectives & KPIs
  if (mp.objective || mp.kpis) {
    const body = [
      mp.objective ? `OBJECTIVE: ${mp.objective}` : '',
      '',
      mp.kpis ? `KEY PERFORMANCE INDICATORS:\n${mp.kpis.map(k => `• ${k}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    idx = addContentSlide(requests, idx, 'Objectives & KPIs', body);
  }

  // Target Audience
  if (mp.audiences && mp.audiences.length > 0) {
    idx = addSectionDivider(requests, idx, 'Target Audience', `${mp.audiences.length} audience segment${mp.audiences.length > 1 ? 's' : ''}`);
    for (const aud of mp.audiences) {
      const body = typeof aud === 'string' ? aud : [
        aud.name ? `SEGMENT: ${aud.name}` : '',
        aud.demographics ? `Demographics: ${aud.demographics}` : '',
        aud.interests ? `Interests: ${aud.interests}` : '',
        aud.behaviors ? `Behaviors: ${aud.behaviors}` : '',
        aud.size ? `Est. Reach: ${aud.size}` : '',
      ].filter(Boolean).join('\n');
      idx = addContentSlide(requests, idx, typeof aud === 'string' ? 'Audience Segment' : (aud.name || 'Audience Segment'), body);
    }
  }

  // Channel Strategy
  if (mp.channels && mp.channels.length > 0) {
    idx = addSectionDivider(requests, idx, 'Channel Strategy', `${mp.channels.length} channels`);
    for (const ch of mp.channels) {
      const body = typeof ch === 'string' ? ch : [
        ch.platform ? `PLATFORM: ${ch.platform.toUpperCase()}` : '',
        ch.budget ? `Budget Allocation: ${ch.budget}` : '',
        ch.objective ? `Channel Objective: ${ch.objective}` : '',
        ch.adFormats ? `Ad Formats: ${ch.adFormats}` : '',
        ch.targeting ? `Targeting: ${ch.targeting}` : '',
        ch.schedule ? `Schedule: ${ch.schedule}` : '',
        ch.notes ? `\nNotes: ${ch.notes}` : '',
      ].filter(Boolean).join('\n');
      idx = addContentSlide(requests, idx, typeof ch === 'string' ? 'Channel' : (ch.platform || 'Channel'), body);
    }
  }

  // Budget Breakdown
  if (mp.budgetBreakdown) {
    const headers = ['Channel', 'Budget', 'Allocation %', 'Objective'];
    const rows = mp.budgetBreakdown.map(b => [b.channel || '', b.amount || '', b.percentage || '', b.objective || '']);
    idx = addTableSlide(requests, idx, 'Budget Allocation', headers, rows);
  }

  // Projections
  if (mp.projections) {
    const projMetrics = [];
    if (mp.projections.impressions) projMetrics.push({ label: 'Est. Impressions', value: mp.projections.impressions });
    if (mp.projections.clicks) projMetrics.push({ label: 'Est. Clicks', value: mp.projections.clicks });
    if (mp.projections.conversions) projMetrics.push({ label: 'Est. Conversions', value: mp.projections.conversions });
    if (mp.projections.cpa) projMetrics.push({ label: 'Target CPA', value: mp.projections.cpa });
    if (mp.projections.roas) projMetrics.push({ label: 'Target ROAS', value: mp.projections.roas });
    if (mp.projections.reach) projMetrics.push({ label: 'Est. Reach', value: mp.projections.reach });

    if (projMetrics.length > 0) {
      idx = addMetricsSlide(requests, idx, 'Projected Results', projMetrics);
    }
    if (mp.projections.notes) {
      idx = addContentSlide(requests, idx, 'Projection Methodology', mp.projections.notes);
    }
  }

  // Creative Mockups
  if (opts.creatives && opts.creatives.length > 0) {
    idx = addSectionDivider(requests, idx, 'Creative Mockups', `${opts.creatives.length} concepts`);
    for (const cr of opts.creatives) {
      const slideId = id('slide_creative');
      addSlide(requests, slideId, idx++);
      requests.push(...textBox(slideId, id('cr_lbl'), { x: 50, y: 15, width: 620, height: 25, text: cr.label || cr.concept || `Creative ${opts.creatives.indexOf(cr) + 1}`, fontSize: 10, bold: true, color: C.secondary }));
      if (cr.url) {
        requests.push({
          createImage: {
            objectId: id('cr_img'),
            url: cr.url,
            elementProperties: {
              pageObjectId: slideId,
              size: { width: { magnitude: 450, unit: 'PT' }, height: { magnitude: 300, unit: 'PT' } },
              transform: { scaleX: 1, scaleY: 1, translateX: 135, translateY: 50, unit: 'PT' },
            },
          },
        });
      }
    }
  }

  // Timeline
  if (mp.timeline) {
    idx = addContentSlide(requests, idx, 'Timeline', typeof mp.timeline === 'string' ? mp.timeline : mp.timeline.map(t => `${t.phase}: ${t.dates} — ${t.description || ''}`).join('\n'));
  }

  // Next Steps
  const nextSteps = mp.nextSteps || 'Review this media plan and provide feedback.\nOnce approved, we will begin campaign setup.';
  idx = addContentSlide(requests, idx, 'Next Steps', nextSteps);

  // Delete default blank slide
  if (defaultSlideId) requests.push({ deleteObject: { objectId: defaultSlideId } });

  await googleSlides.batchUpdate(presentationId, requests);

  // --- Post-build: Add chart slides (charts require separate batchUpdate calls) ---

  // Budget allocation pie chart
  if (mp.budgetBreakdown && mp.budgetBreakdown.length > 0) {
    const labels = mp.budgetBreakdown.map(b => b.channel || 'Other');
    const values = mp.budgetBreakdown.map(b => parseFloat(String(b.amount || '0').replace(/[^0-9.]/g, '')) || 0);
    if (values.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Budget Allocation', 'pie', labels, [{ name: 'Budget', values }], opts.folderId);
    }
  }

  // Projections bar chart
  if (mp.projections && mp.channels && mp.channels.length > 0) {
    const channelLabels = mp.channels.map(ch => typeof ch === 'string' ? ch : (ch.platform || 'Channel'));
    const hasProjectionData = mp.channels.some(ch => ch.projectedClicks || ch.projectedConversions);
    if (hasProjectionData) {
      const clicksSeries = { name: 'Est. Clicks', values: mp.channels.map(ch => ch.projectedClicks || 0) };
      const convSeries = { name: 'Est. Conversions', values: mp.channels.map(ch => ch.projectedConversions || 0) };
      await addChartSlidePost(presentationId, 'Projected Performance by Channel', 'column', channelLabels, [clicksSeries, convSeries], opts.folderId);
    }
  }

  // Charts from opts.charts (explicit chart data passed by the agent)
  if (opts.charts && opts.charts.length > 0) {
    for (const chart of opts.charts) {
      if (chart.labels && chart.series) {
        await addChartSlidePost(presentationId, chart.title || 'Chart', chart.chartType || 'bar', chart.labels, chart.series, opts.folderId);
      }
    }
  }

  log.info(`Media plan deck built for ${opts.clientName}`, { presentationId });
  return presentation;
}

// ============================================================
// Competitor Research Presentation
// ============================================================

/**
 * Build a competitor research presentation deck.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {Array} opts.competitors - Array of competitor data objects
 * @param {object} opts.keywordGap - Keyword gap analysis data
 * @param {Array} opts.competitorAds - Competitor ad examples
 * @param {object} opts.serpAnalysis - SERP analysis data
 * @param {object} opts.domainOverview - Domain overview data
 * @param {string} opts.summary - AI-generated summary
 * @param {string} opts.folderId
 */
export async function buildCompetitorDeck(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${opts.clientName} — Competitor Research — ${date}`;

  const presentation = await googleSlides.createPresentation(title, opts.folderId);
  if (!presentation) return null;

  const { presentationId } = presentation;
  const defaultSlideId = await googleSlides.getDefaultSlideId(presentationId);
  const requests = [];
  let idx = 0;

  // Title
  idx = addTitleSlide(requests, idx, opts.clientName, 'Competitor Intelligence Report', `${date} • Competitive Landscape Analysis`);

  // Summary
  if (opts.summary) {
    idx = addContentSlide(requests, idx, 'Executive Summary', opts.summary);
  }

  // Domain Overview
  if (opts.domainOverview) {
    const dov = opts.domainOverview;
    const metrics = [];
    if (dov.organicTraffic) metrics.push({ label: 'Organic Traffic', value: String(dov.organicTraffic) });
    if (dov.paidTraffic) metrics.push({ label: 'Paid Traffic', value: String(dov.paidTraffic) });
    if (dov.organicKeywords) metrics.push({ label: 'Organic Keywords', value: String(dov.organicKeywords) });
    if (dov.backlinks) metrics.push({ label: 'Backlinks', value: String(dov.backlinks) });
    if (metrics.length > 0) {
      idx = addMetricsSlide(requests, idx, `${opts.clientName} — Domain Overview`, metrics);
    }
  }

  // Competitors
  if (opts.competitors && opts.competitors.length > 0) {
    idx = addSectionDivider(requests, idx, 'Competitor Landscape', `${opts.competitors.length} competitors identified`);

    const headers = ['Competitor', 'Domain', 'Est. Traffic', 'Keywords', 'Relevance'];
    const rows = opts.competitors.map(c => [
      c.name || c.domain || '',
      c.domain || '',
      String(c.estimatedTraffic || c.traffic || '—'),
      String(c.keywords || '—'),
      c.relevance ? `${(c.relevance * 100).toFixed(0)}%` : '—',
    ]);
    idx = addTableSlide(requests, idx, 'Top Competitors', headers, rows);

    // Individual competitor details
    for (const comp of opts.competitors.slice(0, 8)) {
      const body = [
        comp.domain ? `Domain: ${comp.domain}` : '',
        comp.traffic ? `Est. Monthly Traffic: ${comp.traffic}` : '',
        comp.keywords ? `Ranking Keywords: ${comp.keywords}` : '',
        comp.avgPosition ? `Avg. Position: ${comp.avgPosition}` : '',
        comp.commonKeywords ? `Common Keywords: ${comp.commonKeywords}` : '',
        comp.strengths ? `\nStrengths: ${comp.strengths}` : '',
        comp.weaknesses ? `Weaknesses: ${comp.weaknesses}` : '',
      ].filter(Boolean).join('\n');
      idx = addContentSlide(requests, idx, comp.name || comp.domain || 'Competitor', body);
    }
  }

  // Keyword Gap
  if (opts.keywordGap && opts.keywordGap.length > 0) {
    idx = addSectionDivider(requests, idx, 'Keyword Gap Analysis', `${opts.keywordGap.length} opportunity keywords`);
    const headers = ['Keyword', 'Volume', 'Competition', 'Their Rank', 'Your Rank'];
    const rows = opts.keywordGap.slice(0, 30).map(k => [
      k.keyword || '',
      String(k.volume || k.searchVolume || '—'),
      k.competition || '—',
      String(k.competitorPosition || '—'),
      k.yourPosition ? String(k.yourPosition) : 'Not ranking',
    ]);
    idx = addTableSlide(requests, idx, 'Keyword Opportunities', headers, rows);
  }

  // SERP Analysis
  if (opts.serpAnalysis) {
    const serp = opts.serpAnalysis;
    const body = [
      serp.keyword ? `Keyword: "${serp.keyword}"` : '',
      '',
      serp.organicResults ? `TOP ORGANIC RESULTS:\n${serp.organicResults.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} — ${r.domain}`).join('\n')}` : '',
      '',
      serp.paidResults ? `PAID ADS:\n${serp.paidResults.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} — ${r.domain}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    idx = addContentSlide(requests, idx, 'SERP Landscape', body);
  }

  // Competitor Ads
  if (opts.competitorAds && opts.competitorAds.length > 0) {
    idx = addSectionDivider(requests, idx, 'Competitor Ad Creatives', `${opts.competitorAds.length} ads analyzed`);
    for (const ad of opts.competitorAds.slice(0, 10)) {
      const body = [
        ad.pageName ? `Advertiser: ${ad.pageName}` : '',
        ad.headline ? `Headline: ${ad.headline}` : '',
        ad.body ? `Copy: ${ad.body}` : '',
        ad.cta ? `CTA: ${ad.cta}` : '',
        ad.platforms ? `Platforms: ${ad.platforms}` : '',
        ad.snapshotUrl ? `Preview: ${ad.snapshotUrl}` : '',
      ].filter(Boolean).join('\n');
      idx = addContentSlide(requests, idx, ad.pageName || 'Competitor Ad', body);
    }
  }

  // Recommendations
  if (opts.recommendations) {
    idx = addContentSlide(requests, idx, 'Strategic Recommendations', opts.recommendations);
  }

  if (defaultSlideId) requests.push({ deleteObject: { objectId: defaultSlideId } });

  await googleSlides.batchUpdate(presentationId, requests);

  // --- Post-build: Add chart slides ---

  // Competitor traffic comparison bar chart
  if (opts.competitors && opts.competitors.length > 1) {
    const labels = opts.competitors.slice(0, 10).map(c => c.name || c.domain || '?');
    const trafficValues = opts.competitors.slice(0, 10).map(c => parseInt(c.traffic || c.estimatedTraffic || 0));
    if (trafficValues.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Competitor Traffic Comparison', 'bar', labels, [{ name: 'Est. Monthly Traffic', values: trafficValues }], opts.folderId);
    }

    const kwValues = opts.competitors.slice(0, 10).map(c => parseInt(c.keywords || 0));
    if (kwValues.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Competitor Keywords Count', 'bar', labels, [{ name: 'Ranking Keywords', values: kwValues }], opts.folderId);
    }
  }

  // Explicit charts
  if (opts.charts && opts.charts.length > 0) {
    for (const chart of opts.charts) {
      if (chart.labels && chart.series) {
        await addChartSlidePost(presentationId, chart.title || 'Chart', chart.chartType || 'bar', chart.labels, chart.series, opts.folderId);
      }
    }
  }

  log.info(`Competitor deck built for ${opts.clientName}`, { presentationId });
  return presentation;
}

// ============================================================
// Performance Report Presentation
// ============================================================

/**
 * Build a performance report presentation deck.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.reportType - 'weekly' | 'monthly'
 * @param {object} opts.metrics - Core performance metrics
 * @param {object} opts.analytics - Google Analytics data
 * @param {Array} opts.campaigns - Campaign-level data
 * @param {Array} opts.topKeywords - Top performing keywords
 * @param {object} opts.audienceData - Audience/demographic data
 * @param {string} opts.analysis - AI analysis / insights
 * @param {string} opts.recommendations - AI recommendations
 * @param {string} opts.folderId
 */
export async function buildPerformanceDeck(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const period = opts.reportType === 'monthly' ? 'Monthly' : 'Weekly';
  const title = `${opts.clientName} — ${period} Performance Report — ${date}`;

  const presentation = await googleSlides.createPresentation(title, opts.folderId);
  if (!presentation) return null;

  const { presentationId } = presentation;
  const defaultSlideId = await googleSlides.getDefaultSlideId(presentationId);
  const requests = [];
  let idx = 0;

  // Title
  idx = addTitleSlide(requests, idx, opts.clientName, `${period} Performance Report`, `${date} • ${opts.dateRange || 'Last 7 days'}`);

  // Core Metrics
  if (opts.metrics) {
    const m = opts.metrics;
    const metricsCards = [];
    if (m.spend != null) metricsCards.push({ label: 'Total Spend', value: `$${m.spend}` });
    if (m.impressions != null) metricsCards.push({ label: 'Impressions', value: String(m.impressions) });
    if (m.clicks != null) metricsCards.push({ label: 'Clicks', value: String(m.clicks) });
    if (m.conversions != null) metricsCards.push({ label: 'Conversions', value: String(m.conversions) });
    if (m.ctr != null) metricsCards.push({ label: 'CTR', value: `${m.ctr}%` });
    if (m.cpa != null) metricsCards.push({ label: 'CPA', value: `$${m.cpa}` });
    if (m.roas != null) metricsCards.push({ label: 'ROAS', value: `${m.roas}x` });
    if (m.cpc != null) metricsCards.push({ label: 'Avg CPC', value: `$${m.cpc}` });
    if (metricsCards.length > 0) {
      idx = addMetricsSlide(requests, idx, 'Key Performance Metrics', metricsCards);
    }
  }

  // Analysis
  if (opts.analysis) {
    idx = addContentSlide(requests, idx, 'Performance Analysis', opts.analysis);
  }

  // Campaign Breakdown
  if (opts.campaigns && opts.campaigns.length > 0) {
    idx = addSectionDivider(requests, idx, 'Campaign Performance', `${opts.campaigns.length} active campaigns`);
    const headers = ['Campaign', 'Spend', 'Clicks', 'Conv.', 'CPA', 'ROAS'];
    const rows = opts.campaigns.map(c => [
      c.name || '',
      c.spend ? `$${c.spend}` : '—',
      String(c.clicks || '—'),
      String(c.conversions || '—'),
      c.cpa ? `$${c.cpa}` : '—',
      c.roas ? `${c.roas}x` : '—',
    ]);
    idx = addTableSlide(requests, idx, 'Campaign Breakdown', headers, rows);
  }

  // Website Analytics
  if (opts.analytics) {
    const a = opts.analytics;
    const analyticsMetrics = [];
    if (a.sessions != null) analyticsMetrics.push({ label: 'Sessions', value: String(a.sessions) });
    if (a.totalUsers != null) analyticsMetrics.push({ label: 'Users', value: String(a.totalUsers) });
    if (a.pageViews != null) analyticsMetrics.push({ label: 'Page Views', value: String(a.pageViews) });
    if (a.bounceRate != null) analyticsMetrics.push({ label: 'Bounce Rate', value: `${a.bounceRate}%` });
    if (a.engagementRate != null) analyticsMetrics.push({ label: 'Engagement', value: `${a.engagementRate}%` });
    if (a.conversions != null) analyticsMetrics.push({ label: 'GA Conversions', value: String(a.conversions) });
    if (analyticsMetrics.length > 0) {
      idx = addMetricsSlide(requests, idx, 'Website Analytics', analyticsMetrics);
    }

    // Traffic sources
    if (a.trafficSources && a.trafficSources.length > 0) {
      const headers = ['Channel', 'Sessions', 'Users', 'Conversions', 'Engagement'];
      const rows = a.trafficSources.map(s => [
        s.channel || '',
        String(s.sessions || '—'),
        String(s.users || '—'),
        String(s.conversions || '—'),
        s.engagementRate ? `${s.engagementRate}%` : '—',
      ]);
      idx = addTableSlide(requests, idx, 'Traffic Sources', headers, rows);
    }

    // Top pages
    if (a.topPages && a.topPages.length > 0) {
      const headers = ['Page', 'Views', 'Avg Duration', 'Bounce Rate', 'Conversions'];
      const rows = a.topPages.slice(0, 15).map(p => [
        (p.path || '').slice(0, 40),
        String(p.pageViews || '—'),
        p.avgDuration ? `${p.avgDuration}s` : '—',
        p.bounceRate ? `${p.bounceRate}%` : '—',
        String(p.conversions || '—'),
      ]);
      idx = addTableSlide(requests, idx, 'Top Pages', headers, rows);
    }
  }

  // Top Keywords
  if (opts.topKeywords && opts.topKeywords.length > 0) {
    const headers = ['Keyword', 'Impressions', 'Clicks', 'CTR', 'Conv.', 'CPA'];
    const rows = opts.topKeywords.slice(0, 20).map(k => [
      k.keyword || '',
      String(k.impressions || '—'),
      String(k.clicks || '—'),
      k.ctr ? `${k.ctr}%` : '—',
      String(k.conversions || '—'),
      k.cpa ? `$${k.cpa}` : '—',
    ]);
    idx = addTableSlide(requests, idx, 'Top Keywords', headers, rows);
  }

  // Audience
  if (opts.audienceData) {
    const aud = opts.audienceData;
    const parts = [];
    if (aud.devices) parts.push(`DEVICES:\n${aud.devices.map(d => `• ${d.device}: ${d.sessions} sessions (${d.users} users)`).join('\n')}`);
    if (aud.countries) parts.push(`\nTOP COUNTRIES:\n${aud.countries.slice(0, 5).map(c => `• ${c.country}: ${c.sessions} sessions`).join('\n')}`);
    if (aud.gender) parts.push(`\nGENDER:\n${aud.gender.map(g => `• ${g.gender}: ${g.sessions} sessions`).join('\n')}`);
    if (parts.length > 0) {
      idx = addContentSlide(requests, idx, 'Audience Insights', parts.join('\n'));
    }
  }

  // Recommendations
  if (opts.recommendations) {
    idx = addContentSlide(requests, idx, 'Recommendations & Next Steps', opts.recommendations);
  }

  if (defaultSlideId) requests.push({ deleteObject: { objectId: defaultSlideId } });

  await googleSlides.batchUpdate(presentationId, requests);

  // --- Post-build: Add chart slides ---

  // Campaign spend pie chart
  if (opts.campaigns && opts.campaigns.length > 1) {
    const labels = opts.campaigns.map(c => c.name || 'Campaign');
    const spendValues = opts.campaigns.map(c => parseFloat(String(c.spend || '0').replace(/[^0-9.]/g, '')) || 0);
    if (spendValues.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Spend by Campaign', 'pie', labels, [{ name: 'Spend', values: spendValues }], opts.folderId);
    }
  }

  // Traffic sources pie chart
  if (opts.analytics?.trafficSources && opts.analytics.trafficSources.length > 1) {
    const labels = opts.analytics.trafficSources.map(s => s.channel || 'Other');
    const sessValues = opts.analytics.trafficSources.map(s => parseInt(s.sessions || 0));
    if (sessValues.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Sessions by Traffic Source', 'pie', labels, [{ name: 'Sessions', values: sessValues }], opts.folderId);
    }
  }

  // Daily trend line chart
  if (opts.dailyTrend && opts.dailyTrend.length > 1) {
    const labels = opts.dailyTrend.map(d => d.date || '');
    const sessionsSeries = { name: 'Sessions', values: opts.dailyTrend.map(d => d.sessions || 0) };
    const convSeries = { name: 'Conversions', values: opts.dailyTrend.map(d => d.conversions || 0) };
    await addChartSlidePost(presentationId, 'Daily Performance Trend', 'line', labels, [sessionsSeries, convSeries], opts.folderId);
  }

  // Audience devices pie chart
  if (opts.audienceData?.devices && opts.audienceData.devices.length > 1) {
    const labels = opts.audienceData.devices.map(d => d.device || 'Other');
    const values = opts.audienceData.devices.map(d => parseInt(d.sessions || 0));
    if (values.some(v => v > 0)) {
      await addChartSlidePost(presentationId, 'Sessions by Device', 'pie', labels, [{ name: 'Sessions', values }], opts.folderId);
    }
  }

  // Explicit charts
  if (opts.charts && opts.charts.length > 0) {
    for (const chart of opts.charts) {
      if (chart.labels && chart.series) {
        await addChartSlidePost(presentationId, chart.title || 'Chart', chart.chartType || 'bar', chart.labels, chart.series, opts.folderId);
      }
    }
  }

  log.info(`Performance deck built for ${opts.clientName}`, { presentationId });
  return presentation;
}

export default {
  buildMediaPlanDeck,
  buildCompetitorDeck,
  buildPerformanceDeck,
};
