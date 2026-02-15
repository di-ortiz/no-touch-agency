import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';
import fs from 'fs';

const log = logger.child({ platform: 'google-sheets' });

let auth;
let sheetsClient;
let driveClient;

function getAuth() {
  if (!auth) {
    if (config.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(config.GOOGLE_APPLICATION_CREDENTIALS)) {
      auth = new google.auth.GoogleAuth({
        keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    } else {
      log.warn('Google credentials not configured; Sheets operations will fail');
      return null;
    }
  }
  return auth;
}

function getSheets() {
  if (!sheetsClient) {
    const a = getAuth();
    if (!a) return null;
    sheetsClient = google.sheets({ version: 'v4', auth: a });
  }
  return sheetsClient;
}

function getDrive() {
  if (!driveClient) {
    const a = getAuth();
    if (!a) return null;
    driveClient = google.drive({ version: 'v3', auth: a });
  }
  return driveClient;
}

// --- Create Spreadsheet ---

export async function createSpreadsheet(title, folderId) {
  const sheets = getSheets();
  const drive = getDrive();
  if (!sheets || !drive) return null;

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
        },
      });

      const spreadsheetId = res.data.spreadsheetId;
      const url = res.data.spreadsheetUrl;

      // Move to folder if specified
      if (folderId) {
        const file = await drive.files.get({
          fileId: spreadsheetId,
          fields: 'parents',
        });
        const previousParents = file.data.parents?.join(',') || '';
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: folderId,
          removeParents: previousParents,
          fields: 'id, parents',
        });
      }

      log.info(`Created spreadsheet: ${title}`, { spreadsheetId });
      return { spreadsheetId, url };
    }, { retries: 3, label: 'Google Sheets create' })
  );
}

// --- Write Data ---

export async function writeData(spreadsheetId, range, values) {
  const sheets = getSheets();
  if (!sheets) return null;

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
      return res.data;
    }, { retries: 3, label: 'Google Sheets write' })
  );
}

// --- Read Data ---

export async function readData(spreadsheetId, range) {
  const sheets = getSheets();
  if (!sheets) return null;

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      return res.data.values || [];
    }, { retries: 3, label: 'Google Sheets read' })
  );
}

// --- Format Cells ---

export async function formatSheet(spreadsheetId, requests) {
  const sheets = getSheets();
  if (!sheets) return null;

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
      return res.data;
    }, { retries: 3, label: 'Google Sheets format' })
  );
}

// --- Content Calendar ---

/**
 * Create a content/post calendar spreadsheet for a client.
 *
 * @param {object} opts
 * @param {string} opts.clientName - Client name
 * @param {string} opts.month - Month string (e.g. "2026-03")
 * @param {Array} opts.posts - Array of post objects {date, platform, type, copy, creative, status, notes}
 * @param {string} opts.folderId - Google Drive folder to place the sheet in
 * @returns {object} { spreadsheetId, url }
 */
export async function createContentCalendar({ clientName, month, posts, folderId }) {
  const title = `${clientName} — Content Calendar — ${month}`;

  const spreadsheet = await createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  // Header row
  const headers = ['Date', 'Platform', 'Content Type', 'Copy / Caption', 'Creative Brief', 'CTA', 'Hashtags', 'Status', 'Notes'];

  // Data rows
  const rows = (posts || []).map(p => [
    p.date || '',
    p.platform || '',
    p.type || '',
    p.copy || '',
    p.creative || '',
    p.cta || '',
    p.hashtags || '',
    p.status || 'Draft',
    p.notes || '',
  ]);

  const values = [headers, ...rows];

  await writeData(spreadsheet.spreadsheetId, 'Sheet1!A1', values);

  // Apply header formatting (bold + background color)
  await formatSheet(spreadsheet.spreadsheetId, [
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.2, green: 0.3, blue: 0.6 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 9 },
      },
    },
  ]);

  log.info(`Created content calendar for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

/**
 * Create a report spreadsheet with performance data.
 */
export async function createReportSheet({ clientName, reportType, data, folderId }) {
  const title = `${clientName} — ${reportType} Report — ${new Date().toISOString().split('T')[0]}`;

  const spreadsheet = await createSpreadsheet(title, folderId);
  if (!spreadsheet) return null;

  // data should be an array of arrays (rows), first row being headers
  if (data && data.length > 0) {
    await writeData(spreadsheet.spreadsheetId, 'Sheet1!A1', data);

    await formatSheet(spreadsheet.spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ]);
  }

  log.info(`Created report sheet for ${clientName}`, { spreadsheetId: spreadsheet.spreadsheetId });
  return spreadsheet;
}

export default {
  createSpreadsheet, writeData, readData, formatSheet,
  createContentCalendar, createReportSheet,
};
