import { google } from 'googleapis';
import axios from 'axios';
import { Readable } from 'stream';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';
import fs from 'fs';
import path from 'path';

const log = logger.child({ platform: 'google-drive' });

let auth;
let driveClient;
let docsClient;

function getAuth() {
  if (!auth) {
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    if (fs.existsSync(credPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/documents',
        ],
      });
    } else {
      log.error('Google credentials MISSING', { credPath });
      throw new Error(
        `Google service account credentials not found. ` +
        `Expected credentials at "${credPath}" but the file does NOT exist. ` +
        `To fix: 1) Go to console.cloud.google.com → IAM → Service Accounts, ` +
        `2) Create a service account with Drive/Docs API access, ` +
        `3) Download the JSON key and save it to ${credPath}`
      );
    }
  }
  return auth;
}

function getDrive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: getAuth() });
  }
  return driveClient;
}

function getDocs() {
  if (!docsClient) {
    docsClient = google.docs({ version: 'v1', auth: getAuth() });
  }
  return docsClient;
}

// --- File Operations ---

export async function listFiles(folderId, opts = {}) {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.list({
        q: `'${folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, modifiedTime, size)',
        orderBy: 'modifiedTime desc',
        pageSize: opts.limit || 100,
      });
      return res.data;
    }, { retries: 3, label: 'Google Drive list' })
  );
}

export async function getFile(fileId) {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.get({
        fileId,
        fields: 'id, name, mimeType, modifiedTime, size, parents',
      });
      return res.data;
    }, { retries: 3, label: 'Google Drive get file' })
  );
}

export async function downloadFile(fileId) {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' },
      );
      return res.data;
    }, { retries: 3, label: 'Google Drive download' })
  );
}

export async function exportDocument(fileId, mimeType = 'text/plain') {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.export({
        fileId,
        mimeType,
      });
      return res.data;
    }, { retries: 3, label: 'Google Drive export' })
  );
}

/**
 * Export a Google Workspace file (Doc/Slides/Sheet) as a binary Buffer.
 * Use this for PDF/PPTX/XLSX exports that need to be uploaded to WhatsApp/Telegram.
 * @param {string} fileId - The Google Drive file ID
 * @param {string} mimeType - Export MIME type (e.g. 'application/pdf')
 * @returns {Buffer|null} The exported file as a Buffer, or null on failure
 */
export async function exportDocumentAsBuffer(fileId, mimeType = 'application/pdf') {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.export(
        { fileId, mimeType },
        { responseType: 'arraybuffer' },
      );
      return Buffer.from(res.data);
    }, { retries: 3, label: 'Google Drive export as buffer' })
  );
}

// --- Create & Upload ---

export async function createFolder(name, parentId) {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
        },
        fields: 'id, name',
      });
      log.info(`Created folder: ${name}`, { id: res.data.id });
      return res.data;
    }, { retries: 3, label: 'Google Drive create folder' })
  );
}

export async function createDocument(name, content, folderId) {
  const drive = getDrive();
  const docs = getDocs();

  return rateLimited('google', () =>
    retry(async () => {
      // Create empty doc
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.document',
          parents: [folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
        },
        fields: 'id, name, webViewLink',
      });

      // Insert content
      if (content) {
        await docs.documents.batchUpdate({
          documentId: res.data.id,
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: content } }],
          },
        });
      }

      log.info(`Created document: ${name}`, { id: res.data.id });
      return res.data;
    }, { retries: 3, label: 'Google Drive create doc' })
  );
}

export async function uploadFile(name, content, mimeType, folderId) {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.create({
        requestBody: {
          name,
          parents: [folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
        },
        media: {
          mimeType,
          body: content,
        },
        fields: 'id, name, webViewLink',
      });
      return res.data;
    }, { retries: 3, label: 'Google Drive upload' })
  );
}

/**
 * Append text to the end of an existing Google Doc.
 */
export async function appendToDocument(documentId, text) {
  const docs = getDocs();

  return rateLimited('google', () =>
    retry(async () => {
      // Get current document length
      const doc = await docs.documents.get({ documentId });
      const endIndex = doc.data.body.content
        .reduce((max, el) => Math.max(max, el.endIndex || 0), 0) - 1;

      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{ insertText: { location: { index: Math.max(1, endIndex) }, text: '\n' + text } }],
        },
      });
      return { documentId, appended: true };
    }, { retries: 3, label: 'Google Drive append doc' })
  );
}

// --- Client Folder Structure ---

export async function ensureClientFolders(clientName) {
  const rootFolderId = config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID not configured. Set it in environment variables.');
  }

  const clientFolder = await createFolder(clientName, rootFolderId);

  const subfolders = ['Brand Assets', 'Reports', 'Strategic Plans', 'Creatives', 'Audits', 'Competitor Research'];
  const folders = { root: clientFolder };

  for (const name of subfolders) {
    folders[name.toLowerCase().replace(/\s+/g, '_')] = await createFolder(name, clientFolder.id);
  }

  log.info(`Created client folder structure for ${clientName}`, { folderId: clientFolder.id });
  return folders;
}

// --- Sharing ---

/**
 * Share a folder (or file) with "anyone with the link" as a writer.
 * This allows clients to upload brand assets via a shared link.
 */
export async function shareFolderWithAnyone(folderId, role = 'writer') {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: {
          type: 'anyone',
          role,
        },
      });
      log.info(`Shared folder ${folderId} with anyone (${role})`);
      return { folderId, shared: true, role };
    }, { retries: 3, label: 'Google Drive share folder' })
  );
}

/**
 * Share a folder with a specific email address.
 */
export async function shareFolderWithEmail(folderId, email, role = 'writer') {
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: {
          type: 'user',
          role,
          emailAddress: email,
        },
        sendNotificationEmail: true,
      });
      log.info(`Shared folder ${folderId} with ${email} (${role})`);
      return { folderId, email, shared: true, role };
    }, { retries: 3, label: 'Google Drive share with email' })
  );
}

/**
 * Download an image from a URL and upload it to Google Drive, returning a public viewable link.
 * Also returns the raw image buffer so callers can upload directly to WhatsApp Media API
 * without a second download.
 *
 * @param {string} imageUrl - The temporary image URL to persist
 * @param {string} fileName - Filename for the uploaded image
 * @param {string} [folderId] - Google Drive folder to upload to
 * @returns {object|null} { id, webViewLink, webContentLink, imageBuffer, mimeType } or null on failure
 */
export async function uploadImageFromUrl(imageUrl, fileName, folderId) {
  // Always download the image (needed for both Drive upload and WhatsApp direct send)
  let imageBuffer, mimeType;
  try {
    // Handle base64 data URIs (e.g. from Gemini Imagen) — no HTTP fetch needed
    if (imageUrl?.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Invalid data URI format');
      mimeType = match[1];
      imageBuffer = Buffer.from(match[2], 'base64');
    } else {
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      imageBuffer = Buffer.from(response.data);
      mimeType = response.headers['content-type'] || 'image/png';
    }
  } catch (e) {
    log.warn('Failed to download image from URL', { error: e.message, imageUrl: imageUrl?.slice(0, 80) });
    return null;
  }

  let drive;
  try {
    drive = getDrive();
  } catch (credError) {
    // No Google Drive configured — still return the buffer for WhatsApp direct upload
    log.error('Google Drive not configured, cannot persist image', { error: credError.message });
    return { id: null, webViewLink: null, webContentLink: null, imageBuffer, mimeType, driveError: credError.message };
  }

  try {
    // Upload to Drive with a per-attempt timeout to avoid hanging on quota/permission errors
    const DRIVE_UPLOAD_TIMEOUT_MS = 30000; // 30s per attempt
    const uploaded = await rateLimited('google', () =>
      retry(async () => {
        // Create a fresh stream for each retry attempt (consumed streams can't be reused)
        const stream = Readable.from(imageBuffer);
        const res = await Promise.race([
          drive.files.create({
            requestBody: {
              name: fileName,
              parents: [folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
            },
            media: {
              mimeType,
              body: stream,
            },
            fields: 'id, name, webViewLink, webContentLink',
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Drive upload timed out')), DRIVE_UPLOAD_TIMEOUT_MS)),
        ]);
        return res.data;
      }, {
        retries: 1, // Only 1 retry (2 total attempts) to fail faster
        label: 'Google Drive upload image from URL',
        // Don't retry quota/permission errors — they won't succeed on retry
        shouldRetry: (err) => {
          const msg = err.message || '';
          if (msg.includes('storage quota') || msg.includes('do not have permission') || msg.includes('caller does not have permission')) return false;
          return true;
        },
      })
    );

    // Make publicly viewable
    await rateLimited('google', () =>
      retry(async () => {
        await drive.permissions.create({
          fileId: uploaded.id,
          requestBody: { type: 'anyone', role: 'reader' },
        });
      }, { retries: 2, label: 'Google Drive set image public' })
    );

    const webContentLink = `https://drive.google.com/uc?export=view&id=${uploaded.id}`;

    log.info('Image persisted to Google Drive', { id: uploaded.id, fileName });
    return { id: uploaded.id, webViewLink: uploaded.webViewLink, webContentLink, imageBuffer, mimeType };
  } catch (e) {
    log.error('FAILED to persist image to Google Drive', { error: e.message, fileName });
    // Drive upload failed but we still have the buffer for WhatsApp direct upload
    return { id: null, webViewLink: null, webContentLink: null, imageBuffer, mimeType, driveError: e.message };
  }
}

export default {
  listFiles, getFile, downloadFile, exportDocument, exportDocumentAsBuffer,
  createFolder, createDocument, appendToDocument, uploadFile, uploadImageFromUrl,
  ensureClientFolders,
  shareFolderWithAnyone, shareFolderWithEmail,
};
