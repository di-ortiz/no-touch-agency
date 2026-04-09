import * as openaiMedia from './openai-media.js';
import * as fal from './fal.js';
import * as gemini from './gemini.js';
import * as kimi from './kimi.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ platform: 'image-router' });

/**
 * Image generation router with smart provider fallback + multi-candidate mode.
 *
 * SINGLE MODE (default): Sequential fallback — first provider that succeeds wins.
 * MULTI-CANDIDATE MODE: Fires all providers in parallel, collects candidates,
 *   then a quality validator picks the best one.
 *
 * Providers:
 *   1. fal.ai      (Flux Pro + Nano Banana 2 + Flux 2 Flex)
 *   2. DALL-E 3    (OpenAI)
 *   3. Imagen 3    (Gemini)
 *   4. Kimi 2.5    (Moonshot AI)
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

// ============================================================
// Provider Registry
// ============================================================

/**
 * Each provider entry has a key, display name, configured check, and a generate function.
 * The generate function has a unified interface: (opts) => Promise<{ url, format, dimensions, provider, model }>
 */
function buildProviderRegistry() {
  return [
    {
      key: 'fal',
      name: 'Flux Pro (fal.ai)',
      configured: fal.isConfigured(),
      generate: (opts) => fal.generateImage(opts),
    },
    {
      key: 'fal-nanobanana2',
      name: 'Nano Banana 2 (fal.ai)',
      configured: fal.isConfigured(),
      generate: (opts) => fal.generateImageWithModel('fal-ai/nano-banana-2', opts),
    },
    {
      key: 'fal-flux2flex',
      name: 'Flux 2 Flex (fal.ai)',
      configured: fal.isConfigured(),
      generate: (opts) => fal.generateImageWithModel('fal-ai/flux-2-flex', opts),
    },
    {
      key: 'dalle',
      name: 'DALL-E 3',
      configured: !!config.OPENAI_API_KEY,
      generate: async (opts) => {
        const result = await openaiMedia.generateImage({
          ...opts,
          quality: opts.quality || 'hd',
          style: opts.style || 'natural',
        });
        result.provider = 'dalle';
        return result;
      },
    },
    {
      key: 'gemini',
      name: 'Imagen 3 (Gemini)',
      configured: gemini.isConfigured(),
      generate: (opts) => gemini.generateImage(opts),
    },
    {
      key: 'kimi',
      name: 'Kimi 2.5 (Moonshot)',
      configured: kimi.isConfigured(),
      generate: (opts) => kimi.generateImage(opts),
    },
  ];
}

/**
 * Get ordered list of available providers (configured + not cooling down).
 * For single mode: deduplicates fal sub-providers into one "fal" entry (races internally).
 * @param {string} [preferred] - Preferred provider to try first
 */
