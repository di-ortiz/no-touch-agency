import axios from 'axios';
import { askClaude } from '../api/anthropic.js';
import * as metaAdLibrary from '../api/meta-ad-library.js';
import { getClient } from './knowledge-base.js';
import { loadBrandDNA, buildBrandContext } from '../brand-dna.js';
import logger from '../utils/logger.js';

const log = logger.child({ service: 'creative-quality-validator' });

// ============================================================
// Image → Base64 Conversion
// ============================================================

/**
 * Fetch an image URL and return base64 data for Claude Vision.
 * Handles both URLs and already-base64 data.
 */
async function imageToBase64(imageData) {
  // Already base64
  if (imageData.base64) return imageData.base64;

  // Data URI
  if (imageData.url?.startsWith('data:')) {
    const match = imageData.url.match(/base64,(.+)/);
    return match ? match[1] : null;
  }

  // Fetch URL → base64
  try {
    const response = await axios.get(imageData.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return Buffer.from(response.data).toString('base64');
  } catch (e) {
    log.warn('Failed to fetch image for quality validation', { url: imageData.url?.slice(0, 80), error: e.message });
    return null;
  }
}

/**
 * Detect media type from URL or default to jpeg.
 */
function detectMediaType(imageData) {
  const url = imageData.url || '';
  if (url.includes('.png') || url.includes('image/png')) return 'image/png';
  if (url.includes('.webp') || url.includes('image/webp')) return 'image/webp';
  return 'image/jpeg';
}

// ============================================================
// Competitor Benchmark Fetching
// ============================================================

/**
 * Fetch competitor ad visuals for benchmarking.
 *
 * Sources:
 * 1. Meta Ad Library — active competitor ads (snapshot URLs)
 * 2. Client competitor list from knowledge base
 *
 * @param {object} opts
 * @param {string} opts.clientId - Client ID to look up competitors
 * @param {string} opts.industry - Industry for broad search
 * @param {string} opts.searchTerms - Keywords to search
 * @param {number} opts.limit - Max competitor visuals (default: 3)
 * @returns {Array} [{ url, competitorName, source }]
 */
export async function fetchCompetitorBenchmark(opts = {}) {
  const { clientId, industry, searchTerms, limit = 3 } = opts;
  const benchmarks = [];

  try {
    // Try to get competitor list from client record
    let competitors = [];
    if (clientId) {
      try {
        const client = getClient(clientId);
        // Extract competitors from client's competitor_names field if available
        if (client?.competitor_names) {
          competitors = client.competitor_names.split(',').map(n => n.trim()).filter(Boolean);
        }
      } catch (e) {
        // Client not found — proceed without competitor list
      }
    }

    // Search Meta Ad Library for competitor ads
    const searchQueries = [];
    if (competitors.length > 0) {
      searchQueries.push(...competitors.slice(0, 3).map(c => c.name || c));
    } else if (searchTerms) {
      searchQueries.push(searchTerms);
    } else if (industry) {
      searchQueries.push(`${industry} best ads`);
    }

    for (const query of searchQueries.slice(0, 2)) {
      try {
        const results = await metaAdLibrary.searchAds({
          searchTerms: query,
          adActiveStatus: 'ACTIVE',
          limit: 3,
        });

        const parsed = metaAdLibrary.parseAdLibraryResults(results);
        for (const ad of parsed) {
          if (ad.snapshotUrl && benchmarks.length < limit) {
            benchmarks.push({
              url: ad.snapshotUrl,
              competitorName: ad.pageName,
              source: 'meta_ad_library',
              headline: ad.headline,
            });
          }
        }
      } catch (e) {
        log.warn('Failed to fetch competitor ads from Meta Ad Library', { query, error: e.message });
      }
    }
  } catch (e) {
    log.warn('Competitor benchmark fetch failed', { error: e.message });
  }

  log.info(`Fetched ${benchmarks.length} competitor benchmarks`, {
    competitors: benchmarks.map(b => b.competitorName),
  });

  return benchmarks;
}

// ============================================================
// Quality Scoring via Claude Vision
// ============================================================

/**
 * Score image candidates using Claude Vision.
 *
 * Evaluates each candidate on 4 dimensions (0-25 each, total 0-100):
 *   - Composition: Visual hierarchy, focal point, professional look
 *   - Brand Fit: Color alignment, mood match, industry appropriateness
 *   - Scroll-Stopping Power: Would this make someone pause? Contrast, uniqueness, emotion
 *   - Text-Overlay Readiness: Clean areas for headline/CTA, no clutter in lower third
 *
 * @param {object} opts
 * @param {Array} opts.candidates - Generated image candidates [{ url, base64, provider, format }]
 * @param {object} opts.brandGuidelines - { colors, voice, industry, name }
 * @param {Array} opts.competitorVisuals - Competitor benchmark images [{ url, competitorName }]
 * @param {string} opts.prompt - Original image generation prompt (for relevance check)
 * @param {string} opts.clientId - Client ID for cost tracking
 * @param {string} opts.workflow - Workflow name
 * @returns {object} { scored: Array, best: object, avgScore: number, competitorBenchmarkScore: number }
 */
export async function scoreImageCandidates(opts = {}) {
  const { candidates = [], brandGuidelines = {}, competitorVisuals = [], prompt = '' } = opts;

  if (candidates.length === 0) {
    return { scored: [], best: null, avgScore: 0, competitorBenchmarkScore: 0 };
  }

  log.info(`Scoring ${candidates.length} candidates against ${competitorVisuals.length} competitor benchmarks`);

  // Build Claude Vision message with all images
  const content = [];

  // Instruction text
  content.push({
    type: 'text',
    text: `You are an expert ad creative director evaluating AI-generated ad visuals. Score each CANDIDATE image on 4 dimensions (0-25 each, total 0-100).

SCORING CRITERIA:
1. COMPOSITION (0-25): Visual hierarchy, focal point, rule of thirds, professional polish, lighting quality. Does this look like it was shot by a professional or designed by an agency?
2. BRAND FIT (0-25): Does it match the brand's industry, audience, and mood? Would it feel at home on the brand's Instagram or website?
3. SCROLL-STOPPING POWER (0-25): Would this make someone stop scrolling on Instagram/Facebook? High contrast, emotional impact, uniqueness, visual intrigue. Generic stock-photo look = low score.
4. TEXT-OVERLAY READINESS (0-25): Is there clean, uncluttered space (especially lower third) where a bold headline and CTA button can be overlaid? Busy backgrounds everywhere = low score.

BRAND CONTEXT:
${brandGuidelines.name ? `Brand: ${brandGuidelines.name}` : ''}
${brandGuidelines.industry ? `Industry: ${brandGuidelines.industry}` : ''}
${brandGuidelines.colors ? `Brand Colors: ${Array.isArray(brandGuidelines.colors) ? brandGuidelines.colors.join(', ') : brandGuidelines.colors}` : ''}
${brandGuidelines.voice ? `Brand Voice: ${brandGuidelines.voice}` : ''}

ORIGINAL PROMPT: ${prompt.slice(0, 500)}

${competitorVisuals.length > 0 ? 'COMPETITOR REFERENCE ADS are shown first for context — these represent the quality bar. Score candidates RELATIVE to this quality level.' : 'No competitor references available — score against general professional ad standards.'}

Return ONLY a JSON object with this structure:
{
  "candidates": [
    {
      "index": 0,
      "composition": <0-25>,
      "brandFit": <0-25>,
      "scrollStopping": <0-25>,
      "textOverlayReady": <0-25>,
      "total": <0-100>,
      "reasoning": "<1-2 sentence explanation>",
      "improvementHint": "<what to change if regenerating>"
    }
  ],
  "competitorAvgScore": <estimated 0-100 score of competitor references if provided, else 0>,
  "bestIndex": <index of highest scoring candidate>
}`,
  });

  // Add competitor reference images first (if available)
  for (let i = 0; i < competitorVisuals.length; i++) {
    const comp = competitorVisuals[i];
    const b64 = await imageToBase64(comp);
    if (b64) {
      content.push({
        type: 'text',
        text: `COMPETITOR REFERENCE ${i + 1} (${comp.competitorName || 'Unknown'}):`,
      });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: detectMediaType(comp),
          data: b64,
        },
      });
    }
  }

  // Add candidate images
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const b64 = await imageToBase64(candidate);
    if (!b64) {
      log.warn(`Could not fetch candidate ${i} for scoring`, { provider: candidate.provider });
      continue;
    }

    content.push({
      type: 'text',
      text: `CANDIDATE ${i} (Provider: ${candidate.providerName || candidate.provider || 'unknown'}):`,
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: detectMediaType(candidate),
        data: b64,
      },
    });
  }

  // Call Claude Vision
  try {
    const response = await askClaude({
      systemPrompt: 'You are an expert ad creative director. You evaluate visual quality with ruthless honesty. Return ONLY valid JSON, no markdown fences.',
      messages: [{ role: 'user', content }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 2048,
      workflow: opts.workflow || 'creative-quality-validation',
      clientId: opts.clientId,
    });

    // Parse scores
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.error('Quality validator returned non-JSON response', { text: response.text.slice(0, 200) });
      return fallbackScoring(candidates);
    }

    const scores = JSON.parse(jsonMatch[0]);
    const scoredCandidates = (scores.candidates || []).map((score, idx) => ({
      ...candidates[score.index ?? idx],
      qualityScore: score.total,
      qualityBreakdown: {
        composition: score.composition,
        brandFit: score.brandFit,
        scrollStopping: score.scrollStopping,
        textOverlayReady: score.textOverlayReady,
      },
      reasoning: score.reasoning,
      improvementHint: score.improvementHint,
    }));

    // Sort by score descending
    scoredCandidates.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

    const avgScore = scoredCandidates.length > 0
      ? Math.round(scoredCandidates.reduce((sum, c) => sum + (c.qualityScore || 0), 0) / scoredCandidates.length)
      : 0;

    log.info('Quality scoring complete', {
      candidates: scoredCandidates.length,
      bestScore: scoredCandidates[0]?.qualityScore,
      bestProvider: scoredCandidates[0]?.providerName || scoredCandidates[0]?.provider,
      avgScore,
      competitorBenchmark: scores.competitorAvgScore || 0,
    });

    return {
      scored: scoredCandidates,
      best: scoredCandidates[0] || null,
      avgScore,
      competitorBenchmarkScore: scores.competitorAvgScore || 0,
    };
  } catch (e) {
    log.error('Quality scoring failed', { error: e.message });
    return fallbackScoring(candidates);
  }
}

