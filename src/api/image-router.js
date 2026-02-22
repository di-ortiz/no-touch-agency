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
 *   1. fal.ai    (Flux Schnell + Flux Pro racing) — fastest, great quality
 *   2. DALL-E 3  (OpenAI)    — highest quality, reliable fallback
 *   3. Imagen 3  (Gemini)     — Google's model, last resort
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
    { key: 'fal', name: 'Flux (fal.ai)', configured: fal.isConfigured() },
    { key: 'dalle', name: 'DALL-E 3', configured: !!config.OPENAI_API_KEY },
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
 * Default: ALWAYS fall back unless it's clearly a prompt/input issue that
 * would fail identically on every provider.
 */
function isFallbackError(error) {
  const msg = (error.message || '').toLowerCase();

  // Only these errors are NOT worth retrying on another provider — same prompt will fail the same way
  const promptErrors = ['invalid_prompt', 'prompt_too_long', 'bad_request'];
  for (const pe of promptErrors) {
    if (msg.includes(pe)) return false;
  }

  // Everything else: timeout, network, rate limit, auth, safety, server error, unexpected response — try next provider
  return true;
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
  const PER_FORMAT_TIMEOUT_MS = 90_000; // 90s max per format — enough for DALL-E (30s) + fallback to fal.ai (60s). No retries, just fast fallback.

  log.info(`Generating ${formats.length} format(s) in parallel`, { platform: opts.platform, formats });

  // Generate all formats in parallel — cuts total time from N*120s to ~120s
  const settled = await Promise.allSettled(
    formats.map((format, idx) => {
      log.info(`Starting image generation for format: ${format}`, { platform: opts.platform, formatIndex: idx + 1, totalFormats: formats.length });
      return Promise.race([
        generateImage({
          ...opts,
          prompt: `${opts.prompt}. Professional advertising quality for ${format.replace(/_/g, ' ')} format. Polished ad design with bold headline text and CTA elements clearly visible.`,
          format,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Image generation timed out for format ${format} after ${PER_FORMAT_TIMEOUT_MS / 1000}s`)), PER_FORMAT_TIMEOUT_MS)
        ),
      ]);
    })
  );

  // Map settled results back in format order
  const results = settled.map((outcome, idx) => {
    const format = formats[idx];
    if (outcome.status === 'fulfilled') {
      log.info(`Image generated for format: ${format}`, { provider: outcome.value.provider });
      return outcome.value;
    }
    log.error(`All providers failed for format ${format}`, { error: outcome.reason?.message });
    return { format, error: outcome.reason?.message || 'Unknown error', provider: 'none' };
  });

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
