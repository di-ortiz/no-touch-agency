import * as openaiMedia from './openai-media.js';
import * as fal from './fal.js';
import * as gemini from './gemini.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ platform: 'image-router' });

/**
 * Image generation router with two modes:
 *
 * 1. **Multi-provider** (default for ad creatives):
 *    Generates from ALL configured providers in parallel.
 *    Client sees images from ChatGPT, Gemini, and Flux side-by-side to pick favourites.
 *
 * 2. **Fallback** (for internal/single-image needs):
 *    Tries providers in priority order, falls back on failure.
 *
 * Providers:
 *   - OpenAI (gpt-image-1)  — best photorealism
 *   - Gemini (Imagen 4)     — Google's model, good variety
 *   - fal.ai (Flux Pro)     — fast, artistic/stylized
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

// Provider display names for WhatsApp captions
const PROVIDER_LABELS = {
  openai: 'ChatGPT',
  fal:    'Flux Pro',
  gemini: 'Gemini',
};

/**
 * Get ordered list of available providers (configured + not cooling down).
 * @param {string} [preferred] - Preferred provider to try first
 */
function getAvailableProviders(preferred) {
  const all = [
    { key: 'openai', name: 'ChatGPT (gpt-image-1)', configured: !!config.OPENAI_API_KEY },
    { key: 'fal', name: 'Flux Pro (fal.ai)', configured: fal.isConfigured() },
    { key: 'gemini', name: 'Imagen 4 (Gemini)', configured: gemini.isConfigured() },
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
 */
function isFallbackError(error) {
  const msg = (error.message || '').toLowerCase();
  const status = error.status || error.response?.status;

  if (status === 429) return true;
  if (msg.includes('rate_limit') || msg.includes('quota') || msg.includes('billing')) return true;
  if (status === 401 || status === 403) return true;
  if (msg.includes('api_key') || msg.includes('not configured') || msg.includes('unauthorized')) return true;
  if (status === 404) return true;
  if (msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) return true;
  if (msg.includes('safety') || msg.includes('content_policy') || msg.includes('blocked')) return true;
  if (status >= 500) return true;

  return false;
}

/**
 * Generate an image from a single provider.
 * @param {string} providerKey - 'openai', 'fal', 'gemini'
 * @param {object} opts - Generation options (prompt, format, etc.)
 * @returns {object} { url, base64, mimeType, format, dimensions, provider }
 */
async function generateFromProvider(providerKey, opts) {
  switch (providerKey) {
    case 'openai':
      return openaiMedia.generateImage({
        prompt: opts.prompt,
        format: opts.format || 'general',
        quality: opts.quality || 'high',
        model: opts.openaiModel || 'gpt-image-1',
        workflow: opts.workflow,
        clientId: opts.clientId,
      });

    case 'fal':
      return fal.generateImage({
        prompt: opts.prompt,
        format: opts.format || 'general',
        workflow: opts.workflow,
        clientId: opts.clientId,
      });

    case 'gemini':
      return gemini.generateImage({
        prompt: opts.prompt,
        format: opts.format || 'general',
        workflow: opts.workflow,
        clientId: opts.clientId,
      });

    default:
      throw new Error(`Unknown provider: ${providerKey}`);
  }
}

// ============================================================
// Single Image Generation with Fallback
// ============================================================

/**
 * Generate a single image, trying providers in priority order.
 * Used for internal needs (landing pages, single creatives).
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
      const result = await generateFromProvider(provider.key, opts);
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
      throw error;
    }
  }

  throw lastError || new Error('All image generation providers failed');
}

// ============================================================
// Multi-Provider Parallel Generation (for client comparison)
// ============================================================

const PER_PROVIDER_TIMEOUT_MS = 120_000; // 120s max per provider

/**
 * Generate images from ALL available providers in parallel for a single format.
 * Returns one image per provider — client picks their favourite.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {Array} Array of { url, base64, mimeType, format, dimensions, provider, providerLabel, error }
 */
export async function generateFromAllProviders(opts = {}) {
  const providers = getAvailableProviders();

  if (providers.length === 0) {
    throw new Error('No image generation providers available. Configure at least one of: OPENAI_API_KEY, FAL_API_KEY, or GEMINI_API_KEY.');
  }

  const format = opts.format || 'general';
  const formatLabel = format.replace(/_/g, ' ');
  const prompt = `${opts.prompt}. Professional advertising quality for ${formatLabel} format. Clean composition with space for text overlay in the lower third.`;

  log.info(`Multi-provider generation: ${providers.length} providers for format ${format}`, {
    providers: providers.map(p => p.key),
  });

  const settled = await Promise.allSettled(
    providers.map(provider =>
      Promise.race([
        generateFromProvider(provider.key, { ...opts, prompt, format }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${provider.name} timed out after ${PER_PROVIDER_TIMEOUT_MS / 1000}s`)), PER_PROVIDER_TIMEOUT_MS)
        ),
      ])
    )
  );

  const results = settled.map((outcome, idx) => {
    const provider = providers[idx];
    if (outcome.status === 'fulfilled') {
      recordProviderSuccess(provider.key);
      log.info(`Multi-provider: ${provider.name} succeeded`, { format });
      return {
        ...outcome.value,
        provider: provider.key,
        providerLabel: PROVIDER_LABELS[provider.key] || provider.name,
      };
    }
    log.warn(`Multi-provider: ${provider.name} failed`, { error: outcome.reason?.message, format });
    if (isFallbackError(outcome.reason)) {
      recordProviderFailure(provider.key);
    }
    return {
      format,
      provider: provider.key,
      providerLabel: PROVIDER_LABELS[provider.key] || provider.name,
      error: outcome.reason?.message || 'Unknown error',
    };
  });

  return results;
}

// ============================================================
// Multi-Format Ad Image Generation with Fallback (legacy)
// ============================================================

/**
 * Generate ad images for multiple platform formats, with per-image fallback.
 * Used when you only need one image per format (not multi-provider comparison).
 */
export async function generateAdImages(opts = {}) {
  const PLATFORM_DEFAULTS = {
    meta:      ['meta_feed', 'meta_square', 'meta_story'],
    instagram: ['instagram_feed', 'instagram_story'],
    google:    ['google_display', 'google_square'],
    tiktok:    ['tiktok'],
  };

  const formats = opts.formats || PLATFORM_DEFAULTS[opts.platform] || ['general'];

  log.info(`Generating ${formats.length} format(s) in parallel`, { platform: opts.platform, formats });

  const settled = await Promise.allSettled(
    formats.map((format) => {
      log.info(`Starting image generation for format: ${format}`, { platform: opts.platform });
      return Promise.race([
        generateImage({
          ...opts,
          prompt: `${opts.prompt}. Professional advertising quality for ${format.replace(/_/g, ' ')} format. Clean composition with space for text overlay in the lower third.`,
          format,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Image generation timed out for format ${format} after 180s`)), 180_000)
        ),
      ]);
    })
  );

  return settled.map((outcome, idx) => {
    const format = formats[idx];
    if (outcome.status === 'fulfilled') {
      log.info(`Image generated for format: ${format}`, { provider: outcome.value.provider });
      return outcome.value;
    }
    log.error(`All providers failed for format ${format}`, { error: outcome.reason?.message });
    return { format, error: outcome.reason?.message || 'Unknown error', provider: 'none' };
  });
}

// ============================================================
// Multi-Provider Ad Image Generation (for client comparison)
// ============================================================

/**
 * Generate ad images from ALL providers for a single format, in parallel.
 * Returns one image per provider so the client can compare and pick.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Base image prompt
 * @param {string} opts.format - Single format key (default: 'general')
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {Array} Array of generated images, one per provider
 */
export async function generateMultiProviderImages(opts = {}) {
  return generateFromAllProviders(opts);
}

// ============================================================
// Provider Status
// ============================================================

/**
 * Get current status of all image generation providers.
 */
export function getProviderStatus() {
  return {
    openai: { configured: !!config.OPENAI_API_KEY, coolingDown: isProviderCoolingDown('openai') },
    fal:    { configured: fal.isConfigured(), coolingDown: isProviderCoolingDown('fal') },
    gemini: { configured: gemini.isConfigured(), coolingDown: isProviderCoolingDown('gemini') },
  };
}

export { PROVIDER_LABELS };

export default { generateImage, generateAdImages, generateFromAllProviders, generateMultiProviderImages, getProviderStatus, PROVIDER_LABELS };
