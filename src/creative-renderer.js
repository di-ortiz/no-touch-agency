import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import * as googleDrive from './api/google-drive.js';

const log = logger.child({ workflow: 'creative-renderer' });

// ============================================================
// Professional Ad Creative Templates
// ============================================================

/**
 * Pick a contrasting text color for readability on a given background.
 * Returns 'white' or dark color based on luminance.
 */
function getContrastColor(hex) {
  if (!hex || !hex.startsWith('#')) return '#FFFFFF';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#1A1A2E' : '#FFFFFF';
}

/**
 * Lighten or darken a hex color by a percentage.
 */
function adjustColor(hex, percent) {
  if (!hex || !hex.startsWith('#')) return hex;
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.min(255, Math.max(0, (num >> 16) + amt));
  const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
  const B = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
  return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
}

/**
 * Build the full HTML for an ad creative with professional typography and layout.
 *
 * @param {string} backgroundImageUrl - AI-generated background image URL
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON
 * @param {object} opts - { format, layout }
 */
function buildCreativeHTML(backgroundImageUrl, adCopy, brandDNA, opts = {}) {
  const format = opts.format || 'feed';
  const width = 1080;
  const height = format === 'story' ? 1920 : 1080;
  const isStory = format === 'story';

  const escapeHtml = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const headline = escapeHtml(adCopy?.headline || '');
  const subtext = escapeHtml(adCopy?.subtext || '');
  const cta = escapeHtml(adCopy?.cta || '');

  // Brand colors with intelligent defaults
  const primaryColor = brandDNA?.primary_colors?.[0] || '#FF4500';
  const secondaryColor = brandDNA?.primary_colors?.[1] || adjustColor(primaryColor, -30);
  const accentColor = brandDNA?.primary_colors?.[2] || adjustColor(primaryColor, 40);
  const textOnPrimary = getContrastColor(primaryColor);

  // Auto-select layout based on format and content
  const layout = opts.layout || (isStory ? 'hero-top' : 'gradient-bottom');

  return `<!DOCTYPE html>
<html>
<head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Montserrat:wght@700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${width}px;
      height: ${height}px;
      position: relative;
      overflow: hidden;
      font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .bg-image {
      width: 100%; height: 100%;
      object-fit: cover;
      position: absolute; top: 0; left: 0;
    }

    /* ---- Layout: gradient-bottom (Feed default) ---- */
    .layout-gradient-bottom .overlay {
      position: absolute; bottom: 0; left: 0; right: 0;
      height: ${isStory ? '55%' : '50%'};
      background: linear-gradient(
        to bottom,
        transparent 0%,
        rgba(0,0,0,0.15) 20%,
        rgba(0,0,0,0.65) 50%,
        rgba(0,0,0,0.88) 100%
      );
    }
    .layout-gradient-bottom .text-block {
      position: absolute;
      bottom: ${isStory ? '160px' : '60px'};
      left: 60px; right: 60px;
    }
    .layout-gradient-bottom .headline {
      color: #FFFFFF;
      font-family: 'Montserrat', 'Inter', sans-serif;
      font-size: ${isStory ? '62px' : '56px'};
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.02em;
      margin-bottom: 16px;
      text-shadow: 0 2px 12px rgba(0,0,0,0.4), 0 4px 24px rgba(0,0,0,0.2);
      text-transform: uppercase;
    }
    .layout-gradient-bottom .subtext {
      color: rgba(255,255,255,0.92);
      font-size: ${isStory ? '28px' : '24px'};
      font-weight: 500;
      line-height: 1.4;
      margin-bottom: 28px;
      text-shadow: 0 1px 6px rgba(0,0,0,0.3);
    }

    /* ---- Layout: hero-top (Story default) ---- */
    .layout-hero-top .overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(
        to bottom,
        ${primaryColor}F0 0%,
        ${primaryColor}CC 30%,
        transparent 55%,
        transparent 70%,
        rgba(0,0,0,0.7) 100%
      );
    }
    .layout-hero-top .text-block {
      position: absolute;
      top: ${isStory ? '140px' : '60px'};
      left: 60px; right: 60px;
    }
    .layout-hero-top .headline {
      color: ${textOnPrimary};
      font-family: 'Montserrat', 'Inter', sans-serif;
      font-size: ${isStory ? '68px' : '54px'};
      font-weight: 900;
      line-height: 1.0;
      letter-spacing: -0.02em;
      margin-bottom: 16px;
      text-transform: uppercase;
    }
    .layout-hero-top .subtext {
      color: ${textOnPrimary}DD;
      font-size: ${isStory ? '28px' : '24px'};
      font-weight: 500;
      line-height: 1.3;
      margin-bottom: 28px;
    }
    .layout-hero-top .cta-container {
      position: absolute;
      bottom: ${isStory ? '160px' : '60px'};
      left: 60px; right: 60px;
    }

    /* ---- Layout: split (half image, half brand color) ---- */
    .layout-split .bg-image {
      height: ${isStory ? '55%' : '50%'};
    }
    .layout-split .color-block {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: ${isStory ? '48%' : '52%'};
      background: linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%);
    }
    .layout-split .text-block {
      position: absolute;
      bottom: ${isStory ? '160px' : '60px'};
      left: 60px; right: 60px;
    }
    .layout-split .headline {
      color: ${textOnPrimary};
      font-family: 'Montserrat', 'Inter', sans-serif;
      font-size: ${isStory ? '60px' : '52px'};
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.02em;
      margin-bottom: 14px;
      text-transform: uppercase;
    }
    .layout-split .subtext {
      color: ${textOnPrimary}DD;
      font-size: ${isStory ? '26px' : '22px'};
      font-weight: 500;
      line-height: 1.4;
      margin-bottom: 28px;
    }

    /* ---- Layout: bold-center (text overlaid in center) ---- */
    .layout-bold-center .overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.35) 70%);
    }
    .layout-bold-center .text-block {
      position: absolute;
      top: 50%;
      left: 60px; right: 60px;
      transform: translateY(-50%);
      text-align: center;
    }
    .layout-bold-center .headline {
      color: #FFFFFF;
      font-family: 'Montserrat', 'Inter', sans-serif;
      font-size: ${isStory ? '72px' : '64px'};
      font-weight: 900;
      line-height: 1.0;
      letter-spacing: -0.03em;
      margin-bottom: 20px;
      text-shadow: 0 4px 20px rgba(0,0,0,0.5);
      text-transform: uppercase;
    }
    .layout-bold-center .subtext {
      color: rgba(255,255,255,0.9);
      font-size: ${isStory ? '28px' : '26px'};
      font-weight: 500;
      line-height: 1.35;
      margin-bottom: 32px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .layout-bold-center .cta-btn { margin: 0 auto; }

    /* ---- CTA Button (shared) ---- */
    .cta-btn {
      display: inline-block;
      background: ${primaryColor};
      color: ${textOnPrimary};
      padding: 18px 44px;
      border-radius: 6px;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      box-shadow: 0 4px 16px ${primaryColor}66;
    }
    /* Alternate: pill style for certain layouts */
    .layout-gradient-bottom .cta-btn,
    .layout-bold-center .cta-btn {
      border-radius: 50px;
      padding: 16px 40px;
    }

    /* ---- Brand accent bar ---- */
    .brand-accent {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 6px;
      background: linear-gradient(90deg, ${primaryColor}, ${secondaryColor}, ${accentColor});
    }
  </style>
</head>
<body class="layout-${layout}">
  <!-- Background image -->
  <img class="bg-image" src="${backgroundImageUrl}" />

  ${layout === 'split' ? `<div class="color-block"></div>` : ''}
  ${layout !== 'split' ? `<div class="overlay"></div>` : ''}

  <!-- Brand accent bar -->
  <div class="brand-accent"></div>

  <!-- Text block -->
  <div class="text-block">
    ${headline ? `<div class="headline">${headline}</div>` : ''}
    ${subtext ? `<div class="subtext">${subtext}</div>` : ''}
    ${cta && layout !== 'hero-top' ? `<div class="cta-btn">${cta}</div>` : ''}
  </div>

  ${layout === 'hero-top' && cta ? `
  <div class="cta-container">
    <div class="cta-btn">${cta}</div>
  </div>` : ''}
</body>
</html>`;
}

