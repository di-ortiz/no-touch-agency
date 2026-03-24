/**
 * Supabase Storage — file upload/download for generated media assets.
 * Replaces Google Drive as the primary storage backend for:
 *   - Generated ad images (DALL-E, Flux, Imagen, Kimi)
 *   - Generated videos (Sora 2, Kling)
 *   - Puppeteer-rendered template creatives
 *   - User-uploaded media from WhatsApp/Telegram
 *   - Reports, landing pages, and other documents
 */
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { rateLimited } from '../utils/rate-limiter.js';

const log = logger.child({ platform: 'supabase-storage' });

const BUCKET = 'media';

function getBaseUrl() {
  // Strip any trailing path like /rest/v1 to get the clean project URL
  return config.SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
}

function getStorageUrl() {
  return `${getBaseUrl()}/storage/v1`;
}

/**
 * Get auth headers for Supabase Storage.
 * Uses service role key (required for storage uploads) with anon key fallback.
 */
function getHeaders(contentType = 'application/octet-stream') {
  const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
  return {
    apikey: config.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${key}`,
    'Content-Type': contentType,
  };
}

/**
 * Check if Supabase Storage is configured.
 */
export function isConfigured() {
  return !!(config.SUPABASE_URL && (config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY));
}

/**
 * Ensure the media bucket exists. Creates it if missing.
 * Called lazily on first upload.
 */
let bucketChecked = false;
async function ensureBucket() {
  if (bucketChecked) return;
  try {
    const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
    await axios.post(
      `${getStorageUrl()}/bucket`,
      { id: BUCKET, name: BUCKET, public: true },
      {
        headers: {
          apikey: config.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );
    log.info('Created Supabase storage bucket', { bucket: BUCKET });
  } catch (e) {
    // 409 = bucket already exists, which is fine
    if (e.response?.status !== 409) {
      log.warn('Bucket creation check', { status: e.response?.status, message: e.message });
    }
  }
  bucketChecked = true;
}

/**
 * Build a public URL for a file in the media bucket.
 */
function publicUrl(filePath) {
  return `${getStorageUrl()}/object/public/${BUCKET}/${filePath}`;
}

/**
 * Upload a buffer to Supabase Storage.
 *
 * @param {string} filePath - Path within the bucket (e.g. 'clients/acme/creatives/ad-feed-123.png')
 * @param {Buffer} buffer - File content
 * @param {string} mimeType - MIME type (e.g. 'image/png', 'video/mp4')
 * @param {object} [opts] - Options
 * @param {boolean} [opts.upsert=true] - Overwrite if exists
 * @returns {object} { url, path, bucket }
 */
export async function uploadBuffer(filePath, buffer, mimeType, opts = {}) {
  if (!isConfigured()) throw new Error('Supabase Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');

  await ensureBucket();

  return rateLimited('supabase', () =>
    retry(async () => {
      const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
      await axios.post(
        `${getStorageUrl()}/object/${BUCKET}/${filePath}`,
        buffer,
        {
          headers: {
            apikey: config.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${key}`,
            'Content-Type': mimeType,
            'x-upsert': String(opts.upsert !== false),
          },
          timeout: 60000,
          maxContentLength: 100 * 1024 * 1024, // 100MB
          maxBodyLength: 100 * 1024 * 1024,
        },
      );

      const url = publicUrl(filePath);
      log.info('File uploaded to Supabase Storage', { path: filePath, size: buffer.length, url: url.slice(0, 80) });
      return { url, path: filePath, bucket: BUCKET };
    }, {
      retries: 2,
      label: `Supabase upload ${filePath}`,
      shouldRetry: (err) => {
        const msg = err.message || '';
        // Don't retry auth or bucket errors
        if (msg.includes('not authorized') || msg.includes('Bucket not found')) return false;
        return isRetryableHttpError(err);
      },
    })
  );
}

