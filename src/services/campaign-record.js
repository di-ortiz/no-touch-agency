import * as googleSheets from '../api/google-sheets.js';
import logger from '../utils/logger.js';

const log = logger.child({ service: 'campaign-record' });

// Agency brand header color (navy)
const HEADER_BG = { red: 0.1, green: 0.15, blue: 0.35 };
const HEADER_FG = { red: 1, green: 1, blue: 1 };

/**
 * Standard header formatting requests for a sheet tab.
 */
function headerFormat(sheetId, columnCount) {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: {
          userEnteredFormat: {
            backgroundColor: HEADER_BG,
            textFormat: { bold: true, foregroundColor: HEADER_FG, fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount },
      },
    },
  ];
}

/**
 * Build a multi-tab spreadsheet from an array of tab definitions.
 * @param {string} spreadsheetId
 * @param {Array<{name: string, headers: string[], rows: string[][]}>} tabs
 */
async function buildMultiTabSheet(spreadsheetId, tabs) {
  if (!tabs.length) return;

  // Rename default Sheet1 → first tab; add remaining tabs
  const structureRequests = [
    {
      updateSheetProperties: {
        properties: { sheetId: 0, title: tabs[0].name },
        fields: 'title',
      },
    },
  ];

  for (let i = 1; i < tabs.length; i++) {
    structureRequests.push({
      addSheet: {
        properties: { sheetId: i, title: tabs[i].name },
      },
    });
  }

  await googleSheets.formatSheet(spreadsheetId, structureRequests);

  // Write data + apply header formatting per tab
  const formatRequests = [];

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const values = [tab.headers, ...(tab.rows || [])];
    await googleSheets.writeData(spreadsheetId, `'${tab.name}'!A1`, values);
    formatRequests.push(...headerFormat(i, tab.headers.length));
  }

  if (formatRequests.length) {
    await googleSheets.formatSheet(spreadsheetId, formatRequests);
  }
}

// ============================================================
// Creative Package Record
// ============================================================

/**
 * Create a companion Sheet for a full creative package.
 *
 * Tabs: Campaign Info | Ad Copy | Visuals | Videos (if any)
 */
