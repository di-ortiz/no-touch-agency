import logger from '../utils/logger.js';

const log = logger.child({ service: 'template-engine' });

/**
 * Professional HTML/CSS ad template engine.
 * Templates use typography, brand colors, and geometric design — no AI image needed.
 * Each template returns complete HTML ready for Puppeteer screenshot.
 */

const GOOGLE_FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Montserrat:wght@400;600;700;800;900&family=Poppins:wght@400;600;700;800;900&display=swap" rel="stylesheet">`;

/**
 * All available template definitions.
 * Each has a name, label, and render function.
 */
const TEMPLATES = {
  'bold-gradient': {
    label: 'Bold Gradient',
    description: 'Full-bleed gradient background with large bold typography',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font, backgroundImageUrl } = props;
      const bgLayer = backgroundImageUrl
        ? `background: linear-gradient(135deg, ${colors.primary}dd, ${colors.secondary}dd), url('${backgroundImageUrl}') center/cover;`
        : `background: linear-gradient(135deg, ${colors.primary}, ${colors.secondary});`;
      return `
      <div style="width:${width}px;height:${height}px;${bgLayer}
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;">
        <h1 style="color:white;font-size:${fontSize(width, 72)};font-weight:900;margin:0 0 24px 0;line-height:1.05;letter-spacing:-2px;">
          ${headline}
        </h1>
        <p style="color:rgba(255,255,255,0.85);font-size:${fontSize(width, 32)};font-weight:400;margin:0 0 40px 0;line-height:1.4;max-width:80%;">
          ${subtext}
        </p>
        ${ctaButton(cta, { bg: 'white', color: colors.primary, fontSize: fontSize(width, 24) })}
      </div>`;
    },
  },

  'dark-premium': {
    label: 'Dark Premium',
    description: 'Dark background with elegant typography and accent line',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font, backgroundImageUrl } = props;
      const bgLayer = backgroundImageUrl
        ? `background: linear-gradient(180deg, #0a0a0aee, #1a1a1aee), url('${backgroundImageUrl}') center/cover;`
        : `background: #0a0a0a;`;
      return `
      <div style="width:${width}px;height:${height}px;${bgLayer}
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;position:relative;">
        <div style="position:absolute;top:80px;left:80px;width:60px;height:4px;background:${colors.primary};"></div>
        <h1 style="color:white;font-size:${fontSize(width, 68)};font-weight:800;margin:0 0 20px 0;line-height:1.08;letter-spacing:-1.5px;">
          ${headline}
        </h1>
        <p style="color:rgba(255,255,255,0.6);font-size:${fontSize(width, 28)};font-weight:400;margin:0 0 40px 0;line-height:1.5;max-width:75%;">
          ${subtext}
        </p>
        ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 22) })}
      </div>`;
    },
  },

  'split-diagonal': {
    label: 'Split Diagonal',
    description: 'Diagonal split with brand color and white sections',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font, backgroundImageUrl } = props;
      const imgSection = backgroundImageUrl
        ? `<div style="position:absolute;top:0;right:0;width:55%;height:100%;clip-path:polygon(20% 0,100% 0,100% 100%,0% 100%);overflow:hidden;">
            <img src="${backgroundImageUrl}" style="width:100%;height:100%;object-fit:cover;" />
            <div style="position:absolute;inset:0;background:${colors.primary}33;"></div>
           </div>`
        : `<div style="position:absolute;top:0;right:0;width:55%;height:100%;background:${colors.secondary || colors.primary};clip-path:polygon(20% 0,100% 0,100% 100%,0% 100%);"></div>`;
      return `
      <div style="width:${width}px;height:${height}px;background:white;position:relative;font-family:'${font}',sans-serif;overflow:hidden;">
        ${imgSection}
        <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;padding:80px;box-sizing:border-box;max-width:55%;">
          <h1 style="color:${colors.primary};font-size:${fontSize(width, 60)};font-weight:900;margin:0 0 20px 0;line-height:1.08;">
            ${headline}
          </h1>
          <p style="color:#444;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 36px 0;line-height:1.5;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20) })}
        </div>
      </div>`;
    },
  },

  'floating-card': {
    label: 'Floating Card',
    description: 'Central floating card on gradient background',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font, backgroundImageUrl } = props;
      const bgLayer = backgroundImageUrl
        ? `background: url('${backgroundImageUrl}') center/cover;`
        : `background: linear-gradient(160deg, ${colors.primary}22, ${colors.secondary || colors.primary}44);`;
      return `
      <div style="width:${width}px;height:${height}px;${bgLayer}
        display:flex;align-items:center;justify-content:center;font-family:'${font}',sans-serif;">
        <div style="background:white;border-radius:24px;padding:60px;max-width:80%;box-shadow:0 20px 60px rgba(0,0,0,0.15);text-align:center;">
          <h1 style="color:${colors.primary};font-size:${fontSize(width, 56)};font-weight:900;margin:0 0 16px 0;line-height:1.1;">
            ${headline}
          </h1>
          <p style="color:#555;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 32px 0;line-height:1.5;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 22), center: true })}
        </div>
      </div>`;
    },
  },

  'geometric-blocks': {
    label: 'Geometric Blocks',
    description: 'Overlapping geometric shapes with bold text',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:#f5f5f5;position:relative;font-family:'${font}',sans-serif;overflow:hidden;">
        <div style="position:absolute;top:-10%;right:-5%;width:60%;height:70%;background:${colors.primary};border-radius:32px;transform:rotate(-12deg);opacity:0.9;"></div>
        <div style="position:absolute;bottom:-15%;left:10%;width:50%;height:50%;background:${colors.secondary || colors.primary};border-radius:50%;opacity:0.3;"></div>
        <div style="position:absolute;top:15%;left:5%;width:25%;height:25%;background:${colors.primary}44;border-radius:16px;transform:rotate(8deg);"></div>
        <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;padding:80px;box-sizing:border-box;">
          <h1 style="color:#1a1a1a;font-size:${fontSize(width, 64)};font-weight:900;margin:0 0 20px 0;line-height:1.05;">
            ${headline}
          </h1>
          <p style="color:#444;font-size:${fontSize(width, 28)};font-weight:400;margin:0 0 36px 0;line-height:1.4;max-width:70%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: '#1a1a1a', color: 'white', fontSize: fontSize(width, 22) })}
        </div>
      </div>`;
    },
  },

  'minimal-clean': {
    label: 'Minimal Clean',
    description: 'White space-heavy minimal design',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      const isStory = height > width;
      return `
      <div style="width:${width}px;height:${height}px;background:white;
        display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;
        padding:${isStory ? '120px 60px' : '80px'};box-sizing:border-box;font-family:'${font}',sans-serif;">
        <div style="width:48px;height:48px;border-radius:50%;background:${colors.primary};margin-bottom:40px;"></div>
        <h1 style="color:#1a1a1a;font-size:${fontSize(width, 58)};font-weight:800;margin:0 0 20px 0;line-height:1.1;letter-spacing:-1px;">
          ${headline}
        </h1>
        <p style="color:#888;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 40px 0;line-height:1.5;max-width:80%;">
          ${subtext}
        </p>
        ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20), center: true })}
      </div>`;
    },
  },

  'text-hero': {
    label: 'Text Hero',
    description: 'Oversized headline as the hero element',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:${colors.primary};
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;">
        <h1 style="color:white;font-size:${fontSize(width, 96)};font-weight:900;margin:0 0 24px 0;line-height:0.95;letter-spacing:-3px;text-transform:uppercase;">
          ${headline}
        </h1>
        <p style="color:rgba(255,255,255,0.7);font-size:${fontSize(width, 28)};font-weight:500;margin:0 0 40px 0;line-height:1.4;max-width:70%;">
          ${subtext}
        </p>
        ${ctaButton(cta, { bg: 'white', color: colors.primary, fontSize: fontSize(width, 22) })}
      </div>`;
    },
  },

  'neon-glow': {
    label: 'Neon Glow',
    description: 'Dark background with neon-colored accents and glow effects',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:#0d0d0d;
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;position:relative;overflow:hidden;">
        <div style="position:absolute;top:20%;right:15%;width:300px;height:300px;background:${colors.primary};filter:blur(120px);opacity:0.3;border-radius:50%;"></div>
        <div style="position:absolute;bottom:10%;left:10%;width:200px;height:200px;background:${colors.secondary || '#ff00ff'};filter:blur(100px);opacity:0.2;border-radius:50%;"></div>
        <div style="position:relative;z-index:2;">
          <h1 style="color:white;font-size:${fontSize(width, 68)};font-weight:900;margin:0 0 20px 0;line-height:1.05;letter-spacing:-1px;text-shadow:0 0 40px ${colors.primary}66;">
            ${headline}
          </h1>
          <p style="color:rgba(255,255,255,0.6);font-size:${fontSize(width, 28)};font-weight:400;margin:0 0 40px 0;line-height:1.5;max-width:75%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 22), glow: colors.primary })}
        </div>
      </div>`;
    },
  },

  'corner-accent': {
    label: 'Corner Accent',
    description: 'Clean layout with bold corner accent shapes',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:white;position:relative;font-family:'${font}',sans-serif;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;width:40%;height:35%;background:${colors.primary};border-radius:0 0 40px 0;"></div>
        <div style="position:absolute;bottom:0;right:0;width:30%;height:25%;background:${colors.secondary || colors.primary};opacity:0.15;border-radius:40px 0 0 0;"></div>
        <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:flex-end;height:100%;padding:80px;box-sizing:border-box;">
          <h1 style="color:#1a1a1a;font-size:${fontSize(width, 60)};font-weight:900;margin:0 0 16px 0;line-height:1.08;">
            ${headline}
          </h1>
          <p style="color:#666;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 36px 0;line-height:1.5;max-width:80%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20) })}
        </div>
      </div>`;
    },
  },

  'gradient-mesh': {
    label: 'Gradient Mesh',
    description: 'Multi-point gradient mesh background',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      const sec = colors.secondary || shiftHue(colors.primary);
      return `
      <div style="width:${width}px;height:${height}px;background:linear-gradient(135deg,${colors.primary},${sec},${colors.primary});
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;position:relative;overflow:hidden;">
        <div style="position:absolute;top:-20%;left:-20%;width:60%;height:60%;background:${sec};filter:blur(80px);opacity:0.5;border-radius:50%;"></div>
        <div style="position:absolute;bottom:-10%;right:-10%;width:50%;height:50%;background:${colors.primary};filter:blur(60px);opacity:0.4;border-radius:50%;"></div>
        <div style="position:relative;z-index:2;">
          <h1 style="color:white;font-size:${fontSize(width, 66)};font-weight:900;margin:0 0 20px 0;line-height:1.05;letter-spacing:-1.5px;">
            ${headline}
          </h1>
          <p style="color:rgba(255,255,255,0.85);font-size:${fontSize(width, 28)};font-weight:400;margin:0 0 36px 0;line-height:1.5;max-width:80%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: 'rgba(255,255,255,0.95)', color: colors.primary, fontSize: fontSize(width, 22) })}
        </div>
      </div>`;
    },
  },

  'duotone': {
    label: 'Duotone',
    description: 'Two-tone split with contrasting text',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      const isStory = height > width;
      const splitPct = isStory ? '45%' : '50%';
      return `
      <div style="width:${width}px;height:${height}px;position:relative;font-family:'${font}',sans-serif;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;width:100%;height:${splitPct};background:${colors.primary};"></div>
        <div style="position:absolute;bottom:0;left:0;width:100%;height:calc(100% - ${splitPct});background:white;"></div>
        <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;height:100%;padding:80px;box-sizing:border-box;">
          <h1 style="color:white;font-size:${fontSize(width, 64)};font-weight:900;margin:0 0 24px 0;line-height:1.05;">
            ${headline}
          </h1>
          <p style="color:#444;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 36px 0;line-height:1.5;max-width:75%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 22), center: true })}
        </div>
      </div>`;
    },
  },

  'outline-bold': {
    label: 'Outline Bold',
    description: 'Outlined text with thick border frame',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:white;
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;">
        <div style="border:6px solid ${colors.primary};padding:60px;border-radius:4px;">
          <h1 style="color:${colors.primary};font-size:${fontSize(width, 62)};font-weight:900;margin:0 0 16px 0;line-height:1.08;text-transform:uppercase;letter-spacing:2px;">
            ${headline}
          </h1>
          <p style="color:#555;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 32px 0;line-height:1.5;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20) })}
        </div>
      </div>`;
    },
  },

  'stacked-impact': {
    label: 'Stacked Impact',
    description: 'Stacked large words with heavy weight',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      // Split headline into words for stacking
      const words = (headline || '').split(' ').slice(0, 4);
      const stacked = words.map(w =>
        `<div style="color:${colors.primary};font-size:${fontSize(width, 88)};font-weight:900;line-height:0.95;letter-spacing:-3px;text-transform:uppercase;">${w}</div>`
      ).join('');
      return `
      <div style="width:${width}px;height:${height}px;background:#fafafa;
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;">
        ${stacked}
        <p style="color:#666;font-size:${fontSize(width, 26)};font-weight:400;margin:24px 0 36px 0;line-height:1.5;max-width:75%;">
          ${subtext}
        </p>
        ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20) })}
      </div>`;
    },
  },

  'glass-morphism': {
    label: 'Glass Morphism',
    description: 'Frosted glass card on colorful background',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font, backgroundImageUrl } = props;
      const bgLayer = backgroundImageUrl
        ? `background: url('${backgroundImageUrl}') center/cover;`
        : `background: linear-gradient(135deg, ${colors.primary}, ${colors.secondary || shiftHue(colors.primary)});`;
      return `
      <div style="width:${width}px;height:${height}px;${bgLayer}
        display:flex;align-items:center;justify-content:center;font-family:'${font}',sans-serif;">
        <div style="background:rgba(255,255,255,0.15);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
          border:1px solid rgba(255,255,255,0.25);border-radius:32px;padding:60px;max-width:82%;text-align:center;">
          <h1 style="color:white;font-size:${fontSize(width, 58)};font-weight:800;margin:0 0 16px 0;line-height:1.1;">
            ${headline}
          </h1>
          <p style="color:rgba(255,255,255,0.8);font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 32px 0;line-height:1.5;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: 'white', color: colors.primary, fontSize: fontSize(width, 22), center: true })}
        </div>
      </div>`;
    },
  },

  'brutalist': {
    label: 'Brutalist',
    description: 'Raw brutalist design with sharp edges and heavy type',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:#fffef0;
        display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:'${font}',sans-serif;position:relative;overflow:hidden;">
        <div style="position:absolute;top:40px;right:40px;width:120px;height:120px;border:8px solid ${colors.primary};"></div>
        <h1 style="color:#0a0a0a;font-size:${fontSize(width, 74)};font-weight:900;margin:0 0 16px 0;line-height:0.98;letter-spacing:-2px;text-transform:uppercase;">
          ${headline}
        </h1>
        <div style="width:100%;height:6px;background:${colors.primary};margin:16px 0 24px 0;"></div>
        <p style="color:#333;font-size:${fontSize(width, 28)};font-weight:400;margin:0 0 36px 0;line-height:1.4;max-width:80%;">
          ${subtext}
        </p>
        ${cta ? `<div style="display:inline-block;background:${colors.primary};color:white;padding:18px 40px;
          font-size:${fontSize(width, 22)};font-weight:800;text-transform:uppercase;letter-spacing:2px;">${cta}</div>` : ''}
      </div>`;
    },
  },

  'side-stripe': {
    label: 'Side Stripe',
    description: 'Vertical accent stripe on the left with clean text',
    render: (props) => {
      const { headline, subtext, cta, colors, width, height, font } = props;
      return `
      <div style="width:${width}px;height:${height}px;background:white;display:flex;font-family:'${font}',sans-serif;">
        <div style="width:12px;background:linear-gradient(180deg,${colors.primary},${colors.secondary || colors.primary});flex-shrink:0;"></div>
        <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:60px 70px;box-sizing:border-box;">
          <h1 style="color:#1a1a1a;font-size:${fontSize(width, 58)};font-weight:800;margin:0 0 16px 0;line-height:1.1;">
            ${headline}
          </h1>
          <p style="color:#666;font-size:${fontSize(width, 26)};font-weight:400;margin:0 0 36px 0;line-height:1.5;max-width:85%;">
            ${subtext}
          </p>
          ${ctaButton(cta, { bg: colors.primary, color: 'white', fontSize: fontSize(width, 20) })}
        </div>
      </div>`;
    },
  },
};

// --- Helpers ---

/**
 * Scale font size proportionally. Base sizes are for 1080px width.
 */
function fontSize(width, basePx) {
  const scale = width / 1080;
  return `${Math.round(basePx * scale)}px`;
}

/**
 * Generate a CTA button HTML snippet.
 */
function ctaButton(text, opts = {}) {
  if (!text) return '';
  const glowStyle = opts.glow ? `box-shadow:0 0 30px ${opts.glow}66;` : '';
  const align = opts.center ? 'margin-left:auto;margin-right:auto;' : '';
  return `<div style="display:inline-block;background:${opts.bg || '#000'};color:${opts.color || '#fff'};
    padding:16px 40px;border-radius:50px;font-size:${opts.fontSize || '22px'};font-weight:700;${glowStyle}${align}">
    ${text}
  </div>`;
}

/**
 * Simple hue shift for generating a secondary color when not provided.
 */
function shiftHue(hex) {
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Rotate channels
    return `#${b.toString(16).padStart(2, '0')}${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}`;
  } catch {
    return '#6366f1';
  }
}

