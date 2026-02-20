import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'gemini' });

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Check if Gemini is configured with an API key.
 */
export function isConfigured() {
  return !!config.GEMINI_API_KEY;
}

// Map ad format keys → Imagen 3 aspect ratios
const FORMAT_ASPECT_MAP = {
  meta_feed:       '16:9',
  meta_square:     '1:1',
  meta_story:      '9:16',
  instagram_feed:  '1:1',
  instagram_story: '9:16',
  google_display:  '16:9',
  google_square:   '1:1',
  tiktok:          '9:16',
  general:         '1:1',
};

const FORMAT_LABELS = {
  meta_feed:       'Meta Feed (16:9)',
  meta_square:     'Meta Square (1:1)',
  meta_story:      'Meta Story/Reel (9:16)',
  instagram_feed:  'Instagram Feed (1:1)',
  instagram_story: 'Instagram Story (9:16)',
  google_display:  'Google Display (16:9)',
  google_square:   'Google Square (1:1)',
  tiktok:          'TikTok (9:16)',
  general:         'General (1:1)',
};

// Rough dimension mapping for response metadata
const ASPECT_DIMENSIONS = {
  '1:1':  { width: 1024, height: 1024 },
  '16:9': { width: 1792, height: 1024 },
  '9:16': { width: 1024, height: 1792 },
  '4:3':  { width: 1024, height: 768 },
  '3:4':  { width: 768, height: 1024 },
};

// ============================================================
// Imagen 3 Image Generation
// ============================================================

/**
 * Generate an image using Google Imagen 3.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not configured');

  const format = opts.format || 'general';
  const aspectRatio = FORMAT_ASPECT_MAP[format] || '1:1';

  return rateLimited('gemini', () =>
    retry(async () => {
      log.info('Generating Imagen 3 image', { format, aspectRatio, prompt: opts.prompt?.slice(0, 100) });

      const response = await axios.post(
        `${GEMINI_BASE}/models/imagen-3.0-generate-002:predict?key=${config.GEMINI_API_KEY}`,
        {
          instances: [{ prompt: opts.prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio,
          },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 },
      );

      const predictions = response.data?.predictions;
      if (!predictions?.length || !predictions[0].bytesBase64Encoded) {
        throw new Error('No image returned from Imagen 3');
      }

      // Convert base64 to a data URI (Sofia delivers via URL, but we'll upload to temporary hosting)
      // For now, return as base64 data URI — the image router will handle upload if needed
      const base64 = predictions[0].bytesBase64Encoded;
      const mimeType = predictions[0].mimeType || 'image/png';
      const dataUri = `data:${mimeType};base64,${base64}`;

      const dims = ASPECT_DIMENSIONS[aspectRatio] || ASPECT_DIMENSIONS['1:1'];

      // Imagen 3: ~$0.04 per image (standard)
      recordCost({
        platform: 'gemini',
        model: 'imagen-3.0-generate-002',
        workflow: opts.workflow || 'creative-generation',
        clientId: opts.clientId,
        costCentsOverride: 4.0,
        metadata: { format, aspectRatio },
      });

      log.info('Imagen 3 image generated', { format });
      return {
        url: dataUri,
        base64,
        mimeType,
        format,
        dimensions: { ...dims, label: FORMAT_LABELS[format] || format },
        provider: 'gemini',
      };
    }, { retries: 0, label: 'Imagen 3', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Generate ad images for multiple platform formats.
 */
export async function generateAdImages(opts = {}) {
  const PLATFORM_DEFAULTS = {
    meta:      ['meta_feed', 'meta_square', 'meta_story'],
    instagram: ['instagram_feed', 'instagram_story'],
    google:    ['google_display', 'google_square'],
    tiktok:    ['tiktok'],
  };

  const formats = opts.formats || PLATFORM_DEFAULTS[opts.platform] || ['general'];
  const results = [];

  for (const format of formats) {
    try {
      const formatPrompt = `${opts.prompt}. This is a ${FORMAT_LABELS[format] || format} ad creative. Professional advertising quality, clean composition, no text overlays.`;

      const image = await generateImage({
        ...opts,
        prompt: formatPrompt,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`Imagen 3 failed for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'gemini' });
    }
  }

  return results;
}

// ============================================================
// Gemini Vision — Analyze images (competitor ads, references)
// ============================================================

/**
 * Analyze an image using Gemini's multi-modal vision capabilities.
 * Perfect for extracting style details from competitor ads or reference images.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl - URL of the image to analyze
 * @param {string} opts.imageBase64 - Base64-encoded image (alternative to URL)
 * @param {string} opts.mimeType - Image MIME type (default: 'image/jpeg')
 * @param {string} opts.prompt - What to analyze about the image
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { analysis, model }
 */
export async function analyzeImage(opts = {}) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not configured');

  const mimeType = opts.mimeType || 'image/jpeg';

  return rateLimited('gemini', () =>
    retry(async () => {
      log.info('Analyzing image with Gemini Vision', { hasUrl: !!opts.imageUrl, prompt: opts.prompt?.slice(0, 80) });

      // Build the parts array
      const parts = [
        { text: opts.prompt || 'Analyze this image in detail. Describe the composition, colors, style, mood, lighting, and any notable creative techniques used.' },
      ];

      if (opts.imageBase64) {
        parts.push({
          inlineData: {
            mimeType,
            data: opts.imageBase64,
          },
        });
      } else if (opts.imageUrl) {
        // Fetch image and convert to base64
        const imgResponse = await axios.get(opts.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const base64 = Buffer.from(imgResponse.data).toString('base64');
        const detectedMime = imgResponse.headers['content-type'] || mimeType;
        parts.push({
          inlineData: {
            mimeType: detectedMime,
            data: base64,
          },
        });
      } else {
        throw new Error('Either imageUrl or imageBase64 is required');
      }

      const response = await axios.post(
        `${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API_KEY}`,
        {
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2048,
          },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No analysis returned from Gemini Vision');

      // Gemini Flash: ~$0.01 per image analysis
      recordCost({
        platform: 'gemini',
        model: 'gemini-2.0-flash',
        workflow: opts.workflow || 'image-analysis',
        clientId: opts.clientId,
        costCentsOverride: 1.0,
        metadata: { type: 'vision-analysis' },
      });

      log.info('Gemini Vision analysis complete', { textLength: text.length });
      return { analysis: text, model: 'gemini-2.0-flash' };
    }, { retries: 2, label: 'Gemini Vision', shouldRetry: isRetryableHttpError })
  );
}

export default { generateImage, generateAdImages, analyzeImage, isConfigured };
