import * as googleSheets from '../api/google-sheets.js';
import * as googleSlides from '../api/google-slides.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'chart-builder' });

/**
 * Chart types supported by Google Sheets API.
 */
const CHART_TYPES = {
  bar: 'BAR',
  column: 'COLUMN',
  line: 'LINE',
  area: 'AREA',
  pie: 'PIE',
  combo: 'COMBO',
  scatter: 'SCATTER',
  stacked_bar: 'BAR',
  stacked_column: 'COLUMN',
};

// Agency brand colors for charts
const CHART_COLORS = [
  { red: 0.24, green: 0.47, blue: 0.96 },  // Bright blue
  { red: 0.0,  green: 0.82, blue: 0.67 },  // Teal
  { red: 0.96, green: 0.42, blue: 0.26 },  // Coral/orange
  { red: 0.56, green: 0.27, blue: 0.93 },  // Purple
  { red: 0.98, green: 0.74, blue: 0.18 },  // Gold
  { red: 0.9,  green: 0.2,  blue: 0.2  },  // Red
  { red: 0.13, green: 0.72, blue: 0.35 },  // Green
  { red: 0.4,  green: 0.4,  blue: 0.4  },  // Gray
];

/**
 * Create a Google Sheets spreadsheet with data and an embedded chart.
 * Returns the spreadsheet ID and chart ID for embedding into Slides.
 *
 * @param {object} opts
 * @param {string} opts.title - Chart title
 * @param {string} opts.chartType - 'pie' | 'bar' | 'column' | 'line' | 'area' | 'combo' | 'stacked_bar' | 'stacked_column'
 * @param {string[]} opts.labels - Category labels (X-axis / pie slices)
 * @param {Array<{name: string, values: number[]}>} opts.series - Data series
 * @param {string} opts.folderId - Google Drive folder
 * @returns {object} { spreadsheetId, chartId, sheetUrl }
 */
export async function createChart(opts = {}) {
  const {
    title = 'Chart',
    chartType = 'bar',
    labels = [],
    series = [],
    folderId,
  } = opts;

  if (!labels.length || !series.length) {
    throw new Error('Chart requires labels and at least one data series');
  }

  // Step 1: Create spreadsheet with data
  const sheetTitle = `Chart Data — ${title} — ${Date.now()}`;
  const spreadsheet = await googleSheets.createSpreadsheet(sheetTitle, folderId);
  if (!spreadsheet) throw new Error('Failed to create chart spreadsheet');

  const { spreadsheetId } = spreadsheet;

  // Build data: first column = labels, subsequent columns = each series
  const headerRow = ['Category', ...series.map(s => s.name || 'Value')];
  const dataRows = labels.map((label, i) => [
    label,
    ...series.map(s => s.values[i] != null ? s.values[i] : 0),
  ]);

  await googleSheets.writeData(spreadsheetId, 'Sheet1!A1', [headerRow, ...dataRows]);

  // Step 2: Create chart in the spreadsheet
  const numRows = labels.length + 1; // +1 for header
  const numCols = series.length + 1;  // +1 for labels column
  const isStacked = chartType.startsWith('stacked_');

  let chartSpec;
  if (chartType === 'pie') {
    chartSpec = buildPieChartSpec(title, numRows, numCols);
  } else {
    chartSpec = buildBasicChartSpec(title, chartType, numRows, numCols, series, isStacked);
  }

  const addChartReq = {
    addChart: {
      chart: {
        spec: chartSpec,
        position: {
          overlayPosition: {
            anchorCell: { sheetId: 0, rowIndex: numRows + 1, columnIndex: 0 },
            widthPixels: 800,
            heightPixels: 500,
          },
        },
      },
    },
  };

  const result = await googleSheets.formatSheet(spreadsheetId, [addChartReq]);
  if (!result) {
    throw new Error('Failed to create chart — Google Sheets API returned no response. Check service account credentials.');
  }

  // Extract the chart ID from the response
  const chartId = result?.replies?.[0]?.addChart?.chart?.chartId;
  if (!chartId) {
    throw new Error('Chart was created in the spreadsheet but the chart ID could not be extracted. The chart may still be visible in the spreadsheet.');
  }

  log.info(`Chart created: ${title}`, { spreadsheetId, chartId, type: chartType });
  return {
    spreadsheetId,
    chartId,
    sheetUrl: spreadsheet.url,
  };
}

/**
 * Create multiple charts in a single spreadsheet (one sheet per chart).
 * Useful for presentations that need several charts from different data.
 *
 * @param {object} opts
 * @param {string} opts.title - Spreadsheet title
 * @param {Array<{title, chartType, labels, series}>} opts.charts - Array of chart configs
 * @param {string} opts.folderId
 * @returns {object} { spreadsheetId, charts: [{chartId, sheetName}], sheetUrl }
 */