export async function createCreativeRecord({ clientName, platform, campaignName, textAds, images, videos, summary, presentationUrl, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — ${campaignName || 'Creative Package'} — ${date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const tabs = [
    {
      name: 'Campaign Info',
      headers: ['Field', 'Value'],
      rows: [
        ['Client', clientName],
        ['Campaign', campaignName || ''],
        ['Platform', (platform || '').toUpperCase()],
        ['Date', date],
        ['Text Variations', String(textAds?.length || 0)],
        ['Images Generated', String(images?.filter(i => !i.error).length || 0)],
        ['Videos Generated', String(videos?.filter(v => !v.error).length || 0)],
        ['Presentation', presentationUrl || 'N/A'],
        ['Status', 'Awaiting Approval'],
        ['Summary', summary || ''],
      ],
    },
    {
      name: 'Ad Copy',
      headers: ['#', 'Headline', 'Description', 'Body / Primary Text', 'CTA', 'Angle', 'Headline Chars', 'Body Chars'],
      rows: (textAds || []).map((ad, i) => [
        String(i + 1),
        ad.headline || '',
        ad.description || '',
        ad.body || '',
        ad.cta || '',
        ad.angle || '',
        String(ad.headline?.length || 0),
        String(ad.body?.length || 0),
      ]),
    },
    {
      name: 'Visuals',
      headers: ['#', 'Format', 'Label', 'Dimensions', 'URL', 'Status'],
      rows: (images || []).map((img, i) => [
        String(i + 1),
        img.format || '',
        img.label || '',
        img.dimensions ? `${img.dimensions.width}x${img.dimensions.height}` : '',
        img.url || '',
        img.error ? `Error: ${img.error}` : 'Generated',
      ]),
    },
  ];

  if (videos && videos.length > 0) {
    tabs.push({
      name: 'Videos',
      headers: ['#', 'Concept', 'Duration', 'Resolution', 'Aspect Ratio', 'URL', 'Status'],
      rows: videos.map((v, i) => [
        String(i + 1),
        v.concept || '',
        v.duration ? `${v.duration}s` : '',
        v.resolution || '',
        v.aspectRatio || '',
        v.videoUrl || v.url || '',
        v.error ? `Error: ${v.error}` : 'Generated',
      ]),
    });
  }

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created creative record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

// ============================================================
// Media Plan Record
// ============================================================

/**
 * Create a companion Sheet for a media plan.
 *
 * Tabs: Overview | Target Audiences | Channel Strategy | Budget Allocation | Projections
 */
export async function createMediaPlanRecord({ clientName, campaignName, mediaPlan, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — Media Plan Data — ${campaignName || date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const mp = mediaPlan || {};

  const tabs = [
    {
      name: 'Overview',
      headers: ['Field', 'Value'],
      rows: [
        ['Client', clientName],
        ['Campaign', campaignName || ''],
        ['Date', date],
        ['Objective', mp.objective || ''],
        ['Budget', mp.budget || ''],
        ['Timeline', typeof mp.timeline === 'string' ? mp.timeline : JSON.stringify(mp.timeline || '')],
        ['Summary', mp.summary || ''],
        ['KPIs', (mp.kpis || []).join(', ')],
        ['Next Steps', mp.nextSteps || ''],
      ],
    },
    {
      name: 'Target Audiences',
      headers: ['Audience', 'Demographics', 'Interests', 'Behaviors', 'Est. Size'],
      rows: (mp.audiences || []).map(a => [
        a.name || '',
        a.demographics || '',
        a.interests || '',
        a.behaviors || '',
        a.size || '',
      ]),
    },
    {
      name: 'Channel Strategy',
      headers: ['Platform', 'Budget', 'Objective', 'Ad Formats', 'Targeting', 'Schedule', 'Proj. Clicks', 'Proj. Conversions', 'Notes'],
      rows: (mp.channels || []).map(c => [
        c.platform || '',
        c.budget || '',
        c.objective || '',
        c.adFormats || '',
        c.targeting || '',
        c.schedule || '',
        String(c.projectedClicks || ''),
        String(c.projectedConversions || ''),
        c.notes || '',
      ]),
    },
    {
      name: 'Budget Allocation',
      headers: ['Channel', 'Amount', 'Percentage', 'Objective'],
      rows: (mp.budgetBreakdown || []).map(b => [
        b.channel || '',
        b.amount || '',
        b.percentage || '',
        b.objective || '',
      ]),
    },
    {
      name: 'Projections',
      headers: ['Metric', 'Value'],
      rows: mp.projections ? [
        ['Impressions', String(mp.projections.impressions || '')],
        ['Clicks', String(mp.projections.clicks || '')],
        ['Conversions', String(mp.projections.conversions || '')],
        ['CPA', String(mp.projections.cpa || '')],
        ['ROAS', String(mp.projections.roas || '')],
        ['Reach', String(mp.projections.reach || '')],
        ['Notes', mp.projections.notes || ''],
      ] : [],
    },
  ];

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created media plan record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

// ============================================================
// Competitor Analysis Record
// ============================================================

/**
 * Create a companion Sheet for competitor research.
 *
 * Tabs: Overview | Competitors | Keyword Gap | Competitor Ads
 */
export async function createCompetitorRecord({ clientName, competitors, keywordGap, competitorAds, domainOverview, summary, recommendations, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — Competitor Analysis Data — ${date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const tabs = [
    {
      name: 'Overview',
      headers: ['Field', 'Value'],
      rows: [
        ['Client', clientName],
        ['Date', date],
        ['Organic Traffic', String(domainOverview?.organicTraffic || '')],
        ['Paid Traffic', String(domainOverview?.paidTraffic || '')],
        ['Organic Keywords', String(domainOverview?.organicKeywords || '')],
        ['Backlinks', String(domainOverview?.backlinks || '')],
        ['Summary', summary || ''],
        ['Recommendations', recommendations || ''],
      ],
    },
    {
      name: 'Competitors',
      headers: ['Name', 'Domain', 'Traffic', 'Keywords', 'Avg Position', 'Common Keywords', 'Strengths', 'Weaknesses'],
      rows: (competitors || []).map(c => [
        c.name || '',
        c.domain || '',
        String(c.traffic || ''),
        String(c.keywords || ''),
        String(c.avgPosition || ''),
        String(c.commonKeywords || ''),
        c.strengths || '',
        c.weaknesses || '',
      ]),
    },
    {
      name: 'Keyword Gap',
      headers: ['Keyword', 'Volume', 'Competition', 'Competitor Position', 'Your Position', 'Opportunity'],
      rows: (keywordGap || []).map(k => [
        k.keyword || '',
        String(k.volume || ''),
        k.competition || '',
        String(k.competitorPosition || ''),
        String(k.yourPosition || 'Not ranking'),
        k.yourPosition ? '' : 'GAP',
      ]),
    },
    {
      name: 'Competitor Ads',
      headers: ['Page / Brand', 'Headline', 'Body', 'CTA', 'Platforms'],
      rows: (competitorAds || []).map(a => [
        a.pageName || '',
        a.headline || '',
        a.body || '',
        a.cta || '',
        Array.isArray(a.platforms) ? a.platforms.join(', ') : (a.platforms || ''),
      ]),
    },
  ];

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created competitor record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

// ============================================================
// Performance Report Record
// ============================================================

/**
 * Create a companion Sheet for performance reports.
 *
 * Tabs: KPIs | Campaigns | Keywords | Traffic Sources | Top Pages | Audience (if available)
 */
export async function createPerformanceRecord({ clientName, reportType, dateRange, metrics, analytics, campaigns, topKeywords, audienceData, analysis, recommendations, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — ${reportType || 'Performance'} Report Data — ${dateRange || date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const m = metrics || {};
  const a = analytics || {};

  const tabs = [
    {
      name: 'KPIs',
      headers: ['Metric', 'Value'],
      rows: [
        ['Report Type', reportType || ''],
        ['Date Range', dateRange || ''],
        ['Spend', String(m.spend || '')],
        ['Impressions', String(m.impressions || '')],
        ['Clicks', String(m.clicks || '')],
        ['Conversions', String(m.conversions || '')],
        ['CTR', String(m.ctr || '')],
        ['CPA', String(m.cpa || '')],
        ['ROAS', String(m.roas || '')],
        ['CPC', String(m.cpc || '')],
        ['', ''],
        ['GA4 Sessions', String(a.sessions || '')],
        ['Total Users', String(a.totalUsers || '')],
        ['Page Views', String(a.pageViews || '')],
        ['Bounce Rate', String(a.bounceRate || '')],
        ['Engagement Rate', String(a.engagementRate || '')],
        ['', ''],
        ['Analysis', analysis || ''],
        ['Recommendations', recommendations || ''],
      ],
    },
    {
      name: 'Campaigns',
      headers: ['Campaign', 'Spend', 'Clicks', 'Conversions', 'CPA', 'ROAS'],
      rows: (campaigns || []).map(c => [
        c.name || '',
        String(c.spend || ''),
        String(c.clicks || ''),
        String(c.conversions || ''),
        String(c.cpa || ''),
        String(c.roas || ''),
      ]),
    },
    {
      name: 'Keywords',
      headers: ['Keyword', 'Impressions', 'Clicks', 'CTR', 'Conversions', 'CPA'],
      rows: (topKeywords || []).map(k => [
        k.keyword || '',
        String(k.impressions || ''),
        String(k.clicks || ''),
        String(k.ctr || ''),
        String(k.conversions || ''),
        String(k.cpa || ''),
      ]),
    },
    {
      name: 'Traffic Sources',
      headers: ['Channel', 'Sessions', 'Users', 'Conversions', 'Engagement Rate'],
      rows: (a.trafficSources || []).map(t => [
        t.channel || '',
        String(t.sessions || ''),
        String(t.users || ''),
        String(t.conversions || ''),
        String(t.engagementRate || ''),
      ]),
    },
    {
      name: 'Top Pages',
      headers: ['Page', 'Page Views', 'Avg Duration', 'Bounce Rate', 'Conversions'],
      rows: (a.topPages || []).map(p => [
        p.path || '',
        String(p.pageViews || ''),
        String(p.avgDuration || ''),
        String(p.bounceRate || ''),
        String(p.conversions || ''),
      ]),
    },
  ];

  if (audienceData) {
    const audienceRows = [];
    if (audienceData.devices) {
      audienceRows.push(['--- Devices ---', '', '']);
      audienceData.devices.forEach(d => audienceRows.push([d.device || '', String(d.sessions || ''), String(d.users || '')]));
    }
    if (audienceData.countries) {
      audienceRows.push(['--- Countries ---', '', '']);
      audienceData.countries.forEach(c => audienceRows.push([c.country || '', String(c.sessions || ''), '']));
    }
    if (audienceData.gender) {
      audienceRows.push(['--- Gender ---', '', '']);
      audienceData.gender.forEach(g => audienceRows.push([g.gender || '', String(g.sessions || ''), '']));
    }
    tabs.push({
      name: 'Audience',
      headers: ['Segment', 'Sessions', 'Users'],
      rows: audienceRows,
    });
  }

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created performance record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

// ============================================================
// Standalone Text Ads Record
// ============================================================

/**
 * Create a Sheet when generate_text_ads is called standalone (not as part of a full package).
 *
 * Tab: Ad Copy
 */
export async function createTextAdsRecord({ clientName, platform, ads, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — Ad Copy — ${(platform || '').toUpperCase()} — ${date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const tabs = [
    {
      name: 'Ad Copy',
      headers: ['#', 'Headline', 'Description', 'Body / Primary Text', 'CTA', 'Angle', 'Headline Chars', 'Body Chars'],
      rows: (ads || []).map((ad, i) => [
        String(i + 1),
        ad.headline || '',
        ad.description || '',
        ad.body || '',
        ad.cta || '',
        ad.angle || '',
        String(ad.headline?.length || 0),
        String(ad.body?.length || 0),
      ]),
    },
  ];

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created text ads record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

// ============================================================
// Standalone Ad Images Record
// ============================================================

/**
 * Create a Sheet when generate_ad_images is called standalone.
 *
 * Tabs: Creative Brief | Generated Visuals
 */
export async function createAdImagesRecord({ clientName, platform, concept, imagePrompt, images, folderId }) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${clientName} — Ad Visuals — ${(platform || '').toUpperCase()} — ${date}`;

  const spreadsheet = await googleSheets.createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  const tabs = [
    {
      name: 'Creative Brief',
      headers: ['Field', 'Value'],
      rows: [
        ['Client', clientName],
        ['Platform', (platform || '').toUpperCase()],
        ['Date', date],
        ['Concept', concept || ''],
        ['Image Prompt', imagePrompt || ''],
      ],
    },
    {
      name: 'Generated Visuals',
      headers: ['#', 'Format', 'Label', 'URL', 'Status'],
      rows: (images || []).map((img, i) => [
        String(i + 1),
        img.format || '',
        img.label || '',
        img.url || '',
        img.error ? `Error: ${img.error}` : 'Generated',
      ]),
    },
  ];

  await buildMultiTabSheet(spreadsheet.spreadsheetId, tabs);

  log.info(`Created ad images record for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

export default {
  createCreativeRecord,
  createMediaPlanRecord,
  createCompetitorRecord,
  createPerformanceRecord,
  createTextAdsRecord,
  createAdImagesRecord,
};