/**
 * Sanitize text for HTML injection safety.
 */
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Parse brand colors from brandDNA or fallback.
 */
function parseColors(brandDNA) {
  const colors = brandDNA?.primary_colors || [];
  const primary = colors[0] || '#6366f1';
  // Use secondary_colors array first, fallback to second primary color
  const secondary = brandDNA?.secondary_colors?.[0] || colors[1] || null;
  return { primary, secondary };
}

/**
 * Choose a font: prefer brand's actual font from DNA, fallback to tone-based selection.
 */
function chooseFont(brandDNA) {
  // If brand DNA has actual detected fonts from the website, use the first one
  if (brandDNA?.fonts?.length > 0) {
    return brandDNA.fonts[0];
  }
  const tone = (brandDNA?.tone_of_voice || '').toLowerCase();
  if (tone.includes('premium') || tone.includes('luxury') || tone.includes('elegant')) return 'Montserrat';
  if (tone.includes('friendly') || tone.includes('casual') || tone.includes('warm')) return 'Poppins';
  return 'Inter';
}

/**
 * Build the Google Fonts <link> tag, including brand-specific fonts if available.
 */
function buildFontsLink(brandDNA) {
  // If brand DNA has a Google Fonts URL from the actual site, include it
  const extraFontsLink = brandDNA?.google_fonts_url
    ? `<link href="${brandDNA.google_fonts_url}" rel="stylesheet">`
    : '';
  // Also load brand fonts by name if they're known Google Fonts families
  const brandFonts = brandDNA?.fonts || [];
  const brandFontFamilies = brandFonts
    .filter(f => !['Inter', 'Montserrat', 'Poppins'].includes(f)) // skip already loaded
    .map(f => `family=${encodeURIComponent(f)}:wght@400;600;700;800;900`)
    .join('&');
  const brandFontsLink = brandFontFamilies
    ? `<link href="https://fonts.googleapis.com/css2?${brandFontFamilies}&display=swap" rel="stylesheet">`
    : '';
  return `${GOOGLE_FONTS_LINK}\n${extraFontsLink}\n${brandFontsLink}`;
}