export async function createMultipleCharts(opts = {}) {
  const { title = 'Charts', charts = [], folderId } = opts;
  if (!charts.length) throw new Error('At least one chart config is required');

  const spreadsheet = await googleSheets.createSpreadsheet(`Charts — ${title} — ${Date.now()}`, folderId);
  if (!spreadsheet) throw new Error('Failed to create chart spreadsheet');
  const { spreadsheetId } = spreadsheet;

  const results = [];

  // Create additional sheets for charts beyond the first
  if (charts.length > 1) {
    const addSheetReqs = charts.slice(1).map((c, i) => ({
      addSheet: {
        properties: { title: `Chart${i + 2}`, index: i + 1 },
      },
    }));
    await googleSheets.formatSheet(spreadsheetId, addSheetReqs);
  }

  // Get sheet IDs
  // Sheet1 has sheetId 0; additional sheets get IDs from the addSheet response
  // For simplicity, we'll use sheet names
  for (let ci = 0; ci < charts.length; ci++) {
    const c = charts[ci];
    const sheetName = ci === 0 ? 'Sheet1' : `Chart${ci + 1}`;
    const sheetId = ci === 0 ? 0 : ci; // Approximation — actual IDs from addSheet response

    const headerRow = ['Category', ...(c.series || []).map(s => s.name || 'Value')];
    const dataRows = (c.labels || []).map((label, i) => [
      label,
      ...(c.series || []).map(s => s.values[i] != null ? s.values[i] : 0),
    ]);

    await googleSheets.writeData(spreadsheetId, `${sheetName}!A1`, [headerRow, ...dataRows]);

    const numRows = (c.labels || []).length + 1;
    const numCols = (c.series || []).length + 1;
    const isStacked = (c.chartType || '').startsWith('stacked_');

    let chartSpec;
    if (c.chartType === 'pie') {
      chartSpec = buildPieChartSpec(c.title || `Chart ${ci + 1}`, numRows, numCols, sheetId);
    } else {
      chartSpec = buildBasicChartSpec(c.title || `Chart ${ci + 1}`, c.chartType || 'bar', numRows, numCols, c.series || [], isStacked, sheetId);
    }

    const addChartRes = await googleSheets.formatSheet(spreadsheetId, [{
      addChart: {
        chart: {
          spec: chartSpec,
          position: {
            overlayPosition: {
              anchorCell: { sheetId, rowIndex: numRows + 1, columnIndex: 0 },
              widthPixels: 800,
              heightPixels: 500,
            },
          },
        },
      },
    }]);

    const chartId = addChartRes?.replies?.[0]?.addChart?.chart?.chartId;
    results.push({ chartId, sheetName, title: c.title });
  }

  log.info(`Created ${charts.length} charts`, { spreadsheetId });
  return { spreadsheetId, charts: results, sheetUrl: spreadsheet.url };
}

/**
 * Embed a Sheets chart into a Google Slides presentation.
 * Returns the Slides API requests array to embed the chart.
 *
 * @param {string} slideId - The slide page object ID
 * @param {string} objectId - Unique object ID for the chart element
 * @param {string} spreadsheetId - Source spreadsheet ID
 * @param {number} chartId - Chart ID within the spreadsheet
 * @param {object} position - { x, y, width, height } in PT
 * @returns {object} createSheetsChart request
 */
export function embedChartRequest(slideId, objectId, spreadsheetId, chartId, position = {}) {
  return {
    createSheetsChart: {
      objectId,
      spreadsheetId,
      chartId,
      linkingMode: 'LINKED',
      elementProperties: {
        pageObjectId: slideId,
        size: {
          width: { magnitude: position.width || 550, unit: 'PT' },
          height: { magnitude: position.height || 320, unit: 'PT' },
        },
        transform: {
          scaleX: 1,
          scaleY: 1,
          translateX: position.x || 85,
          translateY: position.y || 55,
          unit: 'PT',
        },
      },
    },
  };
}

/**
 * Full pipeline: create a chart in Sheets and embed it into an existing presentation.
 *
 * @param {object} opts
 * @param {string} opts.presentationId - Existing presentation ID
 * @param {string} opts.slideId - Slide to embed on (will be created if not provided)
 * @param {string} opts.title - Chart title
 * @param {string} opts.chartType - Chart type
 * @param {string[]} opts.labels - Labels
 * @param {Array} opts.series - Data series
 * @param {string} opts.folderId - Drive folder for chart data spreadsheet
 * @param {object} opts.position - {x, y, width, height}
 * @returns {object} { chartId, spreadsheetId, slideId }
 */
