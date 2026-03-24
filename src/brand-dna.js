import logger from './utils/logger.js';
import { askClaude } from './api/anthropic.js';
import * as firecrawl from './api/firecrawl.js';
import { getClient, updateClient } from './services/knowledge-base.js';

const log = logger.child({ workflow: 'brand-dna' });

/**
 * Extract Brand DNA from a website URL using Firecrawl + Claude Haiku.
 * Returns a structured JSON profile for consistent on-brand creative generation.
 *
 * @param {string} websiteUrl - The client's website URL
 * @param {string} [clientId] - Optional client ID to auto-save Brand DNA
 * @returns {object} Brand DNA JSON
 */
export async function extractBrandDNA(websiteUrl, clientId = null) {
  log.info('Extracting Brand DNA from website', { websiteUrl, clientId });

  // Step 1: Scrape the website with Firecrawl
  let pageContent;
  try {
    const result = await firecrawl.scrape(websiteUrl, {
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30000,
    });
    pageContent = result.markdown || '';

    // Truncate to avoid token overload (keep first 8000 chars)
    if (pageContent.length > 8000) {
      pageContent = pageContent.slice(0, 8000);
    }

    log.info('Website scraped for Brand DNA', { url: websiteUrl, contentLength: pageContent.length });
  } catch (e) {
    log.error('Failed to scrape website for Brand DNA', { error: e.message, url: websiteUrl });
    throw new Error(`Não consegui acessar o site ${websiteUrl}. Verifique se o URL está correto.`);
  }

  if (!pageContent || pageContent.length < 50) {
    throw new Error(`O site ${websiteUrl} retornou pouco conteúdo. Verifique se o URL está correto.`);
  }

  // Step 2: Use Claude Haiku to analyze and extract structured Brand DNA
  const response = await askClaude({
    systemPrompt: 'You are a brand strategist. Analyze the following website content and extract a structured Brand DNA profile in JSON format only. No explanation, no markdown — pure JSON. Fields: business_name, tagline, primary_colors (extract from any color mentions or CSS references if available), tone_of_voice (1 sentence), target_audience (1 sentence), main_products_or_services (array of strings), key_differentiators (array of strings), cta_style (e.g. "urgent", "friendly", "professional"), language, emoji_usage (boolean), formality_level.',
    userMessage: `Analyze this website content and extract the Brand DNA profile:\n\nURL: ${websiteUrl}\n\nCONTENT:\n${pageContent}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'brand-dna-extraction',
    clientId,
  });

  // Step 3: Parse the JSON response
  let brandDNA;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    brandDNA = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    log.error('Failed to parse Brand DNA JSON', { text: response.text?.slice(0, 200) });
    throw new Error('Não consegui analisar o site corretamente. Tente novamente.');
  }

  if (!brandDNA) {
    throw new Error('Extração de Brand DNA retornou vazio.');
  }

  // Ensure required fields have defaults
  brandDNA.primary_colors = brandDNA.primary_colors || [];
  brandDNA.main_products_or_services = brandDNA.main_products_or_services || [];
  brandDNA.key_differentiators = brandDNA.key_differentiators || [];
  brandDNA.emoji_usage = brandDNA.emoji_usage ?? true;
  brandDNA.formality_level = brandDNA.formality_level || 'semi-formal';
  brandDNA.extracted_from = websiteUrl;
  brandDNA.extracted_at = new Date().toISOString();

  log.info('Brand DNA extracted successfully', {
    businessName: brandDNA.business_name,
    colors: brandDNA.primary_colors?.length,
    products: brandDNA.main_products_or_services?.length,
  });

  // Step 4: Auto-save to client if clientId provided
  if (clientId) {
    saveBrandDNA(clientId, brandDNA);
  }

  return brandDNA;
}

/**
 * Build Brand DNA from a short interview (when client has no website).
 * Uses Claude Haiku to structure the answers into Brand DNA format.
 *
 * @param {object} answers - Interview answers
 * @param {string} answers.businessName - Business name
 * @param {string} answers.productService - Main product/service
 * @param {string} answers.targetAudience - Target audience
 * @param {string} answers.tonePreference - Tone preference (formal, casual, etc.)
 * @param {string} [clientId] - Optional client ID to auto-save
 * @returns {object} Brand DNA JSON
 */
export async function buildBrandDNAFromInterview(answers, clientId = null) {
  log.info('Building Brand DNA from interview', { businessName: answers.businessName });

  const response = await askClaude({
    systemPrompt: 'You are a brand strategist. Based on the business information provided, create a structured Brand DNA profile in JSON format only. No explanation, no markdown — pure JSON. Fields: business_name, tagline (create a suggested one), primary_colors (suggest 2-3 professional colors as hex codes based on the industry), tone_of_voice (1 sentence), target_audience (1 sentence), main_products_or_services (array of strings), key_differentiators (array of strings), cta_style, language, emoji_usage (boolean), formality_level.',
    userMessage: `Create a Brand DNA profile for this business:\n\nBusiness Name: ${answers.businessName}\nProduct/Service: ${answers.productService}\nTarget Audience: ${answers.targetAudience}\nTone Preference: ${answers.tonePreference}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'brand-dna-interview',
    clientId,
  });

  let brandDNA;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    brandDNA = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    log.error('Failed to parse Brand DNA from interview', { text: response.text?.slice(0, 200) });
    throw new Error('Não consegui criar o perfil da marca. Tente novamente.');
  }

  if (!brandDNA) {
    throw new Error('Criação de Brand DNA retornou vazio.');
  }

  brandDNA.primary_colors = brandDNA.primary_colors || [];
  brandDNA.main_products_or_services = brandDNA.main_products_or_services || [];
  brandDNA.key_differentiators = brandDNA.key_differentiators || [];
  brandDNA.emoji_usage = brandDNA.emoji_usage ?? true;
  brandDNA.formality_level = brandDNA.formality_level || 'semi-formal';
  brandDNA.source = 'interview';
  brandDNA.extracted_at = new Date().toISOString();

  if (clientId) {
    saveBrandDNA(clientId, brandDNA);
  }

  log.info('Brand DNA built from interview', { businessName: brandDNA.business_name });
  return brandDNA;
}

