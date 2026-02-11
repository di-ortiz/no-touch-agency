import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import * as googleDrive from '../api/google-drive.js';
import { getClient, updateClient } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'brand-ingestion' });

/**
 * Brand Asset Ingestion System
 * Scans a client's Google Drive folder for brand assets,
 * extracts brand guidelines, and updates the knowledge base.
 */

const SUPPORTED_DOC_TYPES = [
  'application/vnd.google-apps.document',
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'application/vnd.google-apps.drawing',
];

/**
 * Ingest brand assets for a client from their Google Drive folder.
 * @param {string} clientId - Client ID in knowledge base
 */
export async function ingestBrandAssets(clientId) {
  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const brandFolderId = client.drive_creatives_folder_id || client.drive_root_folder_id;
  if (!brandFolderId) {
    log.warn(`No Drive folder configured for ${client.name}`);
    return { status: 'skipped', reason: 'No Google Drive folder configured' };
  }

  log.info(`Ingesting brand assets for ${client.name}`, { folderId: brandFolderId });

  // 1. List all files in brand assets folder
  const files = await googleDrive.listFiles(brandFolderId);
  if (!files?.files?.length) {
    return { status: 'empty', reason: 'No files found in brand folder' };
  }

  const results = {
    documentsProcessed: 0,
    imagesFound: 0,
    brandVoice: null,
    brandColors: null,
    brandFonts: null,
    targetAudience: null,
    keyMessages: [],
    errors: [],
  };

  // 2. Process documents (brand books, guidelines, briefs)
  const documents = files.files.filter(f => SUPPORTED_DOC_TYPES.includes(f.mimeType));
  const images = files.files.filter(f => SUPPORTED_IMAGE_TYPES.includes(f.mimeType));

  results.imagesFound = images.length;

  const documentTexts = [];
  for (const doc of documents.slice(0, 10)) { // Limit to 10 docs for cost control
    try {
      let text;
      if (doc.mimeType === 'application/vnd.google-apps.document') {
        text = await googleDrive.exportDocument(doc.id, 'text/plain');
      } else {
        const buffer = await googleDrive.downloadFile(doc.id);
        text = buffer ? buffer.toString('utf-8').slice(0, 10000) : null;
      }

      if (text) {
        documentTexts.push({ name: doc.name, content: text.slice(0, 5000) });
        results.documentsProcessed++;
      }
    } catch (e) {
      log.warn(`Failed to process ${doc.name}`, { error: e.message });
      results.errors.push(`${doc.name}: ${e.message}`);
    }
  }

  if (documentTexts.length === 0) {
    return { status: 'no_docs', reason: 'No processable documents found', ...results };
  }

  // 3. Use Claude to extract brand guidelines
  const docSummary = documentTexts.map(d =>
    `--- Document: ${d.name} ---\n${d.content}`
  ).join('\n\n');

  const response = await askClaude({
    systemPrompt: `You are a brand analyst extracting structured brand guidelines from documents.
Analyze the provided documents and extract the following information in JSON format:
{
  "brandVoice": "description of brand tone, style, personality",
  "brandColors": ["#hex1", "#hex2", ...],
  "brandFonts": "primary and secondary fonts",
  "targetAudience": "detailed target audience description",
  "keyMessages": ["message1", "message2", ...],
  "doNotUse": ["things to avoid in messaging"],
  "competitivePositioning": "how the brand differentiates",
  "productServices": "main products or services offered"
}
Only include fields where you find clear information. Return valid JSON only.`,
    userMessage: `Extract brand guidelines from these documents for client "${client.name}":\n\n${docSummary}`,
    model: 'claude-sonnet-4-5-20250514',
    maxTokens: 2048,
    workflow: 'brand-ingestion',
    clientId,
  });

  // 4. Parse Claude's response
  let extracted;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    log.warn('Failed to parse brand extraction JSON');
    extracted = {};
  }

  // 5. Update knowledge base
  const updates = {};
  if (extracted.brandVoice) {
    updates.brand_voice = extracted.brandVoice;
    results.brandVoice = extracted.brandVoice;
  }
  if (extracted.brandColors?.length > 0) {
    updates.brand_colors = JSON.stringify(extracted.brandColors);
    results.brandColors = extracted.brandColors;
  }
  if (extracted.brandFonts) {
    updates.brand_fonts = extracted.brandFonts;
    results.brandFonts = extracted.brandFonts;
  }
  if (extracted.targetAudience) {
    updates.target_audience = extracted.targetAudience;
    results.targetAudience = extracted.targetAudience;
  }
  if (extracted.keyMessages) {
    results.keyMessages = extracted.keyMessages;
  }
  if (extracted.productServices && !client.description) {
    updates.description = extracted.productServices;
  }

  if (Object.keys(updates).length > 0) {
    updateClient(client.id, updates);
  }

  log.info(`Brand ingestion complete for ${client.name}`, {
    docsProcessed: results.documentsProcessed,
    imagesFound: results.imagesFound,
    fieldsExtracted: Object.keys(updates).length,
  });

  return { status: 'success', ...results, extracted };
}

/**
 * Check if a client's brand folder has new/updated files since last ingestion.
 */
export async function checkForBrandUpdates(clientId) {
  const client = getClient(clientId);
  if (!client) return false;

  const folderId = client.drive_creatives_folder_id || client.drive_root_folder_id;
  if (!folderId) return false;

  const files = await googleDrive.listFiles(folderId, { limit: 5 });
  if (!files?.files?.length) return false;

  // Check if most recent file is newer than client updated_at
  const newestFile = files.files[0];
  const fileDate = new Date(newestFile.modifiedTime);
  const clientDate = new Date(client.updated_at);

  return fileDate > clientDate;
}

export default { ingestBrandAssets, checkForBrandUpdates };
