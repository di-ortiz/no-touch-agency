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
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    if (fs.existsSync(credPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    } else {
      log.error('Google credentials MISSING', { credPath });
      throw new Error(
        `Google service account credentials not found. ` +
        `Expected credentials at "${credPath}" but the file does NOT exist. ` +
        `To fix: 1) Go to console.cloud.google.com → IAM → Service Accounts, ` +
        `2) Create a service account with Sheets/Drive API access, ` +
        `3) Download the JSON key and save it to ${credPath}`
      );
    }
  }
  return auth;
}

function getSheets() {
  if (!sheetsClient) {
    sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
  }
  return sheetsClient;
}

function getDrive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: getAuth() });
  }
  return driveClient;
}

// --- Create Spreadsheet ---

/**
 * Create a new spreadsheet.
 * If folderId is provided, moves the file to that folder.
 * If no folder or folder move fails, shares with "anyone with link" so the user can access it.
 */
export async function createSpreadsheet(title, folderId) {
  const sheets = getSheets();
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
        },
      });

      const spreadsheetId = res.data.spreadsheetId;
      const url = res.data.spreadsheetUrl;
      let movedToFolder = false;

      // Move to folder if specified
      if (folderId) {
        try {
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
          movedToFolder = true;
        } catch (moveErr) {
          log.warn('Failed to move spreadsheet to folder, sharing with link instead', {
            spreadsheetId, folderId, error: moveErr.message,
          });
        }
      }

      // If not in a shared folder, make it accessible via link
      if (!movedToFolder) {
        try {
          await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: { type: 'anyone', role: 'reader' },
          });
        } catch (shareErr) {
          log.warn('Failed to share spreadsheet with link', { spreadsheetId, error: shareErr.message });
        }
      }

      log.info(`Created spreadsheet: ${title}`, { spreadsheetId, movedToFolder });
      return { spreadsheetId, url };
    }, { retries: 3, label: 'Google Sheets create', shouldRetry: (err) => !(err.message || '').includes('does not have permission') })
  );
}

// --- Write Data ---

export async function writeData(spreadsheetId, range, values) {
  const sheets = getSheets();

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