function getAvailableProviders(preferred) {
  // For sequential fallback, use the main entry per provider (fal races internally)
  const all = [
    { key: 'fal', name: 'Flux (fal.ai)', configured: fal.isConfigured() },
    { key: 'dalle', name: 'DALL-E 3', configured: !!config.OPENAI_API_KEY },
    { key: 'gemini', name: 'Imagen 3 (Gemini)', configured: gemini.isConfigured() },
    { key: 'kimi', name: 'Kimi 2.5 (Moonshot)', configured: kimi.isConfigured() },
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
 * Get all distinct candidate providers for multi-candidate mode.
 * Each fal model is a separate candidate source.
 */
function getMultiCandidateProviders() {
  const registry = buildProviderRegistry();
  return registry.filter(p => p.configured && !isProviderCoolingDown(p.key));
}

/**
 * Check if an error indicates we should try the next provider.
 */
function isFallbackError(error) {
  const msg = (error.message || '').toLowerCase();
  const promptErrors = ['invalid_prompt', 'prompt_too_long', 'bad_request'];
  for (const pe of promptErrors) {
    if (msg.includes(pe)) return false;
  }
  return true;
}

// ============================================================
// Single Image Generation with Fallback (existing behavior)
// ============================================================

/**
 * Generate a single image, trying providers in priority order.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.quality - 'standard' or 'hd' (DALL-E only)
 * @param {string} opts.style - 'vivid' or 'natural' (DALL-E only)
 * @param {string} opts.preferred - Preferred provider: 'dalle', 'fal', 'gemini', 'kimi'
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  const providers = getAvailableProviders(opts.preferred);

  if (providers.length === 0) {
    throw new Error('No image generation providers available. Configure at least one of: OPENAI_API_KEY, FAL_API_KEY, GEMINI_API_KEY, or KIMI_API_KEY.');
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
            mode: opts.mode || 'standard',
            seed: opts.seed,
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

        case 'kimi':
          result = await kimi.generateImage({
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

      throw error;
    }
  }

  throw lastError || new Error('All image generation providers failed');
}

// ============================================================
// Multi-Candidate Image Generation (NEW)
// ============================================================

/**
 * Generate images from ALL available providers in parallel, returning
 * all successful candidates for quality validation.
 *
 * Unlike generateImage() which stops at the first success, this fires
 * all providers simultaneously and collects every result.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.quality - 'standard' or 'hd' (DALL-E only)
 * @param {string} opts.style - 'vivid' or 'natural' (DALL-E only)
 * @param {number} opts.maxCandidates - Max candidates to generate (default: all available)
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {object} { candidates: Array, errors: Array }
 */
export async function generateMultiCandidateImage(opts = {}) {
  const providers = getMultiCandidateProviders();
  const maxCandidates = opts.maxCandidates || providers.length;
  const selected = providers.slice(0, maxCandidates);
  const PER_PROVIDER_TIMEOUT_MS = 90_000;

  if (selected.length === 0) {
    throw new Error('No image generation providers available for multi-candidate generation.');
  }

  log.info(`Multi-candidate generation: firing ${selected.length} providers in parallel`, {
    providers: selected.map(p => p.name),
    format: opts.format,
  });

  const settled = await Promise.allSettled(
    selected.map(provider => {
      const genOpts = {
        prompt: opts.prompt,
        format: opts.format || 'general',
        quality: opts.quality || 'hd',
        style: opts.style || 'natural',
        workflow: opts.workflow || 'multi-candidate-generation',
        clientId: opts.clientId,
      };

      return Promise.race([
        provider.generate(genOpts).then(result => {
          recordProviderSuccess(provider.key);
          return { ...result, providerKey: provider.key, providerName: provider.name };
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${provider.name} timed out after ${PER_PROVIDER_TIMEOUT_MS / 1000}s`)), PER_PROVIDER_TIMEOUT_MS)
        ),
      ]);
    })
  );

  const candidates = [];
  const errors = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const provider = selected[i];

    if (outcome.status === 'fulfilled') {
      candidates.push(outcome.value);
      log.info(`Candidate received from ${provider.name}`, { format: opts.format });
    } else {
      recordProviderFailure(provider.key);
      errors.push({
        provider: provider.key,
        providerName: provider.name,
        error: outcome.reason?.message || 'Unknown error',
      });
      log.warn(`${provider.name} failed in multi-candidate mode`, { error: outcome.reason?.message });
    }
  }

  log.info(`Multi-candidate generation complete`, {
    candidates: candidates.length,
    errors: errors.length,
    providers: candidates.map(c => c.providerName),
  });

  return { candidates, errors };
}

// ============================================================
// Multi-Format Ad Image Generation with Fallback
// ============================================================

/**
 * Generate ad images for multiple platform formats.
 *
 * Supports two modes:
 * - Standard (default): Sequential fallback per format, first success wins
 * - Multi-candidate (opts.multiCandidate=true): All providers per format, returns
 *   candidates array for each format (for quality validation downstream)
 *
 * @param {object} opts
 * @param {string} opts.prompt - Base image prompt
 * @param {string} opts.platform - Platform key ('meta', 'instagram', 'google', 'tiktok')
 * @param {string[]} opts.formats - Specific format keys (optional)
 * @param {boolean} opts.multiCandidate - Enable multi-candidate mode
 * @param {number} opts.maxCandidates - Max candidates per format (multi-candidate mode)
 * @param {string} opts.quality - 'standard' or 'hd'
 * @param {string} opts.style - 'vivid' or 'natural'
 * @param {string} opts.preferred - Preferred provider
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {Array} Array of generated images (or candidate sets) with metadata
 */
export async function generateAdImages(opts = {}) {
  const PLATFORM_DEFAULTS = {
    meta:      ['meta_feed', 'meta_square', 'meta_story'],
    instagram: ['instagram_feed', 'instagram_story'],
    google:    ['google_display', 'google_square'],
    tiktok:    ['tiktok'],
  };

  const formats = opts.formats || PLATFORM_DEFAULTS[opts.platform] || ['general'];
  const PER_FORMAT_TIMEOUT_MS = opts.multiCandidate ? 120_000 : 90_000;

  log.info(`Generating ${formats.length} format(s) in parallel`, {
    platform: opts.platform,
    formats,
    multiCandidate: !!opts.multiCandidate,
  });

  const settled = await Promise.allSettled(
    formats.map((format, idx) => {
      const formatPrompt = `${opts.prompt}. Professional advertising quality for ${format.replace(/_/g, ' ')} format. CRITICAL: No text, no words, no letters, no numbers, no typography, no captions, no screens, no monitors, no dashboards, no charts, no UI elements. Pure visual scene only — clean background with space for text overlay.`;

      log.info(`Starting image generation for format: ${format}`, {
        platform: opts.platform,
        formatIndex: idx + 1,
        totalFormats: formats.length,
        multiCandidate: !!opts.multiCandidate,
      });

      const genPromise = opts.multiCandidate
        ? generateMultiCandidateImage({
            ...opts,
            prompt: formatPrompt,
            format,
          })
        : generateImage({
            ...opts,
            prompt: formatPrompt,
            format,
          });

      return Promise.race([
        genPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Image generation timed out for format ${format} after ${PER_FORMAT_TIMEOUT_MS / 1000}s`)), PER_FORMAT_TIMEOUT_MS)
        ),
      ]);
    })
  );

  const results = settled.map((outcome, idx) => {
    const format = formats[idx];
    if (outcome.status === 'fulfilled') {
      const value = outcome.value;
      if (opts.multiCandidate) {
        // Multi-candidate mode returns { candidates, errors }
        log.info(`Multi-candidate: ${value.candidates?.length || 0} candidates for format ${format}`);
        return { format, ...value };
      }
      log.info(`Image generated for format: ${format}`, { provider: value.provider });
      return value;
    }
    log.error(`All providers failed for format ${format}`, { error: outcome.reason?.message });
    return { format, error: outcome.reason?.message || 'Unknown error', provider: 'none' };
  });

  return results;
}

