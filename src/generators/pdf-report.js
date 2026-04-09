/**
 * Claude-powered PDF Report Generator.
 *
 * Uses Claude Haiku to generate professional HTML, then Puppeteer to convert
 * to PDF, then Supabase Storage for hosting. Returns both the URL and raw
 * buffer for inline WhatsApp/Telegram delivery.
 *
 * Supported report types:
 *   - social_strategy   — Instagram/social media strategy document
 *   - content_calendar  — Visual weekly calendar grid
 *   - competitor_analysis — Competitor landscape report
 *   - monthly_report    — Monthly performance summary
 *   - custom            — Freeform report from user prompt
 */
import fs from 'fs';
import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import * as supaStorage from '../api/supabase-storage.js';

const log = logger.child({ service: 'pdf-generator' });

// Brand colors
const BRAND = {
  primary: '#FF5254',
  dark: '#1a1a2e',
  light: '#f8f9fa',
  accent: '#e94560',
  text: '#2d2d2d',
  muted: '#6c757d',
};

// ============================================================
// System prompts per report type
// ============================================================

const SYSTEM_PROMPTS = {
  base: `You are an expert document designer. Generate a COMPLETE, self-contained HTML document with inline CSS only. The document will be converted to PDF via a headless browser.

DESIGN RULES:
- Use Google Fonts Inter: <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
- Brand colors: primary ${BRAND.primary}, dark ${BRAND.dark}, accent ${BRAND.accent}, background white, text ${BRAND.text}
- Clean, modern design with generous whitespace
- Use CSS page-break-inside: avoid on sections
- All styles MUST be inline or in a <style> tag — no external CSS files
- Tables should have alternating row colors and clean borders
- Use colored section headers with the brand primary color
- Add a footer on each page with the brand name and date
- Page size: A4 portrait
- CRITICAL IMAGE RULE: ONLY use <img> tags with URLs that are explicitly provided in the IMAGE ASSETS section below. NEVER invent, guess, or hallucinate image URLs. If no image URL is provided for a post/section, use a colored placeholder div with an icon emoji instead (e.g., a branded colored box with 📸 or 🎨). Do NOT use src="Carousel" or src="Reel" or any non-URL value.
- DO NOT use JavaScript — only HTML + CSS

Return ONLY the complete HTML document starting with <!DOCTYPE html>. No markdown, no explanation.`,

  content_calendar: `You are an expert document designer creating a VISUAL CONTENT CALENDAR as HTML.

CRITICAL: The calendar must render as a VISUAL WEEKLY GRID — like a real wall calendar — NOT a plain table.

DESIGN:
- Google Fonts Inter
- Brand colors: primary ${BRAND.primary}, dark ${BRAND.dark}, accent ${BRAND.accent}
- Each week is a row with 7 day columns (Mon-Sun)
- Post days show a colored card with: platform icon emoji, post type, and short topic
- Non-post days are light gray
- Month title at top with large bold text
- Legend showing platform colors/icons
- Clean, modern design that looks like a professional social media calendar
- Page size: A4 LANDSCAPE for wider calendar view

Return ONLY the complete HTML document. No markdown.`,

  social_strategy: `You are an expert document designer creating a SOCIAL MEDIA STRATEGY document as HTML.

DESIGN:
- Google Fonts Inter
- Brand colors: primary ${BRAND.primary}, dark ${BRAND.dark}
- Cover page with brand name, strategy title, and date
- Table of contents
- Sections: Executive Summary, Goals & KPIs, Target Audience, Content Pillars, Posting Schedule, Hashtag Strategy, Growth Tactics, Monthly Milestones
- Use icons/emojis as visual markers for sections
- Professional charts/tables for KPIs and schedules
- Page size: A4 portrait

Return ONLY the complete HTML document. No markdown.`,

  competitor_analysis: `You are an expert document designer creating a COMPETITOR ANALYSIS report as HTML.

DESIGN:
- Google Fonts Inter
- Brand colors: primary ${BRAND.primary}, dark ${BRAND.dark}
- Cover page with "Competitor Analysis" title
- Sections: Executive Summary, Competitor Overview Table, Strengths/Weaknesses Matrix, Content Strategy Comparison, Ad Spend Analysis, Opportunities & Gaps, Recommendations
- Use comparison tables with color-coded ratings
- Visual scorecards for each competitor
- Page size: A4 portrait

Return ONLY the complete HTML document. No markdown.`,

  monthly_report: `You are an expert document designer creating a MONTHLY PERFORMANCE REPORT as HTML.

DESIGN:
- Google Fonts Inter
- Brand colors: primary ${BRAND.primary}, dark ${BRAND.dark}
- Cover page with month, brand name, and key metrics summary
- Sections: Executive Summary, Key Metrics Dashboard, Campaign Performance Table, Top Performing Content, Audience Growth, Recommendations for Next Month
- Use large stat numbers with colored backgrounds for KPIs
- Tables with trend indicators (↑ green, ↓ red, → neutral)
- Page size: A4 portrait

Return ONLY the complete HTML document. No markdown.`,
};

// ============================================================
// Main Generator
// ============================================================