// ============================================================
// Puppeteer Rendering
// ============================================================

/**
 * Render an ad creative by overlaying text on a background image using Puppeteer.
 * Uses the 2-layer system: AI background + HTML/CSS text overlay with professional typography.
 *
 * @param {string} backgroundImageUrl - URL of the AI-generated background image
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON for styling
 * @param {object} [opts] - Options
 * @param {string} [opts.format] - 'feed' (1080x1080) or 'story' (1080x1920)
 * @param {string} [opts.layout] - 'gradient-bottom', 'hero-top', 'split', 'bold-center'
 * @param {string} [opts.clientId] - Client ID for Drive upload
 * @param {string} [opts.driveFolderId] - Drive folder for upload
 * @returns {object} { url, format, width, height }
 */
export async function renderAdCreative(backgroundImageUrl, adCopy, brandDNA, opts = {}) {
  const format = opts.format || 'feed';
  const width = 1080;
  const height = format === 'story' ? 1920 : 1080;

  log.info('Rendering ad creative', { format, width, height, layout: opts.layout, headline: adCopy?.headline });

  const html = buildCreativeHTML(backgroundImageUrl, adCopy, brandDNA, opts);

  const timestamp = Date.now();
  const tmpPath = `/tmp/creative-${timestamp}-${format}.html`;
  let browser = null;

  try {
    // Write HTML to temp file
    fs.writeFileSync(tmpPath, html, 'utf-8');
    log.info('Puppeteer render starting', { tmpPath, format });

    // Try puppeteer (bundled browser) first, then puppeteer-core with system chromium
    let puppeteer;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      puppeteer = await import('puppeteer-core');
    }

    // Find system chromium path for puppeteer-core
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

    // If using puppeteer-core, we need to specify executablePath
    for (const chromePath of chromePaths) {
      try {
        const { existsSync } = await import('fs');
        if (existsSync(chromePath)) {
          launchOpts.executablePath = chromePath;
          break;
        }
      } catch { /* continue */ }
    }

    browser = await puppeteer.default.launch(launchOpts);

    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${tmpPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for the background image to load
    await page.waitForFunction(() => {
      const img = document.querySelector('img');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 15000 }).catch(() => {
      log.warn('Background image may not have loaded fully');
    });

    // Wait for Google Fonts to load
    await page.waitForFunction(() => {
      return document.fonts && document.fonts.ready;
    }, { timeout: 8000 }).catch(() => {
      log.warn('Google Fonts may not have loaded fully');
    });

    // Small delay for final paint
    await new Promise(r => setTimeout(r, 500));

    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width, height },
    });

    log.info('Puppeteer screenshot captured', { format, size: screenshotBuffer.length });

    // Upload to Google Drive
    let result = { format, width, height, layout: opts.layout };

    if (opts.driveFolderId) {
      try {
        const fileName = `ad-creative-${format}-${timestamp}.png`;
        const driveFile = await googleDrive.uploadFile({
          name: fileName,
          mimeType: 'image/png',
          buffer: screenshotBuffer,
          folderId: opts.driveFolderId,
        });

        if (driveFile?.webContentLink) {
          result.url = driveFile.webContentLink;
          result.driveId = driveFile.id;
        }
      } catch (e) {
        log.warn('Drive upload failed for rendered creative', { error: e.message });
      }
    }

    // Always attach the buffer for direct delivery via WhatsApp/Telegram
    result._buffer = screenshotBuffer;
    result._mimeType = 'image/png';

    log.info('Ad creative rendered successfully', { format, layout: opts.layout, hasUrl: !!result.url });
    return result;

  } catch (error) {
    log.error('Puppeteer render failed', { error: error.message, format });
    throw error;
  } finally {
    // Clean up
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
  }
}