// ============================================================
// Tiered Image Generation (cost-efficient with early exit)
// ============================================================

/**
 * Provider tiers ordered by quality/cost ratio.
 * Tier 1 fires first; if score is high enough, skip remaining tiers.
 */
const PROVIDER_TIERS = [
  {
    name: 'Tier 1 (Premium)',
    keys: ['fal', 'fal-nanobanana2'],         // Flux Pro + Nano Banana 2 (~5¢)
    exitThreshold: 80,                          // Skip rest if best ≥ 80
  },
  {
    name: 'Tier 2 (Quality)',
    keys: ['dalle', 'fal-flux2flex'],           // DALL-E 3 + Flux 2 Flex (~12¢)
    exitThreshold: 75,                          // Skip rest if best ≥ 75
  },
  {
    name: 'Tier 3 (Budget/Variety)',
    keys: ['gemini', 'kimi'],                   // Imagen 3 + Kimi 2.5 (~8¢)
    exitThreshold: 0,                           // Always return after Tier 3
  },
];

/**
 * Generate an image using tiered providers with early exit.
 * Fires Tier 1 first (cheapest/best), scores, and only fires Tier 2/3
 * if quality is below threshold. Saves 60-70% on average vs firing all.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key
 * @param {Function} opts.scoreFunction - Async function to score candidates, returns { scored, best }
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {object} { candidates, best, tiersUsed, totalCost }
 */