// --- Public API ---

/**
 * Get list of all available template names.
 * @returns {string[]}
 */
export function getTemplateNames() {
  return Object.keys(TEMPLATES);
}

/**
 * Get template metadata (name, label, description) for all templates.
 * @returns {Array<{name: string, label: string, description: string}>}
 */
export function getTemplateList() {
  return Object.entries(TEMPLATES).map(([name, t]) => ({
    name,
    label: t.label,
    description: t.description,
  }));
}

/**
 * Select a template by name, or pick a random one.
 * @param {string} [styleName] - Template name, or null/undefined for random
 * @returns {{ name: string, template: object }}
 */
export function selectTemplate(styleName) {
  if (styleName && TEMPLATES[styleName]) {
    return { name: styleName, template: TEMPLATES[styleName] };
  }
  const names = Object.keys(TEMPLATES);
  const pick = names[Math.floor(Math.random() * names.length)];
  log.info('Randomly selected template', { template: pick });
  return { name: pick, template: TEMPLATES[pick] };
}

/**
 * Render a complete HTML page for a given template.
 *
 * @param {string} templateName - Template name (or null for random)
 * @param {object} adCopy - { headline, subtext, cta }
 * @param {object} brandDNA - Brand DNA JSON
 * @param {object} [opts] - { format: 'feed'|'story', backgroundImageUrl?: string }
 * @returns {{ html: string, templateName: string, width: number, height: number }}
 */