export async function addChartToPresentation(opts = {}) {
  const chart = await createChart({
    title: opts.title,
    chartType: opts.chartType,
    labels: opts.labels,
    series: opts.series,
    folderId: opts.folderId,
  });

  const slideRequests = [];
  let slideId = opts.slideId;

  // Create a new slide if none provided
  if (!slideId) {
    slideId = `chart_slide_${Date.now()}`;
    slideRequests.push({
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });

    // Add chart title
    const titleBoxId = `chart_title_${Date.now()}`;
    slideRequests.push({
      createShape: {
        objectId: titleBoxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 35, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 15, unit: 'PT' },
        },
      },
    });
    slideRequests.push({ insertText: { objectId: titleBoxId, text: opts.title || 'Chart' } });
    slideRequests.push({
      updateTextStyle: {
        objectId: titleBoxId,
        style: {
          fontSize: { magnitude: 20, unit: 'PT' },
          fontFamily: 'Inter',
          bold: true,
          foregroundColor: { opaqueColor: { rgbColor: { red: 0.13, green: 0.15, blue: 0.23 } } },
        },
        textRange: { type: 'ALL' },
        fields: 'fontSize,fontFamily,bold,foregroundColor',
      },
    });
  }

  // Embed the chart
  const chartObjId = `chart_embed_${Date.now()}`;
  slideRequests.push(embedChartRequest(slideId, chartObjId, chart.spreadsheetId, chart.chartId, opts.position));

  await googleSlides.batchUpdate(opts.presentationId, slideRequests);

  log.info(`Chart embedded in presentation`, {
    presentationId: opts.presentationId,
    chartId: chart.chartId,
    type: opts.chartType,
  });

  return { chartId: chart.chartId, spreadsheetId: chart.spreadsheetId, slideId };
}

/**
 * Create a standalone chart presentation with multiple charts.
 *
 * @param {object} opts
 * @param {string} opts.clientName - Client name
 * @param {string} opts.title - Presentation title
 * @param {Array<{title, chartType, labels, series}>} opts.charts - Chart configs
 * @param {string} opts.folderId - Drive folder
 * @returns {object} { presentationId, url }
 */
export async function buildChartPresentation(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const presTitle = `${opts.clientName} — ${opts.title || 'Data Charts'} — ${date}`;

  const presentation = await googleSlides.createPresentation(presTitle, opts.folderId);
  const { presentationId } = presentation;
  const defaultSlideId = await googleSlides.getDefaultSlideId(presentationId);

  // Create all charts in Sheets first
  const chartsResult = await createMultipleCharts({
    title: presTitle,
    charts: opts.charts,
    folderId: opts.folderId,
  });

  // Build slides with embedded charts
  const requests = [];
  let slideIndex = 0;

  // Title slide
  const titleSlideId = `title_${Date.now()}`;
  requests.push({
    createSlide: { objectId: titleSlideId, insertionIndex: slideIndex++, slideLayoutReference: { predefinedLayout: 'BLANK' } },
  });
  const titleBoxId = `title_text_${Date.now()}`;
  requests.push({
    createShape: {
      objectId: titleBoxId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: titleSlideId,
        size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 80, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 120, unit: 'PT' },
      },
    },
  });
  requests.push({ insertText: { objectId: titleBoxId, text: opts.clientName } });
  requests.push({
    updateTextStyle: {
      objectId: titleBoxId,
      style: {
        fontSize: { magnitude: 36, unit: 'PT' },
        fontFamily: 'Inter',
        bold: true,
        foregroundColor: { opaqueColor: { rgbColor: { red: 0.13, green: 0.15, blue: 0.23 } } },
      },
      textRange: { type: 'ALL' },
      fields: 'fontSize,fontFamily,bold,foregroundColor',
    },
  });

  const subBoxId = `title_sub_${Date.now()}`;
  requests.push({
    createShape: {
      objectId: subBoxId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: titleSlideId,
        size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 50, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 210, unit: 'PT' },
      },
    },
  });
  requests.push({ insertText: { objectId: subBoxId, text: opts.title || 'Data Analysis' } });
  requests.push({
    updateTextStyle: {
      objectId: subBoxId,
      style: {
        fontSize: { magnitude: 20, unit: 'PT' },
        fontFamily: 'Inter',
        foregroundColor: { opaqueColor: { rgbColor: { red: 0.24, green: 0.47, blue: 0.96 } } },
      },
      textRange: { type: 'ALL' },
      fields: 'fontSize,fontFamily,foregroundColor',
    },
  });

  // Apply title + subtitle first, then we need to add chart slides
  if (defaultSlideId) requests.push({ deleteObject: { objectId: defaultSlideId } });
  await googleSlides.batchUpdate(presentationId, requests);

  // Now add chart slides one by one (each needs its own batch because of embedding)
  for (const chartInfo of chartsResult.charts) {
    if (!chartInfo.chartId) continue;

    await addChartToPresentation({
      presentationId,
      title: chartInfo.title,
      chartType: 'embedded', // already created
      labels: [], // already in sheet
      series: [], // already in sheet
      folderId: opts.folderId,
      // We override by directly adding the embed request
    }).catch(() => {
      // Fallback: manually embed
    });

    // Direct embed approach
    const chartSlideId = `chart_slide_${Date.now()}_${chartInfo.chartId}`;
    const chartReqs = [];
    chartReqs.push({
      createSlide: { objectId: chartSlideId, slideLayoutReference: { predefinedLayout: 'BLANK' } },
    });

    // Chart title text
    const chartTitleId = `ct_${Date.now()}_${chartInfo.chartId}`;
    chartReqs.push({
      createShape: {
        objectId: chartTitleId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: chartSlideId,
          size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 30, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 15, unit: 'PT' },
        },
      },
    });
    chartReqs.push({ insertText: { objectId: chartTitleId, text: chartInfo.title || 'Chart' } });
    chartReqs.push({
      updateTextStyle: {
        objectId: chartTitleId,
        style: {
          fontSize: { magnitude: 20, unit: 'PT' },
          fontFamily: 'Inter',
          bold: true,
          foregroundColor: { opaqueColor: { rgbColor: { red: 0.13, green: 0.15, blue: 0.23 } } },
        },
        textRange: { type: 'ALL' },
        fields: 'fontSize,fontFamily,bold,foregroundColor',
      },
    });

    // Embed chart from sheets
    chartReqs.push(embedChartRequest(chartSlideId, `embed_${Date.now()}_${chartInfo.chartId}`, chartsResult.spreadsheetId, chartInfo.chartId));

    await googleSlides.batchUpdate(presentationId, chartReqs);
  }

  log.info(`Chart presentation built for ${opts.clientName}`, { presentationId, charts: chartsResult.charts.length });
  return presentation;
}