/**
 * Render both Feed and Story variants of an ad creative, each with the best layout.
 *
 * @param {string} backgroundImageUrl - Background image URL
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON
 * @param {object} [opts] - Options (clientId, driveFolderId)
 * @returns {object} { feed: result, story: result }
 */
export async function renderAdCreativePair(backgroundImageUrl, adCopy, brandDNA, opts = {}) {
  const results = {};

  // Feed: gradient-bottom works best (image fills, text overlaid at bottom)
  try {
    results.feed = await renderAdCreative(backgroundImageUrl, adCopy, brandDNA, {
      ...opts,
      format: 'feed',
      layout: opts.feedLayout || 'gradient-bottom',
    });
  } catch (e) {
    log.error('Feed render failed', { error: e.message });
    results.feed = { error: e.message, format: 'feed' };
  }

  // Story: hero-top works best (headline at top with brand color, image below)
  try {
    results.story = await renderAdCreative(backgroundImageUrl, adCopy, brandDNA, {
      ...opts,
      format: 'story',
      layout: opts.storyLayout || 'hero-top',
    });
  } catch (e) {
    log.error('Story render failed', { error: e.message });
    results.story = { error: e.message, format: 'story' };
  }

  return results;
}

/**
 * Full ad creative generation pipeline:
 * 1. Generate ad copy (Claude Haiku) — in parallel with step 2
 * 2. Generate background image (FLUX/DALL-E)
 * 3. Render overlay (Puppeteer) in multiple layouts
 * 4. Return Feed + Story formats
 *
 * @param {object} opts
 * @param {object} opts.brandDNA - Brand DNA JSON
 * @param {string} opts.product - Product/service being advertised
 * @param {string} opts.goal - Campaign goal
 * @param {Function} opts.generateImage - Image generation function
 * @param {string} opts.imagePrompt - Pre-built image prompt
 * @param {string} opts.driveFolderId - Drive folder for uploads
 * @param {string} opts.clientId - Client ID
 * @returns {object} { adCopy, backgroundUrl, feed, story, fallback }
 */