/**
 * Save Brand DNA JSON to the client record in the knowledge base.
 */
export function saveBrandDNA(clientId, brandDNA) {
  try {
    updateClient(clientId, { brand_dna: JSON.stringify(brandDNA) });
    log.info('Brand DNA saved to client', { clientId });
  } catch (e) {
    log.error('Failed to save Brand DNA', { clientId, error: e.message });
  }
}

/**
 * Load Brand DNA for a client. Returns parsed JSON or null.
 */
export function loadBrandDNA(clientId) {
  const client = getClient(clientId);
  if (!client?.brand_dna) return null;
  try {
    return JSON.parse(client.brand_dna);
  } catch {
    return null;
  }
}

/**
 * Build a brand context string to inject into creative generation prompts.
 *
 * @param {object} brandDNA - The Brand DNA JSON object
 * @returns {string} Brand context string for prompt injection
 */
export function buildBrandContext(brandDNA) {
  if (!brandDNA) return '';

  const parts = [];
  if (brandDNA.business_name) parts.push(`Brand: ${brandDNA.business_name}`);
  if (brandDNA.tone_of_voice) parts.push(`Tone: ${brandDNA.tone_of_voice}`);
  if (brandDNA.target_audience) parts.push(`Target audience: ${brandDNA.target_audience}`);
  if (brandDNA.primary_colors?.length > 0) parts.push(`Brand colors: ${brandDNA.primary_colors.join(', ')}`);
  if (brandDNA.formality_level) parts.push(`Style: ${brandDNA.formality_level}`);
  if (brandDNA.emoji_usage !== undefined) parts.push(brandDNA.emoji_usage ? 'Use emojis' : 'No emojis');
  if (brandDNA.cta_style) parts.push(`CTA style: ${brandDNA.cta_style}`);
  if (brandDNA.key_differentiators?.length > 0) parts.push(`Differentiators: ${brandDNA.key_differentiators.join(', ')}`);

  return `Brand context: ${parts.join('. ')}.`;
}

/**
 * Generate ad copy text separately from the image using Claude Haiku.
 * Returns structured JSON with headline, subtext, and CTA.
 *
 * @param {object} brandDNA - The Brand DNA JSON object
 * @param {object} context - Creative context
 * @param {string} context.product - Product or service being advertised
 * @param {string} context.goal - Campaign goal (awareness, conversion, promotion)
 * @param {string} [context.audience] - Override target audience
 * @param {string} [context.language] - Language (default: pt-BR)
 * @returns {object} { headline, subtext, cta }
 */
export async function generateAdCopy(brandDNA, context = {}) {
  const language = context.language || brandDNA?.language || 'pt-BR';

  const brandContext = buildBrandContext(brandDNA);
  const product = context.product || brandDNA?.main_products_or_services?.[0] || 'o produto';
  const goal = context.goal || 'conversion';
  const audience = context.audience || brandDNA?.target_audience || '';

  log.info('Generating ad copy', { product, goal, language });

  const response = await askClaude({
    systemPrompt: `You are an expert Brazilian digital marketing copywriter. Write high-converting ad copy in Brazilian Portuguese using proven frameworks (AIDA, PAS, or direct benefit). Return ONLY valid JSON with these exact fields: headline (max 8 words, punchy and attention-grabbing), subtext (max 15 words, benefit-focused), cta (max 4 words, action verb first). No markdown, no explanation — pure JSON only.`,
    userMessage: `Generate ad copy for this creative:\n\n${brandContext}\nProduct/Service: ${product}\nCampaign Goal: ${goal}\n${audience ? `Target Audience: ${audience}` : ''}\nLanguage: ${language}\n\nReturn JSON with: headline, subtext, cta`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    workflow: 'ad-copy-generation',
  });

  let adCopy;
  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    adCopy = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    log.error('Failed to parse ad copy JSON', { text: response.text?.slice(0, 200) });
    // Fallback copy
    adCopy = {
      headline: 'Transforme Seu Negócio Hoje',
      subtext: 'Resultados reais para quem quer crescer de verdade',
      cta: 'Saiba Mais',
    };
  }

  if (!adCopy) {
    adCopy = {
      headline: 'Transforme Seu Negócio Hoje',
      subtext: 'Resultados reais para quem quer crescer de verdade',
      cta: 'Saiba Mais',
    };
  }

  log.info('Ad copy generated', { headline: adCopy.headline });
  return adCopy;
}

export default {
  extractBrandDNA,
  buildBrandDNAFromInterview,
  saveBrandDNA,
  loadBrandDNA,
  buildBrandContext,
  generateAdCopy,
};