// ============================================================
// Chart Spec Builders
// ============================================================

function buildBasicChartSpec(title, chartType, numRows, numCols, series, isStacked, sheetId = 0) {
  const resolvedType = CHART_TYPES[chartType] || 'BAR';

  const chartSeries = [];
  for (let col = 1; col < numCols; col++) {
    const s = {
      series: {
        sourceRange: {
          sources: [{
            sheetId,
            startRowIndex: 0,
            endRowIndex: numRows,
            startColumnIndex: col,
            endColumnIndex: col + 1,
          }],
        },
      },
      targetAxis: 'LEFT_AXIS',
    };
    if (col - 1 < CHART_COLORS.length) {
      s.color = { rgbColor: CHART_COLORS[col - 1] };
      s.colorStyle = { rgbColor: CHART_COLORS[col - 1] };
    }
    chartSeries.push(s);
  }

  return {
    title,
    titleTextFormat: { fontFamily: 'Inter', fontSize: 14, bold: true },
    basicChart: {
      chartType: resolvedType,
      legendPosition: 'BOTTOM_LEGEND',
      stackedType: isStacked ? 'STACKED' : 'NOT_STACKED',
      headerCount: 1,
      axis: [
        { position: 'BOTTOM_AXIS', title: '' },
        { position: 'LEFT_AXIS', title: '' },
      ],
      domains: [{
        domain: {
          sourceRange: {
            sources: [{
              sheetId,
              startRowIndex: 0,
              endRowIndex: numRows,
              startColumnIndex: 0,
              endColumnIndex: 1,
            }],
          },
        },
      }],
      series: chartSeries,
    },
  };
}

function buildPieChartSpec(title, numRows, numCols, sheetId = 0) {
  return {
    title,
    titleTextFormat: { fontFamily: 'Inter', fontSize: 14, bold: true },
    pieChart: {
      legendPosition: 'RIGHT_LEGEND',
      domain: {
        sourceRange: {
          sources: [{
            sheetId,
            startRowIndex: 0,
            endRowIndex: numRows,
            startColumnIndex: 0,
            endColumnIndex: 1,
          }],
        },
      },
      series: {
        sourceRange: {
          sources: [{
            sheetId,
            startRowIndex: 0,
            endRowIndex: numRows,
            startColumnIndex: 1,
            endColumnIndex: 2,
          }],
        },
      },
    },
  };
}

export default {
  createChart,
  createMultipleCharts,
  embedChartRequest,
  addChartToPresentation,
  buildChartPresentation,
  CHART_TYPES,
};