export async function generateFullCreative(opts = {}) {
  const { brandDNA, product, goal, generateImage, imagePrompt, driveFolderId, clientId } = opts;
  const { generateAdCopy } = await import('./brand-dna.js');

  log.info('Starting full creative pipeline', { product, goal });

  // Steps 1 & 2 run in parallel
  const [adCopy, backgroundImage] = await Promise.all([
    generateAdCopy(brandDNA, { product, goal }),
    generateImage({
      prompt: imagePrompt,
      format: 'general',
      workflow: 'creative-pipeline',
      clientId,
    }),
  ]);

  const backgroundUrl = backgroundImage?.url;
  if (!backgroundUrl) {
    throw new Error('Background image generation failed — no URL returned');
  }

  log.info('Parallel generation complete', { headline: adCopy.headline, backgroundUrl: backgroundUrl.slice(0, 60) });

  // Step 3: Render overlay with professional templates
  let results;
  try {
    results = await renderAdCreativePair(backgroundUrl, adCopy, brandDNA, {
      driveFolderId,
      clientId,
    });
  } catch (renderError) {
    log.error('Puppeteer rendering failed, using fallback', { error: renderError.message });

    // Fallback: return raw background + text separately
    return {
      adCopy,
      backgroundUrl,
      feed: { error: renderError.message, format: 'feed' },
      story: { error: renderError.message, format: 'story' },
      fallback: true,
    };
  }

  return {
    adCopy,
    backgroundUrl,
    feed: results.feed,
    story: results.story,
    fallback: false,
  };
}

export default {
  renderAdCreative,
  renderAdCreativePair,
  generateFullCreative,
  buildCreativeHTML,
};
