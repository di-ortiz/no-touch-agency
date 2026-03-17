import sharp from 'sharp';
import axios from 'axios';
import logger from '../utils/logger.js';

const log = logger.child({ service: 'image-overlay' });

// ============================================================
// Marketing Text Overlay for Ad Creatives
// ============================================================

/**
 * Apply marketing text overlay (headline, CTA button, offer badge) to a generated image.
 *
 * Uses sharp + SVG compositing — no external fonts needed.
 * SVG text renders consistently across environments.
 *
 * @param {object} opts
 * @param {Buffer|string} opts.image - Image buffer or URL/data-URI
 * @param {string} opts.headline - Main headline text (top area)
 * @param {string} opts.cta - CTA button text (e.g. "Book Now", "Shop Now")
 * @param {string} opts.offer - Offer/promo badge text (e.g. "50% OFF", "Free Audit")
 * @param {string} opts.subtext - Secondary text below headline
 * @param {object} opts.colors - Custom color overrides
 * @param {string} opts.colors.headline - Headline text color (default: white)
 * @param {string} opts.colors.ctaBg - CTA button background (default: #FF6B35)
 * @param {string} opts.colors.ctaText - CTA button text color (default: white)
 * @param {string} opts.colors.offerBg - Offer badge background (default: #E53E3E)
 * @param {string} opts.colors.offerText - Offer badge text color (default: white)
 * @param {string} opts.colors.overlay - Semi-transparent overlay color (default: rgba(0,0,0,0.35))
 * @param {string} opts.layout - Layout preset: 'bottom' (default), 'center', 'top', 'split'
 * @returns {object} { buffer, mimeType }
 */
export async function applyTextOverlay(opts = {}) {
  const { headline, cta, offer, subtext } = opts;

  if (!headline && !cta && !offer) {
    log.debug('No text overlay requested, returning original image');
    return null;
  }

  try {
    // Get image buffer
    let imageBuffer = await resolveImageBuffer(opts.image);
    if (!imageBuffer) throw new Error('Could not resolve image to buffer');

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    const colors = {
      headline: '#FFFFFF',
      headlineShadow: 'rgba(0,0,0,0.8)',
      ctaBg: '#FF6B35',
      ctaText: '#FFFFFF',
      offerBg: '#E53E3E',
      offerText: '#FFFFFF',
      overlay: 'rgba(0,0,0,0.35)',
      subtext: '#F0F0F0',
      ...opts.colors,
    };

    const layout = opts.layout || 'bottom';
    const svg = buildOverlaySvg({ width, height, headline, cta, offer, subtext, colors, layout });

    const result = await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();

    log.info('Text overlay applied', { width, height, hasHeadline: !!headline, hasCta: !!cta, hasOffer: !!offer, layout });

    return { buffer: result, mimeType: 'image/png' };
  } catch (error) {
    log.error('Failed to apply text overlay', { error: error.message });
    throw error;
  }
}

/**
 * Resolve an image source to a Buffer.
 */
async function resolveImageBuffer(source) {
  if (!source) return null;

  if (Buffer.isBuffer(source)) return source;

  if (typeof source === 'string') {
    // base64 data URI
    if (source.startsWith('data:')) {
      const base64Part = source.split(',')[1];
      return Buffer.from(base64Part, 'base64');
    }

    // URL — download it
    if (source.startsWith('http')) {
      const response = await axios.get(source, { responseType: 'arraybuffer', timeout: 30000 });
      return Buffer.from(response.data);
    }

    // Raw base64
    if (source.length > 100 && !source.includes('/') && !source.includes('.')) {
      return Buffer.from(source, 'base64');
    }
  }

  return null;
}

// ============================================================
// SVG Overlay Builder
// ============================================================

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Word-wrap text to fit within a max width (approximate character-based).
 */
