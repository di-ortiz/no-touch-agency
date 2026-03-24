/**
 * Google Drive / Supabase Storage hybrid module.
 *
 * WRITE operations (upload, create, share) → Supabase Storage
 * READ operations (list, download, export) → Google Drive (for existing docs)
 *
 * This lets us keep reading existing Google Docs/Sheets/Slides while
 * storing all new media assets in Supabase (no service-account quota issues).
 */
import { google } from 'googleapis';
import axios from 'axios';
import { Readable } from 'stream';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';
import * as supaStorage from './supabase-storage.js';
import { getGoogleAuth } from './google-auth.js';

const log = logger.child({ platform: 'google-drive' });

// ============================================================
// Google Drive client (for read operations on existing docs)
// ============================================================
let driveClient;
let docsClient;

function getAuth() {
  const auth = getGoogleAuth([
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
  ]);
  if (!auth) {
    log.warn('Google credentials not found, Drive read operations unavailable');
  }
  return auth;
}

function getDrive() {
  if (!driveClient) {
    const a = getAuth();
    if (!a) return null;
    driveClient = google.drive({ version: 'v3', auth: a });
  }
  return driveClient;
}

function getDocs() {
  if (!docsClient) {
    const a = getAuth();
    if (!a) return null;
    docsClient = google.docs({ version: 'v1', auth: a });
  }
  return docsClient;
}

// ============================================================
// READ operations — still use Google Drive for existing docs
// ============================================================

export async function listFiles(folderId, opts = {}) {
  // If folderId looks like a Supabase path (no Google Drive ID format), use Supabase
  if (folderId && folderId.includes('/')) {
    return supaStorage.listFiles(folderId, opts);
  }

  const drive = getDrive();
  if (!drive) return supaStorage.listFiles(folderId, opts);

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
  if (!drive) return null;

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
  // If fileId looks like a Supabase path, use Supabase
  if (fileId && fileId.includes('/')) {
    return supaStorage.downloadFile(fileId);
  }

  const drive = getDrive();
  if (!drive) return supaStorage.downloadFile(fileId);

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
  if (!drive) throw new Error('Google Drive not configured for document export');

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.export({ fileId, mimeType });
      return res.data;
    }, { retries: 3, label: 'Google Drive export' })
  );
}

export async function exportDocumentAsBuffer(fileId, mimeType = 'application/pdf') {
  const drive = getDrive();
  if (!drive) throw new Error('Google Drive not configured for document export');

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

// ============================================================
// WRITE operations — route to Supabase Storage
// ============================================================

export async function createFolder(name, parentId) {
  // Supabase uses path-based storage, folders are implicit
  const folderPath = parentId ? `${parentId}/${name.toLowerCase().replace(/\s+/g, '-')}` : `folders/${name.toLowerCase().replace(/\s+/g, '-')}`;
  log.info(`Created folder (Supabase path): ${name}`, { id: folderPath });
  return { id: folderPath, name };
}

export async function createDocument(name, content, folderId) {
  if (supaStorage.isConfigured()) {
    const result = await supaStorage.createDocument(name, content, folderId);
    log.info(`Created document in Supabase: ${name}`, { id: result.id });
    return result;
  }

  // Fallback to Google Drive if Supabase not configured
  const drive = getDrive();
  const docs = getDocs();
  if (!drive || !docs) {
    log.warn('Neither Supabase nor Google Drive configured for document creation');
    return { id: null, name, webViewLink: null };
  }

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.document',
          parents: [folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
        },
        fields: 'id, name, webViewLink',
      });
      if (content) {
        await docs.documents.batchUpdate({
          documentId: res.data.id,
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: content } }],
          },
        });
      }
      log.info(`Created document in Google Drive: ${name}`, { id: res.data.id });
      return res.data;
    }, { retries: 3, label: 'Google Drive create doc' })
  );
}