/**
 * Upload a file from a URL to Supabase Storage.
 * Downloads the file first, then uploads the buffer.
 * Also handles base64 data URIs (e.g. from Gemini Imagen).
 *
 * Returns the buffer alongside the URL so callers can deliver
 * media inline via WhatsApp/Telegram without a second download.
 *
 * @param {string} sourceUrl - URL to download from (or data: URI)
 * @param {string} fileName - Target filename (e.g. 'ad-feed-1234.png')
 * @param {string} [folder] - Folder path within bucket (e.g. 'clients/acme/creatives')
 * @returns {object|null} { url, path, imageBuffer, mimeType } or null on failure
 */
export async function uploadFromUrl(sourceUrl, fileName, folder) {
  let imageBuffer, mimeType;

  try {
    if (sourceUrl?.startsWith('data:')) {
      const match = sourceUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Invalid data URI format');
      mimeType = match[1];
      imageBuffer = Buffer.from(match[2], 'base64');
    } else {
      const response = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
      imageBuffer = Buffer.from(response.data);
      mimeType = response.headers['content-type'] || 'image/png';
    }
  } catch (e) {
    log.warn('Failed to download file from URL', { error: e.message, url: sourceUrl?.slice(0, 80) });
    return null;
  }

  if (!isConfigured()) {
    log.warn('Supabase Storage not configured, returning buffer only');
    return { url: null, path: null, imageBuffer, mimeType, storageError: 'Supabase not configured' };
  }

  const filePath = folder ? `${folder}/${fileName}` : fileName;

  try {
    const result = await uploadBuffer(filePath, imageBuffer, mimeType);
    return { ...result, imageBuffer, mimeType };
  } catch (e) {
    log.error('Failed to upload file to Supabase Storage', { error: e.message, path: filePath });
    return { url: null, path: null, imageBuffer, mimeType, storageError: e.message };
  }
}

/**
 * Upload a stream/buffer to Supabase Storage.
 * Convenience wrapper that accepts either a Buffer or a Readable stream.
 *
 * @param {string} name - Filename
 * @param {Buffer|import('stream').Readable} content - File content (Buffer or stream)
 * @param {string} mimeType - MIME type
 * @param {string} [folder] - Folder path within bucket
 * @returns {object} { id: path, name, webViewLink: url }
 */
export async function uploadFile(name, content, mimeType, folder) {
  let buffer;
  if (Buffer.isBuffer(content)) {
    buffer = content;
  } else if (content?.read || content?.[Symbol.asyncIterator]) {
    // Readable stream — collect into buffer
    const chunks = [];
    for await (const chunk of content) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    buffer = Buffer.concat(chunks);
  } else {
    throw new Error('content must be a Buffer or Readable stream');
  }

  const filePath = folder ? `${folder}/${name}` : `uploads/${name}`;
  const result = await uploadBuffer(filePath, buffer, mimeType);

  // Return shape compatible with google-drive.uploadFile callers
  return { id: result.path, name, webViewLink: result.url, webContentLink: result.url };
}

/**
 * Create a folder path for a client's assets.
 * Supabase Storage uses path-based organization, no explicit folder creation needed.
 *
 * @param {string} clientName - Client name
 * @returns {object} Folder paths matching google-drive ensureClientFolders shape
 */
export function ensureClientFolders(clientName) {
  const sanitized = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const root = `clients/${sanitized}`;

  return {
    root: { id: root, name: clientName },
    brand_assets: { id: `${root}/brand-assets`, name: 'Brand Assets' },
    reports: { id: `${root}/reports`, name: 'Reports' },
    strategic_plans: { id: `${root}/strategic-plans`, name: 'Strategic Plans' },
    creatives: { id: `${root}/creatives`, name: 'Creatives' },
    audits: { id: `${root}/audits`, name: 'Audits' },
    competitor_research: { id: `${root}/competitor-research`, name: 'Competitor Research' },
  };
}