export async function generateTieredImage(opts = {}) {
  const registry = buildProviderRegistry();
  const registryMap = Object.fromEntries(registry.map(p => [p.key, p]));
  const PER_PROVIDER_TIMEOUT_MS = 60_000;

  let allCandidates = [];
  let allErrors = [];
  let tiersUsed = 0;
  let best = null;

  for (const tier of PROVIDER_TIERS) {
    tiersUsed++;

    // Get available providers for this tier
    const tierProviders = tier.keys
      .map(key => registryMap[key])
      .filter(p => p && p.configured && !isProviderCoolingDown(p.key));

    if (tierProviders.length === 0) {
      log.info(`${tier.name}: no available providers, skipping`, { keys: tier.keys });
      continue;
    }

    log.info(`${tier.name}: firing ${tierProviders.length} providers`, {
      providers: tierProviders.map(p => p.name),
      format: opts.format,
      candidatesSoFar: allCandidates.length,
    });

    // Fire tier providers in parallel
    const genOpts = {
      prompt: opts.prompt,
      format: opts.format || 'general',
      quality: opts.quality || 'hd',
      style: opts.style || 'natural',
      mode: opts.mode || 'standard',
      workflow: opts.workflow || 'tiered-generation',
      clientId: opts.clientId,
    };

    const settled = await Promise.allSettled(
      tierProviders.map(provider =>
        Promise.race([
          provider.generate(genOpts).then(result => {
            recordProviderSuccess(provider.key);
            return { ...result, providerKey: provider.key, providerName: provider.name };
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${provider.name} timed out`)), PER_PROVIDER_TIMEOUT_MS)
          ),
        ])
      )
    );

    // Collect results
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const provider = tierProviders[i];
      if (outcome.status === 'fulfilled') {
        allCandidates.push(outcome.value);
        log.info(`Candidate from ${provider.name}`, { format: opts.format });
      } else {
        recordProviderFailure(provider.key);
        allErrors.push({ provider: provider.key, error: outcome.reason?.message });
        log.warn(`${provider.name} failed`, { error: outcome.reason?.message });
      }
    }

    // Score current candidates if we have a scoring function
    if (opts.scoreFunction && allCandidates.length > 0) {
      try {
        const scoreResult = await opts.scoreFunction(allCandidates);
        best = scoreResult.best;

        if (best && best.qualityScore >= tier.exitThreshold) {
          log.info(`${tier.name}: quality threshold met, early exit`, {
            score: best.qualityScore,
            threshold: tier.exitThreshold,
            provider: best.providerName,
            tiersUsed,
          });
          break; // Early exit — skip remaining tiers
        }

        log.info(`${tier.name}: below threshold, continuing`, {
          bestScore: best?.qualityScore,
          threshold: tier.exitThreshold,
          tiersUsed,
        });
      } catch (e) {
        log.warn(`${tier.name}: scoring failed, continuing to next tier`, { error: e.message });
      }
    } else if (allCandidates.length > 0 && !opts.scoreFunction) {
      // No scoring function — just return first successful candidate
      best = allCandidates[0];
      break;
    }
  }

  // If scoring was never done (no scoreFunction), pick first candidate
  if (!best && allCandidates.length > 0) {
    best = allCandidates[0];
  }

  log.info('Tiered generation complete', {
    tiersUsed,
    totalCandidates: allCandidates.length,
    totalErrors: allErrors.length,
    bestScore: best?.qualityScore,
    bestProvider: best?.providerName,
  });

  return { candidates: allCandidates, errors: allErrors, best, tiersUsed };
}

// ============================================================
// Provider Status
// ============================================================

/**
 * Get current status of all image generation providers.
 */
export function getProviderStatus() {
  return {
    dalle:        { configured: !!config.OPENAI_API_KEY, coolingDown: isProviderCoolingDown('dalle') },
    fal:           { configured: fal.isConfigured(), coolingDown: isProviderCoolingDown('fal') },
    nanoBanana2:   { configured: fal.isConfigured(), coolingDown: isProviderCoolingDown('fal-nanobanana2') },
    flux2Flex:     { configured: fal.isConfigured(), coolingDown: isProviderCoolingDown('fal-flux2flex') },
    gemini:       { configured: gemini.isConfigured(), coolingDown: isProviderCoolingDown('gemini') },
    kimi:         { configured: kimi.isConfigured(), coolingDown: isProviderCoolingDown('kimi') },
  };
}

export default { generateImage, generateMultiCandidateImage, generateTieredImage, generateAdImages, getProviderStatus };