export async function uploadFile(name, content, mimeType, folderId) {
  if (supaStorage.isConfigured()) {
    const result = await supaStorage.uploadFile(name, content, mimeType, folderId);
    log.info(`Uploaded file to Supabase: ${name}`, { path: result.id });
    return result;
  }

  // Fallback to Google Drive
  const drive = getDrive();
  if (!drive) {
    log.warn('Neither Supabase nor Google Drive configured for file upload');
    return { id: null, name, webViewLink: null };
  }

  return rateLimited('google', () =>
    retry(async () => {
      const res = await drive.files.create({
        requestBody: {
          name,
          parents: [folderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
        },
        media: { mimeType, body: content },
        fields: 'id, name, webViewLink',
      });
      return res.data;
    }, { retries: 3, label: 'Google Drive upload' })
  );
}

export async function appendToDocument(documentId, text) {
  // If documentId looks like a Supabase path, use Supabase
  if (documentId && documentId.includes('/')) {
    return supaStorage.appendToDocument(documentId, text);
  }

  const docs = getDocs();
  if (!docs) {
    return supaStorage.appendToDocument(documentId, text);
  }

  return rateLimited('google', () =>
    retry(async () => {
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

// ============================================================
// Client Folder Structure — Supabase path-based
// ============================================================

export async function ensureClientFolders(clientName) {
  if (supaStorage.isConfigured()) {
    const folders = supaStorage.ensureClientFolders(clientName);
    log.info(`Created client folder structure in Supabase for ${clientName}`, { root: folders.root.id });
    return folders;
  }

  // Fallback to Google Drive
  const rootFolderId = config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) {
    throw new Error('Neither Supabase nor GOOGLE_DRIVE_ROOT_FOLDER_ID configured for client folders.');
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

// ============================================================
// Sharing — no-ops for Supabase (public bucket), fallback to Drive
// ============================================================

export async function shareFolderWithAnyone(folderId, role = 'writer') {
  // If it's a Supabase path, sharing is implicit (public bucket)
  if (folderId && folderId.includes('/')) {
    return { folderId, shared: true, role };
  }

  const drive = getDrive();
  if (!drive) return { folderId, shared: true, role };

  return rateLimited('google', () =>
    retry(async () => {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { type: 'anyone', role },
      });
      log.info(`Shared folder ${folderId} with anyone (${role})`);
      return { folderId, shared: true, role };
    }, { retries: 3, label: 'Google Drive share folder' })
  );
}

export async function shareFolderWithEmail(folderId, email, role = 'writer') {
  if (folderId && folderId.includes('/')) {
    return { folderId, email, shared: true, role };
  }

  const drive = getDrive();
  if (!drive) return { folderId, email, shared: true, role };

  return rateLimited('google', () =>
    retry(async () => {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { type: 'user', role, emailAddress: email },
        sendNotificationEmail: true,
      });
      log.info(`Shared folder ${folderId} with ${email} (${role})`);
      return { folderId, email, shared: true, role };
    }, { retries: 3, label: 'Google Drive share with email' })
  );
}

// ============================================================
// Upload Image from URL — Supabase primary, buffer always available
// ============================================================

export async function uploadImageFromUrl(imageUrl, fileName, folderId) {
  // Always download the image first (needed for WhatsApp direct send)
  let imageBuffer, mimeType;
  try {
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

  // Upload to Supabase Storage
  if (supaStorage.isConfigured()) {
    try {
      const filePath = folderId ? `${folderId}/${fileName}` : `media/${fileName}`;
      const result = await supaStorage.uploadBuffer(filePath, imageBuffer, mimeType);
      log.info('Image persisted to Supabase Storage', { path: filePath, fileName });
      return { id: result.path, webViewLink: result.url, webContentLink: result.url, imageBuffer, mimeType };
    } catch (e) {
      log.error('Failed to persist image to Supabase Storage', { error: e.message, fileName });
      return { id: null, webViewLink: null, webContentLink: null, imageBuffer, mimeType, driveError: e.message };
    }
  }

  // Fallback: return buffer only (no storage configured)
  log.warn('No storage backend configured, returning buffer only');
  return { id: null, webViewLink: null, webContentLink: null, imageBuffer, mimeType, driveError: 'No storage configured' };
}

export default {
  listFiles, getFile, downloadFile, exportDocument, exportDocumentAsBuffer,
  createFolder, createDocument, appendToDocument, uploadFile, uploadImageFromUrl,
  ensureClientFolders,
  shareFolderWithAnyone, shareFolderWithEmail,
};