/**
 * List files in a folder.
 *
 * @param {string} folder - Folder path within bucket
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @returns {object} { files: Array<{ name, id, metadata }> }
 */
export async function listFiles(folder, opts = {}) {
  if (!isConfigured()) return { files: [] };

  const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
  try {
    const res = await axios.post(
      `${getStorageUrl()}/object/list/${BUCKET}`,
      {
        prefix: folder || '',
        limit: opts.limit || 100,
        sortBy: { column: 'updated_at', order: 'desc' },
      },
      {
        headers: {
          apikey: config.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    const files = (res.data || []).map(f => ({
      id: `${folder}/${f.name}`,
      name: f.name,
      mimeType: f.metadata?.mimetype || 'application/octet-stream',
      modifiedTime: f.updated_at,
      size: f.metadata?.size,
    }));

    return { files };
  } catch (e) {
    log.warn('Failed to list files in Supabase Storage', { error: e.message, folder });
    return { files: [] };
  }
}

/**
 * Download a file from Supabase Storage.
 *
 * @param {string} filePath - Path within the bucket
 * @returns {Buffer} File content
 */
export async function downloadFile(filePath) {
  if (!isConfigured()) throw new Error('Supabase Storage not configured');

  const key = config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
  const res = await axios.get(
    `${getStorageUrl()}/object/${BUCKET}/${filePath}`,
    {
      headers: {
        apikey: config.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${key}`,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    },
  );
  return Buffer.from(res.data);
}

/**
 * Store text content as a file (replaces Google Docs createDocument).
 *
 * @param {string} name - Document name
 * @param {string} content - Text content
 * @param {string} [folder] - Folder path
 * @returns {object} { id, name, webViewLink }
 */
export async function createDocument(name, content, folder) {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileName = safeName.endsWith('.txt') ? safeName : `${safeName}.txt`;
  const filePath = folder ? `${folder}/${fileName}` : `documents/${fileName}`;

  const buffer = Buffer.from(content || '', 'utf-8');
  const result = await uploadBuffer(filePath, buffer, 'text/plain');

  return { id: result.path, name, webViewLink: result.url };
}

/**
 * Append text to an existing document stored in Supabase.
 *
 * @param {string} filePath - Path to the document in storage
 * @param {string} text - Text to append
 * @returns {object} { documentId, appended }
 */
export async function appendToDocument(filePath, text) {
  if (!isConfigured()) return { documentId: filePath, appended: false };

  try {
    const existing = await downloadFile(filePath);
    const updated = Buffer.concat([existing, Buffer.from('\n' + text, 'utf-8')]);
    await uploadBuffer(filePath, updated, 'text/plain');
    return { documentId: filePath, appended: true };
  } catch (e) {
    // If file doesn't exist, create it
    if (e.response?.status === 404 || e.response?.status === 400) {
      await uploadBuffer(filePath, Buffer.from(text, 'utf-8'), 'text/plain');
      return { documentId: filePath, appended: true };
    }
    log.error('Failed to append to document', { error: e.message, filePath });
    return { documentId: filePath, appended: false };
  }
}

/**
 * Get a public URL for a file. Supabase public bucket URLs are stable.
 * This is a no-op sharing function for API compatibility with google-drive.
 *
 * @param {string} filePathOrId - File path in storage
 * @returns {object} { folderId, shared, role }
 */
export function shareFolderWithAnyone(filePathOrId) {
  return { folderId: filePathOrId, shared: true, role: 'reader' };
}

export function shareFolderWithEmail(filePathOrId, email) {
  return { folderId: filePathOrId, email, shared: true, role: 'writer' };
}

export default {
  isConfigured,
  uploadBuffer,
  uploadFromUrl,
  uploadFile,
  ensureClientFolders,
  listFiles,
  downloadFile,
  createDocument,
  appendToDocument,
  shareFolderWithAnyone,
  shareFolderWithEmail,
};