/**
 * Fallback scoring when Claude Vision fails — differentiate by provider quality tier.
 */
function fallbackScoring(candidates) {
  const providerScores = {
    'dalle': 65,
    'fal': 60,
    'gemini': 58,
    'kimi': 55,
  };

  const scored = candidates.map((c) => {
    const providerKey = (c.providerKey || c.provider || '').toLowerCase();
    const baseScore = providerScores[providerKey] || 55;
    return {
      ...c,
      qualityScore: baseScore,
      qualityBreakdown: { composition: Math.round(baseScore / 4), brandFit: Math.round(baseScore / 4), scrollStopping: Math.round(baseScore / 4), textOverlayReady: Math.round(baseScore / 4) },
      reasoning: 'Quality validation unavailable — provider-tier score assigned',
      improvementHint: null,
    };
  });

  scored.sort((a, b) => b.qualityScore - a.qualityScore);

  const avgScore = scored.length > 0 ? Math.round(scored.reduce((sum, s) => sum + s.qualityScore, 0) / scored.length) : 0;

  return {
    scored,
    best: scored[0] || null,
    avgScore,
    competitorBenchmarkScore: 0,
  };
}

// ============================================================
// Full Quality-Gated Generation Pipeline
// ============================================================

/**
 * Generate image candidates from multiple providers, score them,
 * and return the best one. Optionally regenerates if quality is too low.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key
 * @param {string} opts.clientId - Client ID
 * @param {object} opts.brandGuidelines - { colors, voice, industry, name }
 * @param {number} opts.qualityThreshold - Min acceptable score (default: 60)
 * @param {number} opts.maxRetries - Max regeneration attempts (default: 1)
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.quality - DALL-E quality setting
 * @param {string} opts.style - DALL-E style setting
 * @param {number} opts.maxCandidates - Max parallel candidates
 * @returns {object} Best image with quality scores attached
 */
