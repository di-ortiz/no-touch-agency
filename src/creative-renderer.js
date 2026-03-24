import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import * as supaStorage from './api/supabase-storage.js';
import { renderTemplateHtml, selectTemplate, getTemplateNames } from './services/template-engine.js';

const log = logger.child({ workflow: 'creative-renderer' });

/**
 * Render an ad creative by overlaying text on a background image using Puppeteer.
 * Uses the 2-layer system: AI background + HTML/CSS text overlay.
 *
 * @param {string} backgroundImageUrl - URL of the FLUX-generated background image
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON for styling
 * @param {object} [opts] - Options
 * @param {string} [opts.format] - 'feed' (1080x1080) or 'story' (1080x1920)
 * @param {string} [opts.clientId] - Client ID for Drive upload
 * @param {string} [opts.driveFolderId] - Drive folder for upload
 * @returns {object} { url, format, width, height }
 */
export async function renderAdCreative(backgroundImageUrl, adCopy, brandDNA, opts = {}) {
  const format = opts.format || 'feed';
  const width = 1080;
  const height = format === 'story' ? 1920 : 1080;
  const isStory = format === 'story';

  log.info('Rendering ad creative', { format, width, height, headline: adCopy?.headline });

  // Sanitize text for HTML
  const escapeHtml = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const headline = escapeHtml(adCopy?.headline || '');
  const subtext = escapeHtml(adCopy?.subtext || '');
  const cta = escapeHtml(adCopy?.cta || '');
  const ctaColor = brandDNA?.primary_colors?.[0] || '#FF4500';

  // Adjust text positioning for story format (vertical center-bottom)
  const textBottom = isStory ? '200px' : '60px';
  const headlineSize = isStory ? '54px' : '48px';
  const subtextSize = isStory ? '32px' : '28px';
  const gradientHeight = isStory ? '50%' : '45%';

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0; width:${width}px; height:${height}px; position:relative;
             font-family: Arial, Helvetica, sans-serif; overflow:hidden;">
  <!-- Background image -->
  <img src="${backgroundImageUrl}"
       style="width:100%; height:100%; object-fit:cover;
              position:absolute; top:0; left:0;" />
  <!-- Dark gradient for text readability -->
  <div style="position:absolute; bottom:0; left:0; right:0; height:${gradientHeight};
              background: linear-gradient(transparent, rgba(0,0,0,0.75));"></div>
  <!-- Text block -->
  <div style="position:absolute; bottom:${textBottom}; left:50px; right:50px;">
    <p style="color:white; font-size:${headlineSize}; font-weight:900;
              margin:0 0 12px 0; line-height:1.2;
              text-shadow: 0 2px 8px rgba(0,0,0,0.6);">
      ${headline}
    </p>
    <p style="color:rgba(255,255,255,0.9); font-size:${subtextSize};
              margin:0 0 24px 0; line-height:1.4;">
      ${subtext}
    </p>
    ${cta ? `<div style="display:inline-block;
                background:${ctaColor};
                color:white; padding:16px 36px; border-radius:50px;
                font-size:26px; font-weight:700;">
      ${cta}
    </div>` : ''}
  </div>
</body>
</html>`;

  const timestamp = Date.now();
  const tmpPath = `/tmp/creative-${timestamp}-${format}.html`;
  let browser = null;

  try {
    // Write HTML to temp file
    fs.writeFileSync(tmpPath, html, 'utf-8');
    log.info('Puppeteer render starting', { tmpPath, format });

    // Try puppeteer (bundled browser) first, then puppeteer-core with system chromium
    let puppeteer;
    let isPuppeteerCore = false;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      puppeteer = await import('puppeteer-core');
      isPuppeteerCore = true;
    }

    // Find system chromium path
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

    // puppeteer-core requires an explicit executablePath — fail clearly if missing
    if (isPuppeteerCore && !launchOpts.executablePath) {
      throw new Error(
        'No Chromium browser found. Set PUPPETEER_EXECUTABLE_PATH or install chromium in the container. ' +
        'Template rendering requires a browser to capture screenshots.'
      );
    }

    browser = await (puppeteer.default || puppeteer).launch(launchOpts);

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

    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width, height },
    });

    log.info('Puppeteer screenshot captured', { format, size: screenshotBuffer.length });

    // Upload to Supabase Storage
    let result = { format, width, height };

    if (opts.driveFolderId && supaStorage.isConfigured()) {
      try {
        const fileName = `ad-creative-${format}-${timestamp}.png`;
        const filePath = `${opts.driveFolderId}/${fileName}`;
        const uploaded = await supaStorage.uploadBuffer(filePath, screenshotBuffer, 'image/png');

        if (uploaded?.url) {
          result.url = uploaded.url;
          result.driveId = uploaded.path;
        }
      } catch (e) {
        log.warn('Supabase upload failed for rendered creative', { error: e.message });
      }
    }

    // Always attach the buffer for direct delivery via WhatsApp/Telegram
    result._buffer = screenshotBuffer;
    result._mimeType = 'image/png';

    log.info('Ad creative rendered successfully', { format, hasUrl: !!result.url });
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
 * Render both Feed and Story variants of an ad creative.
 *
 * @param {string} backgroundImageUrl - Background image URL
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON
 * @param {object} [opts] - Options (clientId, driveFolderId)
 * @returns {object} { feed: result, story: result }
 */
export async function renderAdCreativePair(backgroundImageUrl, adCopy, brandDNA, opts = {}) {
  const results = {};

  try {
    results.feed = await renderAdCreative(backgroundImageUrl, adCopy, brandDNA, {
      ...opts,
      format: 'feed',
    });
  } catch (e) {
    log.error('Feed render failed', { error: e.message });
    results.feed = { error: e.message, format: 'feed' };
  }

  try {
    results.story = await renderAdCreative(backgroundImageUrl, adCopy, brandDNA, {
      ...opts,
      format: 'story',
    });
  } catch (e) {
    log.error('Story render failed', { error: e.message });
    results.story = { error: e.message, format: 'story' };
  }

  return results;
}

/**
 * Full ad creative generation pipeline:
 * 1. Generate ad copy (Claude Haiku)
 * 2. Generate background image (FLUX) — in parallel with step 1
 * 3. Render overlay (Puppeteer)
 * 4. Return both Feed + Story formats
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

  // Step 3: Render overlay
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

/**
 * Render a single ad creative from an HTML/CSS template (no AI image needed).
 * Uses Puppeteer to screenshot the template HTML.
 *
 * @param {string} templateName - Template name (or null for random)
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON for styling
 * @param {object} [opts] - Options
 * @param {string} [opts.format] - 'feed' (1080x1080) or 'story' (1080x1920)
 * @param {string} [opts.backgroundImageUrl] - Optional background image URL
 * @param {string} [opts.driveFolderId] - Drive folder for upload
 * @param {string} [opts.clientId] - Client ID
 * @returns {object} { url, format, width, height, templateName, _buffer, _mimeType }
 */
export async function renderFromTemplate(templateName, adCopy, brandDNA, opts = {}) {
  const format = opts.format || 'feed';

  log.info('Rendering from template', { templateName, format, headline: adCopy?.headline });

  const { html, templateName: resolvedName, width, height } = renderTemplateHtml(
    templateName, adCopy, brandDNA, { format, backgroundImageUrl: opts.backgroundImageUrl }
  );

  const timestamp = Date.now();
  const tmpPath = `/tmp/template-${resolvedName}-${timestamp}-${format}.html`;
  let browser = null;

  try {
    fs.writeFileSync(tmpPath, html, 'utf-8');

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
      throw new Error(
        'No Chromium browser found. Set PUPPETEER_EXECUTABLE_PATH or install chromium in the container. ' +
        'Template rendering requires a browser to capture screenshots.'
      );
    }

    browser = await (puppeteer.default || puppeteer).launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${tmpPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for Google Fonts to load
    await page.waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 10000 }).catch(() => {
      log.warn('Font loading may not have completed');
    });

    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: { x: 0, y: 0, width, height },
    });

    log.info('Template screenshot captured', { template: resolvedName, format, size: screenshotBuffer.length });

    let result = { format, width, height, templateName: resolvedName };

    if (opts.driveFolderId && supaStorage.isConfigured()) {
      try {
        const fileName = `template-${resolvedName}-${format}-${timestamp}.png`;
        const filePath = `${opts.driveFolderId}/${fileName}`;
        const uploaded = await supaStorage.uploadBuffer(filePath, screenshotBuffer, 'image/png');
        if (uploaded?.url) {
          result.url = uploaded.url;
          result.driveId = uploaded.path;
        }
      } catch (e) {
        log.warn('Supabase upload failed for template creative', { error: e.message });
      }
    }

    result._buffer = screenshotBuffer;
    result._mimeType = 'image/png';

    log.info('Template creative rendered successfully', { template: resolvedName, format, hasUrl: !!result.url });
    return result;

  } catch (error) {
    log.error('Template render failed', { error: error.message, template: templateName, format });
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
  }
}

/**
 * Full template-based creative generation pipeline (no AI image needed).
 * 1. Generate ad copy (Claude Haiku)
 * 2. Render template with Puppeteer (Feed + Story)
 *
 * @param {object} opts
 * @param {object} opts.brandDNA - Brand DNA JSON
 * @param {string} opts.product - Product/service
 * @param {string} opts.goal - Campaign goal
 * @param {string} [opts.templateStyle] - Template name (or null for random)
 * @param {string} [opts.backgroundImageUrl] - Optional background image
 * @param {string} [opts.driveFolderId] - Drive folder for uploads
 * @param {string} [opts.clientId] - Client ID
 * @returns {object} { adCopy, templateName, feed, story, fallback, templateBased }
 */
export async function generateTemplateCreative(opts = {}) {
  const { brandDNA, product, goal, templateStyle, backgroundImageUrl, driveFolderId, clientId } = opts;
  const { generateAdCopy } = await import('./brand-dna.js');

  log.info('Starting template creative pipeline', { product, goal, templateStyle });

  // Step 1: Generate ad copy
  const adCopy = await generateAdCopy(brandDNA, { product, goal });

  // Step 2: Pick template
  const { name: resolvedTemplate } = selectTemplate(templateStyle);

  // Step 3: Render both formats
  const results = {};

  try {
    results.feed = await renderFromTemplate(resolvedTemplate, adCopy, brandDNA, {
      format: 'feed',
      backgroundImageUrl,
      driveFolderId,
      clientId,
    });
  } catch (e) {
    log.error('Template feed render failed', { error: e.message });
    results.feed = { error: e.message, format: 'feed' };
  }

  try {
    results.story = await renderFromTemplate(resolvedTemplate, adCopy, brandDNA, {
      format: 'story',
      backgroundImageUrl,
      driveFolderId,
      clientId,
    });
  } catch (e) {
    log.error('Template story render failed', { error: e.message });
    results.story = { error: e.message, format: 'story' };
  }

  return {
    adCopy,
    templateName: resolvedTemplate,
    feed: results.feed,
    story: results.story,
    fallback: false,
    templateBased: true,
  };
}

export default {
  renderAdCreative,
  renderAdCreativePair,
  generateFullCreative,
  renderFromTemplate,
  generateTemplateCreative,
};