export function renderTemplateHtml(templateName, adCopy, brandDNA, opts = {}) {
  const { name, template } = selectTemplate(templateName);
  const format = opts.format || 'feed';
  const width = 1080;
  const height = format === 'story' ? 1920 : 1080;
  const colors = parseColors(brandDNA);
  const font = chooseFont(brandDNA);

  const props = {
    headline: escapeHtml(adCopy?.headline || ''),
    subtext: escapeHtml(adCopy?.subtext || ''),
    cta: escapeHtml(adCopy?.cta || ''),
    colors,
    width,
    height,
    font,
    backgroundImageUrl: opts.backgroundImageUrl || null,
  };

  const body = template.render(props);
  const fontsLink = buildFontsLink(brandDNA);

  // Build logo overlay if brand DNA has a logo URL
  const logoUrl = brandDNA?.logo_url || brandDNA?.favicon_url;
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" style="position:absolute;top:40px;left:40px;max-height:60px;max-width:180px;object-fit:contain;z-index:10;" onerror="this.style.display='none'" />`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  ${fontsLink}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
  </style>
</head>
<body>
  ${body}
  ${logoHtml}
</body>
</html>`;

  log.info('Template HTML rendered', { template: name, format, width, height, font, hasLogo: !!logoUrl });
  return { html, templateName: name, width, height };
}

export default {
  getTemplateNames,
  getTemplateList,
  selectTemplate,
  renderTemplateHtml,
};
