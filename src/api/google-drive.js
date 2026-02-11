import { google } from 'googleapis';
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
    if (config.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(config.GOOGLE_APPLICATION_CREDENTIALS)) {
      auth = new google.auth.GoogleAuth({
        keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/documents',
        ],
      });
    } else {
      log.warn('Google credentials not configured; Drive operations will fail');
      return null;
    }
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

// --- File Operations ---

export async function listFiles(folderId, opts = {}) {
  const drive = getDrive();
  if (!drive) return { files: [] };

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
  const drive = getDrive();
  if (!drive) return null;

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
  if (!drive) return null;

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

// --- Create & Upload ---

export async function createFolder(name, parentId) {
  const drive = getDrive();
  if (!drive) return null;

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
  if (!drive || !docs) return null;

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
  if (!drive) return null;

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

// --- Client Folder Structure ---

export async function ensureClientFolders(clientName) {
  const rootFolderId = config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) return null;

  const clientFolder = await createFolder(clientName, rootFolderId);
  if (!clientFolder) return null;

  const subfolders = ['Brand Assets', 'Reports', 'Strategic Plans', 'Creatives', 'Audits', 'Competitor Research'];
  const folders = { root: clientFolder };

  for (const name of subfolders) {
    folders[name.toLowerCase().replace(/\s+/g, '_')] = await createFolder(name, clientFolder.id);
  }

  log.info(`Created client folder structure for ${clientName}`, { folderId: clientFolder.id });
  return folders;
}

export default {
  listFiles, getFile, downloadFile, exportDocument,
  createFolder, createDocument, uploadFile,
  ensureClientFolders,
};