function wrapText(text, maxCharsPerLine) {
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Build the SVG overlay with headline, CTA button, and offer badge.
 */
function buildOverlaySvg({ width, height, headline, cta, offer, subtext, colors, layout }) {
  const padding = Math.round(width * 0.06);
  const headlineFontSize = Math.round(width * 0.055);
  const subtextFontSize = Math.round(width * 0.035);
  const ctaFontSize = Math.round(width * 0.032);
  const offerFontSize = Math.round(width * 0.028);
  const lineHeight = 1.3;

  const elements = [];

  // Calculate layout positions
  let headlineY, ctaY, offerX, offerY;

  if (layout === 'center') {
    headlineY = Math.round(height * 0.35);
    ctaY = Math.round(height * 0.6);
  } else if (layout === 'top') {
    headlineY = Math.round(height * 0.12);
    ctaY = Math.round(height * 0.35);
  } else if (layout === 'split') {
    headlineY = Math.round(height * 0.08);
    ctaY = Math.round(height * 0.82);
  } else {
    // 'bottom' layout (default) — text in lower portion
    headlineY = Math.round(height * 0.55);
    ctaY = Math.round(height * 0.82);
  }

  // --- Gradient overlay for text readability ---
  if (layout === 'bottom' || layout === 'split') {
    elements.push(`
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="40%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.7"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#grad)"/>
    `);
  } else if (layout === 'center') {
    elements.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${colors.overlay}"/>`);
  } else if (layout === 'top') {
    elements.push(`
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0.7"/>
          <stop offset="60%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#grad)"/>
    `);
  }

  // --- Offer badge (top-right corner) ---
  if (offer) {
    offerX = width - padding;
    offerY = padding + Math.round(offerFontSize * 1.5);
    const badgeWidth = Math.round(offer.length * offerFontSize * 0.65 + padding);
    const badgeHeight = Math.round(offerFontSize * 2.2);
    const badgeX = offerX - badgeWidth;
    const badgeRadius = Math.round(badgeHeight * 0.2);

    elements.push(`
      <rect x="${badgeX}" y="${offerY - badgeHeight * 0.7}" width="${badgeWidth}" height="${badgeHeight}" rx="${badgeRadius}" ry="${badgeRadius}" fill="${colors.offerBg}"/>
      <text x="${badgeX + badgeWidth / 2}" y="${offerY + offerFontSize * 0.15}" font-family="Arial, Helvetica, sans-serif" font-size="${offerFontSize}" font-weight="800" fill="${colors.offerText}" text-anchor="middle" letter-spacing="1">${escapeXml(offer.toUpperCase())}</text>
    `);
  }

  // --- Headline ---
  if (headline) {
    const maxChars = Math.floor((width - padding * 2) / (headlineFontSize * 0.55));
    const headlineLines = wrapText(headline, maxChars);

    headlineLines.forEach((line, i) => {
      const y = headlineY + i * Math.round(headlineFontSize * lineHeight);
      // Text shadow for readability
      elements.push(`
        <text x="${padding + 2}" y="${y + 2}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineFontSize}" font-weight="800" fill="${colors.headlineShadow}" letter-spacing="0.5">${escapeXml(line)}</text>
        <text x="${padding}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineFontSize}" font-weight="800" fill="${colors.headline}" letter-spacing="0.5">${escapeXml(line)}</text>
      `);
    });

    // --- Subtext below headline ---
    if (subtext) {
      const subtextY = headlineY + headlineLines.length * Math.round(headlineFontSize * lineHeight) + Math.round(subtextFontSize * 0.5);
      const maxSubChars = Math.floor((width - padding * 2) / (subtextFontSize * 0.55));
      const subtextLines = wrapText(subtext, maxSubChars);

      subtextLines.forEach((line, i) => {
        const y = subtextY + i * Math.round(subtextFontSize * lineHeight);
        elements.push(`
          <text x="${padding + 1}" y="${y + 1}" font-family="Arial, Helvetica, sans-serif" font-size="${subtextFontSize}" font-weight="400" fill="${colors.headlineShadow}">${escapeXml(line)}</text>
          <text x="${padding}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${subtextFontSize}" font-weight="400" fill="${colors.subtext}">${escapeXml(line)}</text>
        `);
      });
    }
  }

  // --- CTA Button ---
  if (cta) {
    const ctaTextWidth = Math.round(cta.length * ctaFontSize * 0.6);
    const btnPaddingX = Math.round(ctaFontSize * 1.5);
    const btnPaddingY = Math.round(ctaFontSize * 0.8);
    const btnWidth = ctaTextWidth + btnPaddingX * 2;
    const btnHeight = Math.round(ctaFontSize + btnPaddingY * 2);
    const btnRadius = Math.round(btnHeight * 0.15);

    // Center CTA or left-align based on layout
    const btnX = layout === 'center'
      ? Math.round((width - btnWidth) / 2)
      : padding;

    // Button shadow
    elements.push(`
      <rect x="${btnX + 3}" y="${ctaY + 3}" width="${btnWidth}" height="${btnHeight}" rx="${btnRadius}" ry="${btnRadius}" fill="rgba(0,0,0,0.3)"/>
    `);

    // Button
    elements.push(`
      <rect x="${btnX}" y="${ctaY}" width="${btnWidth}" height="${btnHeight}" rx="${btnRadius}" ry="${btnRadius}" fill="${colors.ctaBg}"/>
      <text x="${btnX + btnWidth / 2}" y="${ctaY + btnHeight / 2 + ctaFontSize * 0.35}" font-family="Arial, Helvetica, sans-serif" font-size="${ctaFontSize}" font-weight="700" fill="${colors.ctaText}" text-anchor="middle" letter-spacing="1">${escapeXml(cta.toUpperCase())}</text>
    `);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join('\n')}</svg>`;
}

// ============================================================
// Batch overlay: apply same text to multiple images
// ============================================================

/**
 * Apply text overlay to multiple images (e.g. from multi-provider generation).
 *
 * @param {Array} images - Array of image objects with { url, base64, buffer }
 * @param {object} textOpts - { headline, cta, offer, subtext, colors, layout }
 * @returns {Array} Images with overlay applied (adds overlayBuffer/overlayUrl)
 */
export async function applyOverlayBatch(images, textOpts = {}) {
  if (!textOpts.headline && !textOpts.cta && !textOpts.offer) {
    return images; // nothing to overlay
  }

  const results = await Promise.allSettled(
    images.map(async (img) => {
      if (img.error || (!img.url && !img.base64 && !img.buffer)) return img;

      try {
        const source = img.buffer || img.base64 || img.url;
        const overlay = await applyTextOverlay({ ...textOpts, image: source });

        if (overlay) {
          return {
            ...img,
            // Replace the image data with the overlaid version
            buffer: overlay.buffer,
            base64: overlay.buffer.toString('base64'),
            url: `data:${overlay.mimeType};base64,${overlay.buffer.toString('base64')}`,
            mimeType: overlay.mimeType,
            hasOverlay: true,
          };
        }
        return img;
      } catch (error) {
        log.warn('Overlay failed for image, returning original', { error: error.message, provider: img.provider });
        return img;
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
}

export default { applyTextOverlay, applyOverlayBatch };