export async function generateAndValidate(opts = {}) {
  const { qualityThreshold = 70, maxRetries = 1 } = opts;
  const { generateMultiCandidateImage } = await import('../api/image-router.js');

  let currentPrompt = opts.prompt;
  let attempt = 0;
  let bestResult = null;

  // Fetch competitor benchmarks once (shared across retries)
  let competitorVisuals = [];
  try {
    competitorVisuals = await fetchCompetitorBenchmark({
      clientId: opts.clientId,
      industry: opts.brandGuidelines?.industry,
      searchTerms: opts.brandGuidelines?.name,
      limit: 3,
    });
  } catch (e) {
    log.warn('Competitor benchmark fetch failed — proceeding without benchmarks', { error: e.message });
  }

  while (attempt <= maxRetries) {
    attempt++;
    log.info(`Quality-gated generation attempt ${attempt}/${maxRetries + 1}`, { format: opts.format });

    // Step 1: Generate candidates from all providers
    const { candidates, errors } = await generateMultiCandidateImage({
      ...opts,
      prompt: currentPrompt,
    });

    if (candidates.length === 0) {
      log.error('All providers failed — no candidates to score', { errors });
      if (attempt <= maxRetries) continue;
      throw new Error(`All image providers failed after ${attempt} attempts: ${errors.map(e => e.error).join('; ')}`);
    }

    // Step 2: Score candidates against quality criteria + competitors
    const scoreResult = await scoreImageCandidates({
      candidates,
      brandGuidelines: opts.brandGuidelines || {},
      competitorVisuals,
      prompt: currentPrompt,
      clientId: opts.clientId,
      workflow: opts.workflow,
    });

    bestResult = scoreResult;

    // Step 3: Check if best candidate meets quality threshold
    if (scoreResult.best && scoreResult.best.qualityScore >= qualityThreshold) {
      const isMarginal = scoreResult.best.qualityScore < qualityThreshold + 10;
      if (isMarginal) {
        log.warn('Quality threshold met but marginal', {
          score: scoreResult.best.qualityScore,
          threshold: qualityThreshold,
          provider: scoreResult.best.providerName || scoreResult.best.provider,
        });
      } else {
        log.info('Quality threshold met', {
          score: scoreResult.best.qualityScore,
          threshold: qualityThreshold,
          provider: scoreResult.best.providerName || scoreResult.best.provider,
          attempt,
        });
      }
      return {
        ...scoreResult.best,
        wasRegenerated: attempt > 1,
        totalCandidatesEvaluated: candidates.length,
        competitorBenchmarkScore: scoreResult.competitorBenchmarkScore,
        allScores: scoreResult.scored.map(s => ({
          provider: s.providerName || s.provider,
          score: s.qualityScore,
        })),
      };
    }

    // Step 4: Below threshold — refine prompt and retry
    if (attempt <= maxRetries && scoreResult.best?.improvementHint) {
      log.info('Quality below threshold, regenerating with refined prompt', {
        bestScore: scoreResult.best.qualityScore,
        threshold: qualityThreshold,
        hint: scoreResult.best.improvementHint,
      });
      currentPrompt = `${opts.prompt}. IMPORTANT IMPROVEMENT: ${scoreResult.best.improvementHint}`;
    }
  }

  // Return best we have even if below threshold
  if (bestResult?.best) {
    log.warn('Returning best candidate despite being below quality threshold', {
      score: bestResult.best.qualityScore,
      threshold: qualityThreshold,
    });
    return {
      ...bestResult.best,
      belowThreshold: true,
      wasRegenerated: attempt > 1,
      totalCandidatesEvaluated: bestResult.scored.length,
      competitorBenchmarkScore: bestResult.competitorBenchmarkScore,
      allScores: bestResult.scored.map(s => ({
        provider: s.providerName || s.provider,
        score: s.qualityScore,
      })),
    };
  }

  throw new Error('Quality-gated generation failed — no candidates produced');
}

export default {
  fetchCompetitorBenchmark,
  scoreImageCandidates,
  generateAndValidate,
};
