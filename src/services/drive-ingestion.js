import { listFiles, downloadFile, getFile } from '../api/google-drive.js';
import { extractFromTranscript } from './deliverable-extractor.js';
import { logIngestion } from './team-task-tracker.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'drive-ingestion' });

/**
 * Scan a Google Drive folder for new meeting transcripts/recaps and extract deliverables.
 * Supports: Google Docs, plain text files, and PDFs (text content).
 *
 * @param {string} folderId - The Google Drive folder ID to scan
 * @param {object} opts
 * @param {string} opts.since - Only process files modified after this ISO date
 * @param {string[]} opts.processedFileIds - File IDs already processed (to skip)
 */
export async function scanDriveFolder(folderId, opts = {}) {
  const { since, processedFileIds = [] } = opts;

  if (!folderId) {
    log.warn('No folder ID provided for drive ingestion');
    return { scanned: 0, extracted: [] };
  }

  try {
    const files = await listFiles(folderId);
    if (!files || files.length === 0) {
      log.info('No files found in folder', { folderId });
      return { scanned: 0, extracted: [] };
    }

    // Filter: only docs/text, skip already processed
    const processable = files.filter(f => {
      if (processedFileIds.includes(f.id)) return false;
      if (since && f.modifiedTime && new Date(f.modifiedTime) < new Date(since)) return false;
      const mime = f.mimeType || '';
      return (
        mime.includes('document') ||
        mime.includes('text/plain') ||
        mime.includes('pdf') ||
        mime === 'application/vnd.google-apps.document'
      );
    });

    log.info('Drive scan: processable files', { total: files.length, processable: processable.length });

    const allExtracted = [];

    for (const file of processable) {
      try {
        let content;

        if (file.mimeType === 'application/vnd.google-apps.document') {
          // Google Doc — export as plain text
          content = await exportGoogleDoc(file.id);
        } else {
          // Regular file — download content
          content = await downloadFile(file.id);
        }

        if (!content || typeof content !== 'string' || content.trim().length < 20) {
          log.debug('File content too short, skipping', { fileId: file.id, name: file.name });
          continue;
        }

        const results = await extractFromTranscript({
          title: file.name,
          transcript: content,
          fileId: file.id,
          meetingDate: file.modifiedTime?.split('T')[0],
        });

        allExtracted.push({ file: file.name, fileId: file.id, deliverables: results });
        log.info('Processed drive file', { name: file.name, extracted: results.length });
      } catch (err) {
        log.error('Failed to process drive file', { name: file.name, id: file.id, error: err.message });
      }
    }

    return {
      scanned: processable.length,
      extracted: allExtracted,
    };
  } catch (err) {
    log.error('Drive folder scan failed', { folderId, error: err.message });
    throw err;
  }
}

/**
 * Export a Google Doc as plain text.
 */
async function exportGoogleDoc(docId) {
  try {
    // The google-drive module's downloadFile should handle export for Google Docs
    // but let's try a direct export approach
    const { google } = await import('googleapis');
    const fs = await import('fs');
    const config = (await import('../config.js')).default;

    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.export({
      fileId: docId,
      mimeType: 'text/plain',
    });

    return res.data;
  } catch (err) {
    log.error('Failed to export Google Doc', { docId, error: err.message });
    // Fallback: try the regular download
    return downloadFile(docId);
  }
}

/**
 * Process a single file by ID (for manual ingestion via API).
 */
export async function processFileById(fileId) {
  try {
    const file = await getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    let content;
    if (file.mimeType === 'application/vnd.google-apps.document') {
      content = await exportGoogleDoc(fileId);
    } else {
      content = await downloadFile(fileId);
    }

    if (!content || typeof content !== 'string') {
      throw new Error('Could not extract text content from file');
    }

    const results = await extractFromTranscript({
      title: file.name,
      transcript: content,
      fileId,
      meetingDate: file.modifiedTime?.split('T')[0],
    });

    return { file: file.name, fileId, deliverables: results };
  } catch (err) {
    log.error('Failed to process file', { fileId, error: err.message });
    throw err;
  }
}

export default { scanDriveFolder, processFileById };