/**
 * Generate a professional PDF report.
 *
 * @param {object} opts
 * @param {string} opts.type - Report type: 'social_strategy' | 'content_calendar' | 'competitor_analysis' | 'monthly_report' | 'custom'
 * @param {object} opts.data - Report data (passed to Claude as context)
 * @param {string} opts.clientName - Client/brand name
 * @param {string[]} [opts.imageUrls] - Image URLs to embed in the report (creative previews, screenshots, etc.)
 * @param {string} [opts.customPrompt] - Custom instructions for 'custom' type
 * @param {string} [opts.clientId] - Client ID for cost tracking
 * @returns {object} { url, _pdfBuffer, fileName, message }
 */
export async function generatePdfReport(opts = {}) {
  const { type = 'custom', data = {}, clientName = 'Report', imageUrls = [], customPrompt, clientId } = opts;

  log.info('Starting PDF report generation', { type, clientName, imageCount: imageUrls.length });

  // Step 1: Generate HTML with Claude
  const systemPrompt = SYSTEM_PROMPTS[type]
    ? `${SYSTEM_PROMPTS.base}\n\n${SYSTEM_PROMPTS[type]}`
    : SYSTEM_PROMPTS.base;

  const dataContext = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  // Build image embedding instructions if URLs provided
  const imageInstructions = imageUrls.length > 0
    ? `\n\nIMAGE ASSETS TO EMBED:\nThe following image URLs should be embedded in the report using <img> tags. Place them alongside their corresponding content (e.g., next to the post they represent in a calendar, or in an "Approved Creatives" section).\n${imageUrls.map((url, i) => `Image ${i + 1}: ${url}`).join('\n')}\n\nIMPORTANT: Use <img src="URL" style="max-width:100%; height:auto; border-radius:8px; margin:12px 0;"> for each image. If this is a content calendar, show the image thumbnail next to each post entry.`
    : '';

  const userMessage = type === 'custom' && customPrompt
    ? `Create a professional PDF report for "${clientName}".\n\nInstructions: ${customPrompt}\n\nData:\n${dataContext}${imageInstructions}`
    : `Create a professional ${type.replace(/_/g, ' ')} report for "${clientName}".\n\nData:\n${dataContext}${imageInstructions}`;

  const response = await askClaude({
    systemPrompt,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    workflow: 'pdf-report-generation',
    clientId,
  });

  // Extract HTML from response
  let html = response.text.trim();
  // Strip markdown code fences if Claude wrapped it
  html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
    log.error('Claude did not return valid HTML', { preview: html.slice(0, 200) });
    throw new Error('PDF generation failed — AI did not produce valid HTML');
  }

  log.info('HTML generated', { type, length: html.length });

  // Step 2: Convert HTML to PDF with Puppeteer
  const pdfBuffer = await htmlToPdf(html, {
    landscape: type === 'content_calendar',
  });

  log.info('PDF generated', { type, size: pdfBuffer.length });

  // Step 3: Upload to Supabase Storage
  const timestamp = Date.now();
  const safeName = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const fileName = `${safeName}-${type.replace(/_/g, '-')}-${timestamp}.pdf`;
  let url = null;

  if (supaStorage.isConfigured()) {
    try {
      const result = await supaStorage.uploadBuffer(
        `reports/${fileName}`,
        pdfBuffer,
        'application/pdf',
      );
      url = result.url;
      log.info('PDF uploaded to Supabase', { url: url?.slice(0, 80) });
    } catch (e) {
      log.warn('PDF upload to Supabase failed', { error: e.message });
    }
  }

  const displayName = `${clientName} - ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}.pdf`;

  return {
    url,
    _pdfBuffer: pdfBuffer,
    fileName: displayName,
    type,
    clientName,
    message: `Here's your ${type.replace(/_/g, ' ')} report for ${clientName}.`,
  };
}

// ============================================================
// HTML → PDF Conversion
// ============================================================

async function htmlToPdf(html, opts = {}) {
  const tmpPath = `/tmp/report-${Date.now()}.html`;
  let browser = null;

  try {
    fs.writeFileSync(tmpPath, html, 'utf-8');

    // Reuse exact Puppeteer launch pattern from creative-renderer
    let puppeteer;
    let isPuppeteerCore = false;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      puppeteer = await import('puppeteer-core');
      isPuppeteerCore = true;
    }

    const chromePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ].filter(Boolean);

    const launchOpts = {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: 'new',
    };

    for (const chromePath of chromePaths) {
      if (fs.existsSync(chromePath)) {
        launchOpts.executablePath = chromePath;
        break;
      }
    }

    if (isPuppeteerCore && !launchOpts.executablePath) {
      throw new Error('No Chromium browser found. PDF generation requires Puppeteer with Chromium.');
    }

    browser = await (puppeteer.default || puppeteer).launch(launchOpts);
    const page = await browser.newPage();
    await page.goto(`file://${tmpPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for Google Fonts to load
    await page.waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 10000 }).catch(() => {
      log.warn('Font loading may not have completed for PDF');
    });

    const pdfBuffer = await page.pdf({
      format: opts.landscape ? 'A4' : 'A4',
      landscape: !!opts.landscape,
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    return Buffer.from(pdfBuffer);
  } catch (error) {
    log.error('HTML to PDF conversion failed', { error: error.message });
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export default { generatePdfReport };
