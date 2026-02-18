import * as openaiMedia from './openai-media.js';
import * as fal from './fal.js';
import * as gemini from './gemini.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ platform: 'image-router' });

/**
 * Image generation router with smart provider fallback.
 *
 * Provider priority (tries each in order, falls back on failure):
 *   1. DALL-E 3  (OpenAI)    — highest quality, most reliable
 *   2. fal.ai    (Flux Pro)   — fast, great quality, different aesthetic
 *   3. Imagen 3  (Gemini)     — Google's model, good for variety
 *
 * On quota exhaustion, auth failure, or rate limit → automatically tries next provider.
 * Returns whichever provider succeeds first.
 */

// Track transient provider failures to avoid repeatedly hitting broken providers
const providerFailures = new Map(); // provider → { count, lastFailure }
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after 3 consecutive failures

function isProviderCoolingDown(provider) {
  const info = providerFailures.get(provider);
  if (!info) return false;
  if (info.count < 3) return false;
  if (Date.now() - info.lastFailure > FAILURE_COOLDOWN_MS) {
    providerFailures.delete(provider);
    return false;
  }
  return true;
}

function recordProviderFailure(provider) {
  const info = providerFailures.get(provider) || { count: 0, lastFailure: 0 };
  info.count += 1;
  info.lastFailure = Date.now();
  providerFailures.set(provider, info);
}

function recordProviderSuccess(provider) {
  providerFailures.delete(provider);
}

/**
 * Get ordered list of available providers (configured + not cooling down).
 * @param {string} [preferred] - Preferred provider to try first
 */
function getAvailableProviders(preferred) {
  const all = [
    { key: 'dalle', name: 'DALL-E 3', configured: !!config.OPENAI_API_KEY },
    { key: 'fal', name: 'Flux Pro (fal.ai)', configured: fal.isConfigured() },
    { key: 'gemini', name: 'Imagen 3 (Gemini)', configured: gemini.isConfigured() },
  ];

  let providers = all.filter(p => p.configured && !isProviderCoolingDown(p.key));

  // Move preferred provider to front
  if (preferred) {
    const idx = providers.findIndex(p => p.key === preferred);
    if (idx > 0) {
      const [pref] = providers.splice(idx, 1);
      providers.unshift(pref);
    }
  }

  return providers;
}

/**
 * Check if an error indicates we should try the next provider.
 * (quota exhaustion, auth failure, rate limit, or safety block)
 */
function isFallbackError(error) {
  const msg = (error.message || '').toLowerCase();
  const status = error.status || error.response?.status;

  // Rate limit or quota
  if (status === 429) return true;
  if (msg.includes('rate_limit') || msg.includes('quota') || msg.includes('billing')) return true;

  // Auth / config
  if (status === 401 || status === 403) return true;
  if (msg.includes('api_key') || msg.includes('not configured') || msg.includes('unauthorized')) return true;

  // Safety / content policy (different providers handle different content)
  if (msg.includes('safety') || msg.includes('content_policy') || msg.includes('blocked')) return true;

  // Server errors (provider might be down)
  if (status >= 500) return true;

  return false;
}

// ============================================================
// Single Image Generation with Fallback
// ============================================================

/**
 * Generate a single image, trying providers in priority order.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.quality - 'standard' or 'hd' (DALL-E only)
 * @param {string} opts.style - 'vivid' or 'natural' (DALL-E only)
 * @param {string} opts.preferred - Preferred provider: 'dalle', 'fal', 'gemini'
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  const providers = getAvailableProviders(opts.preferred);

  if (providers.length === 0) {
    throw new Error('No image generation providers available. Configure at least one of: OPENAI_API_KEY, FAL_API_KEY, or GEMINI_API_KEY.');
  }

  let lastError;

  for (const provider of providers) {
    try {
      log.info(`Trying ${provider.name} for image generation`, { format: opts.format });

      let result;
      switch (provider.key) {
        case 'dalle':
          result = await openaiMedia.generateImage({
            prompt: opts.prompt,
            format: opts.format || 'general',
            quality: opts.quality || 'hd',
            style: opts.style || 'natural',
            workflow: opts.workflow,
            clientId: opts.clientId,
          });
          result.provider = 'dalle';
          break;

        case 'fal':
          result = await fal.generateImage({
            prompt: opts.prompt,
            format: opts.format || 'general',
            workflow: opts.workflow,
            clientId: opts.clientId,
          });
          break;

        case 'gemini':
          result = await gemini.generateImage({
            prompt: opts.prompt,
            format: opts.format || 'general',
            workflow: opts.workflow,
            clientId: opts.clientId,
          });
          break;
      }

      recordProviderSuccess(provider.key);
      log.info(`Image generated via ${provider.name}`, { format: opts.format, provider: provider.key });
      return result;

    } catch (error) {
      lastError = error;
      log.warn(`${provider.name} failed`, { error: error.message, format: opts.format });

      if (isFallbackError(error)) {
        recordProviderFailure(provider.key);
        log.info(`Falling back to next provider after ${provider.name} failure`);
        continue;
      }

      // Non-fallback error (e.g. bad prompt) — don't try other providers, same prompt will likely fail
      throw error;
    }
  }

  throw lastError || new Error('All image generation providers failed');
}

// ============================================================
// Multi-Format Ad Image Generation with Fallback
// ============================================================

/**
 * Generate ad images for multiple platform formats, with per-image fallback.
 * If a provider fails mid-batch, remaining formats try the next provider.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Base image prompt
 * @param {string} opts.platform - Platform key ('meta', 'instagram', 'google', 'tiktok')
 * @param {string[]} opts.formats - Specific format keys (optional)
 * @param {string} opts.quality - 'standard' or 'hd'
 * @param {string} opts.style - 'vivid' or 'natural'
 * @param {string} opts.preferred - Preferred provider: 'dalle', 'fal', 'gemini'
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {Array} Array of generated images with metadata
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
      const image = await generateImage({
        ...opts,
        prompt: `${opts.prompt}. Professional advertising quality for ${format.replace(/_/g, ' ')} format. Clean composition, no text overlays.`,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`All providers failed for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'none' });
    }
  }

  return results;
}

// ============================================================
// Provider Status
// ============================================================

/**
 * Get current status of all image generation providers.
 */
export function getProviderStatus() {
  return {
    dalle:  { configured: !!config.OPENAI_API_KEY, coolingDown: isProviderCoolingDown('dalle') },
    fal:    { configured: fal.isConfigured(), coolingDown: isProviderCoolingDown('fal') },
    gemini: { configured: gemini.isConfigured(), coolingDown: isProviderCoolingDown('gemini') },
  };
}

export default { generateImage, generateAdImages, getProviderStatus };
