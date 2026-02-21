import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';
import fs from 'fs';

const log = logger.child({ platform: 'google-slides' });

let auth;
let slidesClient;
let driveClient;

function getAuth() {
  if (!auth) {
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    if (fs.existsSync(credPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: [
          'https://www.googleapis.com/auth/presentations',
          'https://www.googleapis.com/auth/drive',
        ],
      });
    } else {
      log.error('Google credentials MISSING', { credPath });
      throw new Error(
        `Google service account credentials not found. ` +
        `Expected credentials at "${credPath}" but the file does NOT exist. ` +
        `To fix: 1) Go to console.cloud.google.com → IAM → Service Accounts, ` +
        `2) Create a service account with Slides/Sheets/Drive API access, ` +
        `3) Download the JSON key and save it to ${credPath}`
      );
    }
  }
  return auth;
}

function getSlides() {
  if (!slidesClient) {
    slidesClient = google.slides({ version: 'v1', auth: getAuth() });
  }
  return slidesClient;
}

function getDrive() {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: getAuth() });
  }
  return driveClient;
}

// Brand colors for the agency deck
const COLORS = {
  primary:    { red: 0.13, green: 0.15, blue: 0.23 }, // Dark navy
  secondary:  { red: 0.24, green: 0.47, blue: 0.96 }, // Bright blue
  accent:     { red: 0.0,  green: 0.82, blue: 0.67 }, // Teal/green
  white:      { red: 1.0,  green: 1.0,  blue: 1.0  },
  lightGray:  { red: 0.95, green: 0.95, blue: 0.95 },
  darkText:   { red: 0.2,  green: 0.2,  blue: 0.2  },
  mutedText:  { red: 0.5,  green: 0.5,  blue: 0.5  },
};

/**
 * Create a new presentation.
 */
export async function createPresentation(title, folderId) {
  const slides = getSlides();
  const drive = getDrive();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await slides.presentations.create({
        requestBody: { title },
      });

      const presentationId = res.data.presentationId;

      // Move to folder if specified
      if (folderId) {
        const file = await drive.files.get({ fileId: presentationId, fields: 'parents' });
        const previousParents = file.data.parents?.join(',') || '';
        await drive.files.update({
          fileId: presentationId,
          addParents: folderId,
          removeParents: previousParents,
          fields: 'id, parents',
        });
      }

      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;
      log.info(`Created presentation: ${title}`, { presentationId });
      return { presentationId, url };
    }, { retries: 3, label: 'Google Slides create', shouldRetry: (err) => !(err.message || '').includes('does not have permission') })
  );
}

/**
 * Apply batch updates to a presentation.
 */
export async function batchUpdate(presentationId, requests) {
  const slides = getSlides();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests },
      });
      return res.data;
    }, { retries: 3, label: 'Google Slides update' })
  );
}

// ============================================================
// Creative Deck Builder
// ============================================================

/**
 * Build a full creative presentation deck for client approval.
 *
 * @param {object} opts
 * @param {string} opts.clientName - Client name
 * @param {string} opts.campaignName - Campaign name
 * @param {string} opts.platform - Platform
 * @param {Array} opts.textAds - Array of { headline, description, body, cta, angle }
 * @param {Array} opts.images - Array of { url, format, label, concept }
 * @param {Array} opts.videos - Array of { url, duration, format, concept }
 * @param {string} opts.summary - Campaign summary text
 * @param {string} opts.folderId - Google Drive folder
 * @returns {object} { presentationId, url }
 */
export async function buildCreativeDeck(opts = {}) {
  const date = new Date().toISOString().split('T')[0];
  const title = `${opts.clientName} — Creative Deck — ${opts.campaignName || opts.platform || 'Campaign'} — ${date}`;

  const presentation = await createPresentation(title, opts.folderId);
  const { presentationId } = presentation;
  const requests = [];
  let slideIndex = 0;

  // We need to delete the default empty slide, then create our own
  // First get the presentation to find the default slide ID
  const slides = getSlides();
  const pres = await slides.presentations.get({ presentationId });
  const defaultSlideId = pres.data.slides?.[0]?.objectId;

  // --- Slide 1: Title Slide ---
  const titleSlideId = `slide_title_${Date.now()}`;
  requests.push({
    createSlide: {
      objectId: titleSlideId,
      insertionIndex: slideIndex++,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });

  // Title text
  const titleBoxId = `title_main_${Date.now()}`;
  requests.push(
    ...createTextBox(titleSlideId, titleBoxId, {
      x: 50, y: 120, width: 620, height: 80,
      text: opts.clientName,
      fontSize: 36, bold: true, color: COLORS.primary,
    }),
  );

  // Subtitle
  const subtitleBoxId = `title_sub_${Date.now()}`;
  requests.push(
    ...createTextBox(titleSlideId, subtitleBoxId, {
      x: 50, y: 210, width: 620, height: 50,
      text: `${opts.campaignName || 'Campaign'} Creative Presentation`,
      fontSize: 20, color: COLORS.secondary,
    }),
  );

  // Date + platform
  const dateBoxId = `title_date_${Date.now()}`;
  requests.push(
    ...createTextBox(titleSlideId, dateBoxId, {
      x: 50, y: 280, width: 620, height: 30,
      text: `${date} • ${(opts.platform || 'Multi-platform').toUpperCase()} • FOR APPROVAL`,
      fontSize: 12, color: COLORS.mutedText,
    }),
  );

  // --- Slide 2: Campaign Summary ---
  if (opts.summary) {
    const summarySlideId = `slide_summary_${Date.now()}`;
    requests.push({
      createSlide: {
        objectId: summarySlideId,
        insertionIndex: slideIndex++,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });

    const summaryHeaderId = `summary_header_${Date.now()}`;
    requests.push(
      createTextBox(summarySlideId, summaryHeaderId, {
        x: 50, y: 30, width: 620, height: 40,
        text: 'Campaign Strategy',
        fontSize: 24, bold: true, color: COLORS.primary,
      }),
    );

    const summaryBodyId = `summary_body_${Date.now()}`;
    requests.push(
      createTextBox(summarySlideId, summaryBodyId, {
        x: 50, y: 80, width: 620, height: 300,
        text: opts.summary.slice(0, 2000),
        fontSize: 12, color: COLORS.darkText,
      }),
    );
  }

  // --- Text Ad Slides ---
  if (opts.textAds && opts.textAds.length > 0) {
    // Section divider
    const textDividerId = `slide_text_div_${Date.now()}`;
    requests.push({
      createSlide: {
        objectId: textDividerId,
        insertionIndex: slideIndex++,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });
    requests.push(
      createTextBox(textDividerId, `text_div_title_${Date.now()}`, {
        x: 50, y: 150, width: 620, height: 60,
        text: 'Text Ad Variations',
        fontSize: 32, bold: true, color: COLORS.primary,
      }),
    );
    requests.push(
      createTextBox(textDividerId, `text_div_count_${Date.now()}`, {
        x: 50, y: 220, width: 620, height: 30,
        text: `${opts.textAds.length} variations generated`,
        fontSize: 14, color: COLORS.mutedText,
      }),
    );

    // Each text ad gets a slide
    for (let i = 0; i < Math.min(opts.textAds.length, 15); i++) {
      const ad = opts.textAds[i];
      const adSlideId = `slide_text_${i}_${Date.now()}`;
      requests.push({
        createSlide: {
          objectId: adSlideId,
          insertionIndex: slideIndex++,
          slideLayoutReference: { predefinedLayout: 'BLANK' },
        },
      });

      // Variation number + angle
      requests.push(
        createTextBox(adSlideId, `text_var_${i}_${Date.now()}`, {
          x: 50, y: 20, width: 620, height: 25,
          text: `VARIATION ${i + 1}${ad.angle ? ` — ${ad.angle}` : ''}`,
          fontSize: 10, bold: true, color: COLORS.secondary,
        }),
      );

      // Headline
      requests.push(
        createTextBox(adSlideId, `text_hl_${i}_${Date.now()}`, {
          x: 50, y: 55, width: 620, height: 50,
          text: ad.headline || '',
          fontSize: 22, bold: true, color: COLORS.primary,
        }),
      );

      // Description/Body
      if (ad.description || ad.body) {
        requests.push(
          createTextBox(adSlideId, `text_body_${i}_${Date.now()}`, {
            x: 50, y: 115, width: 620, height: 100,
            text: ad.description || ad.body || '',
            fontSize: 14, color: COLORS.darkText,
          }),
        );
      }

      // CTA
      if (ad.cta) {
        requests.push(
          createTextBox(adSlideId, `text_cta_${i}_${Date.now()}`, {
            x: 50, y: 240, width: 200, height: 35,
            text: ad.cta,
            fontSize: 14, bold: true, color: COLORS.white,
            backgroundColor: COLORS.secondary,
          }),
        );
      }

      // Platform + char counts
      const charInfo = [
        ad.headline ? `Headline: ${ad.headline.length} chars` : '',
        (ad.description || ad.body) ? `Body: ${(ad.description || ad.body).length} chars` : '',
      ].filter(Boolean).join(' • ');

      requests.push(
        createTextBox(adSlideId, `text_info_${i}_${Date.now()}`, {
          x: 50, y: 340, width: 620, height: 20,
          text: charInfo,
          fontSize: 9, color: COLORS.mutedText,
        }),
      );
    }
  }

  // --- Image Creative Slides ---
  if (opts.images && opts.images.length > 0) {
    const imgDividerId = `slide_img_div_${Date.now()}`;
    requests.push({
      createSlide: {
        objectId: imgDividerId,
        insertionIndex: slideIndex++,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });
    requests.push(
      createTextBox(imgDividerId, `img_div_title_${Date.now()}`, {
        x: 50, y: 150, width: 620, height: 60,
        text: 'Visual Creatives',
        fontSize: 32, bold: true, color: COLORS.primary,
      }),
    );
    requests.push(
      createTextBox(imgDividerId, `img_div_count_${Date.now()}`, {
        x: 50, y: 220, width: 620, height: 30,
        text: `${opts.images.length} image${opts.images.length > 1 ? 's' : ''} generated with DALL-E 3`,
        fontSize: 14, color: COLORS.mutedText,
      }),
    );

    for (let i = 0; i < opts.images.length; i++) {
      const img = opts.images[i];
      if (img.error) continue;

      const imgSlideId = `slide_img_${i}_${Date.now()}`;
      requests.push({
        createSlide: {
          objectId: imgSlideId,
          insertionIndex: slideIndex++,
          slideLayoutReference: { predefinedLayout: 'BLANK' },
        },
      });

      // Image label
      requests.push(
        createTextBox(imgSlideId, `img_label_${i}_${Date.now()}`, {
          x: 50, y: 15, width: 620, height: 25,
          text: `${img.label || img.dimensions?.label || img.format || `Image ${i + 1}`}${img.concept ? ` — ${img.concept}` : ''}`,
          fontSize: 10, bold: true, color: COLORS.secondary,
        }),
      );

      // Insert the image
      if (img.url) {
        const imgObjId = `img_obj_${i}_${Date.now()}`;
        requests.push({
          createImage: {
            objectId: imgObjId,
            url: img.url,
            elementProperties: {
              pageObjectId: imgSlideId,
              size: {
                width: { magnitude: 500, unit: 'PT' },
                height: { magnitude: 300, unit: 'PT' },
              },
              transform: {
                scaleX: 1, scaleY: 1, translateX: 110, translateY: 50,
                unit: 'PT',
              },
            },
          },
        });
      }
    }
  }

  // --- Video Slides ---
  if (opts.videos && opts.videos.length > 0) {
    const vidDividerId = `slide_vid_div_${Date.now()}`;
    requests.push({
      createSlide: {
        objectId: vidDividerId,
        insertionIndex: slideIndex++,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });
    requests.push(
      createTextBox(vidDividerId, `vid_div_title_${Date.now()}`, {
        x: 50, y: 150, width: 620, height: 60,
        text: 'Video Creatives',
        fontSize: 32, bold: true, color: COLORS.primary,
      }),
    );
    requests.push(
      createTextBox(vidDividerId, `vid_div_count_${Date.now()}`, {
        x: 50, y: 220, width: 620, height: 30,
        text: `${opts.videos.length} video${opts.videos.length > 1 ? 's' : ''} generated with Sora 2`,
        fontSize: 14, color: COLORS.mutedText,
      }),
    );

    for (let i = 0; i < opts.videos.length; i++) {
      const vid = opts.videos[i];
      const vidSlideId = `slide_vid_${i}_${Date.now()}`;
      requests.push({
        createSlide: {
          objectId: vidSlideId,
          insertionIndex: slideIndex++,
          slideLayoutReference: { predefinedLayout: 'BLANK' },
        },
      });

      requests.push(
        createTextBox(vidSlideId, `vid_title_${i}_${Date.now()}`, {
          x: 50, y: 30, width: 620, height: 40,
          text: `Video ${i + 1}${vid.concept ? ` — ${vid.concept}` : ''}`,
          fontSize: 20, bold: true, color: COLORS.primary,
        }),
      );

      requests.push(
        createTextBox(vidSlideId, `vid_info_${i}_${Date.now()}`, {
          x: 50, y: 80, width: 620, height: 25,
          text: `${vid.duration || '?'}s • ${vid.resolution || '720p'} • ${vid.aspectRatio || '16:9'}`,
          fontSize: 12, color: COLORS.mutedText,
        }),
      );

      requests.push(
        createTextBox(vidSlideId, `vid_prompt_${i}_${Date.now()}`, {
          x: 50, y: 120, width: 620, height: 120,
          text: `Prompt: ${vid.prompt || 'N/A'}`,
          fontSize: 11, color: COLORS.darkText,
        }),
      );

      if (vid.url || vid.videoUrl) {
        requests.push(
          createTextBox(vidSlideId, `vid_link_${i}_${Date.now()}`, {
            x: 50, y: 260, width: 620, height: 25,
            text: `Video URL: ${vid.url || vid.videoUrl}`,
            fontSize: 10, color: COLORS.secondary,
          }),
        );
      }
    }
  }

  // --- Final Slide: Approval CTA ---
  const approvalSlideId = `slide_approval_${Date.now()}`;
  requests.push({
    createSlide: {
      objectId: approvalSlideId,
      insertionIndex: slideIndex++,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });
  requests.push(
    ...createTextBox(approvalSlideId, `approval_title_${Date.now()}`, {
      x: 50, y: 130, width: 620, height: 60,
      text: 'Ready for Approval',
      fontSize: 32, bold: true, color: COLORS.primary,
    }),
  );
  requests.push(
    ...createTextBox(approvalSlideId, `approval_body_${Date.now()}`, {
      x: 50, y: 200, width: 620, height: 80,
      text: 'Review the creatives above and reply with your feedback.\nApproved creatives will be prepared for launch.',
      fontSize: 16, color: COLORS.darkText,
    }),
  );
  requests.push(
    ...createTextBox(approvalSlideId, `approval_stats_${Date.now()}`, {
      x: 50, y: 300, width: 620, height: 50,
      text: [
        opts.textAds?.length ? `${opts.textAds.length} text ads` : null,
        opts.images?.length ? `${opts.images.filter(i => !i.error).length} images` : null,
        opts.videos?.length ? `${opts.videos.length} videos` : null,
      ].filter(Boolean).join(' • '),
      fontSize: 14, color: COLORS.mutedText,
    }),
  );

  // Delete the default blank slide
  if (defaultSlideId) {
    requests.push({ deleteObject: { objectId: defaultSlideId } });
  }

  // Apply all updates
  await batchUpdate(presentationId, requests);

  log.info(`Creative deck built for ${opts.clientName}`, {
    presentationId,
    textAds: opts.textAds?.length || 0,
    images: opts.images?.length || 0,
    videos: opts.videos?.length || 0,
  });

  return presentation;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Helper: create a text box element on a slide.
 * Returns a flat array of requests (createShape + insertText + updateTextStyle).
 */
function createTextBox(slideId, boxId, opts) {
  const requests = [];

  requests.push({
    createShape: {
      objectId: boxId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: slideId,
        size: {
          width: { magnitude: opts.width, unit: 'PT' },
          height: { magnitude: opts.height, unit: 'PT' },
        },
        transform: {
          scaleX: 1, scaleY: 1,
          translateX: opts.x, translateY: opts.y,
          unit: 'PT',
        },
      },
    },
  });

  requests.push({
    insertText: {
      objectId: boxId,
      text: opts.text || '',
    },
  });

  const style = {
    fontSize: { magnitude: opts.fontSize || 14, unit: 'PT' },
    fontFamily: 'Inter',
  };
  if (opts.bold) style.bold = true;
  if (opts.color) style.foregroundColor = { opaqueColor: { rgbColor: opts.color } };

  requests.push({
    updateTextStyle: {
      objectId: boxId,
      style,
      textRange: { type: 'ALL' },
      fields: Object.keys(style).join(','),
    },
  });

  // Background color for the shape
  if (opts.backgroundColor) {
    requests.push({
      updateShapeProperties: {
        objectId: boxId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: {
              color: { rgbColor: opts.backgroundColor },
            },
          },
        },
        fields: 'shapeBackgroundFill',
      },
    });
  }

  return requests;
}

/**
 * Get the default slide ID from a newly created presentation.
 */
export async function getDefaultSlideId(presentationId) {
  const s = getSlides();
  const pres = await s.presentations.get({ presentationId });
  return pres.data.slides?.[0]?.objectId || null;
}

export default {
  createPresentation, batchUpdate, buildCreativeDeck, getDefaultSlideId,
};
