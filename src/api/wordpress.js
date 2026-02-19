import axios from 'axios';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'wordpress' });

/**
 * Create a WordPress REST API client for a specific site.
 * Credentials come from Leadsie OAuth grant (stored in clients table).
 *
 * @param {object} opts
 * @param {string} opts.siteUrl - WordPress site URL (e.g. "https://example.com")
 * @param {string} opts.username - WordPress username
 * @param {string} opts.appPassword - Application password or OAuth token from Leadsie
 */
export function createClient({ siteUrl, username, appPassword }) {
  const baseURL = siteUrl.replace(/\/+$/, '');
  const apiBase = `${baseURL}/wp-json`;

  const api = axios.create({
    baseURL: apiBase,
    auth: { username, password: appPassword },
    timeout: 20000,
    headers: { 'Content-Type': 'application/json' },
  });

  async function request(method, path, data, params) {
    return rateLimited('wordpress', () =>
      retry(async () => {
        const res = await api({ method, url: path, data, params });
        return res.data;
      }, { retries: 2, label: `WP ${method} ${path}`, shouldRetry: isRetryableHttpError })
    );
  }

  return {
    // --- Site Info ---

    async getSiteInfo() {
      const info = await request('get', '/wp/v2/settings');
      return {
        title: info.title,
        description: info.description,
        url: info.url,
        timezone: info.timezone_string,
        language: info.language,
      };
    },

    async validateConnection() {
      try {
        const res = await request('get', '/wp/v2/users/me');
        return { connected: true, user: res.name, roles: res.roles, url: baseURL };
      } catch (e) {
        log.warn('WordPress connection validation failed', { url: baseURL, error: e.message });
        return { connected: false, error: e.message };
      }
    },

    // --- Posts ---

    async listPosts({ status = 'publish', perPage = 20, page = 1, search, categories, tags } = {}) {
      const params = { status, per_page: perPage, page, _fields: 'id,title,slug,status,date,modified,categories,tags,excerpt,link' };
      if (search) params.search = search;
      if (categories) params.categories = categories;
      if (tags) params.tags = tags;
      const posts = await request('get', '/wp/v2/posts', null, params);
      return posts.map(p => ({
        id: p.id,
        title: p.title?.rendered || '',
        slug: p.slug,
        status: p.status,
        date: p.date,
        modified: p.modified,
        categories: p.categories,
        tags: p.tags,
        excerpt: p.excerpt?.rendered?.replace(/<[^>]*>/g, '').trim() || '',
        link: p.link,
      }));
    },

    async getPost(postId) {
      const p = await request('get', `/wp/v2/posts/${postId}`);
      return {
        id: p.id,
        title: p.title?.rendered || '',
        slug: p.slug,
        status: p.status,
        content: p.content?.rendered || '',
        excerpt: p.excerpt?.rendered || '',
        date: p.date,
        modified: p.modified,
        categories: p.categories,
        tags: p.tags,
        featuredMedia: p.featured_media,
        link: p.link,
        meta: p.meta || {},
        yoastMeta: p.yoast_head_json || null,
      };
    },

    async createPost({ title, content, excerpt, status = 'draft', categories, tags, featuredMedia, slug, date, meta }) {
      const data = { title, content, status };
      if (excerpt) data.excerpt = excerpt;
      if (categories) data.categories = categories;
      if (tags) data.tags = tags;
      if (featuredMedia) data.featured_media = featuredMedia;
      if (slug) data.slug = slug;
      if (date) data.date = date; // ISO 8601 for scheduling
      if (meta) data.meta = meta;

      const p = await request('post', '/wp/v2/posts', data);
      log.info('WordPress post created', { id: p.id, title, status });
      return {
        id: p.id,
        title: p.title?.rendered || title,
        slug: p.slug,
        status: p.status,
        link: p.link,
        date: p.date,
      };
    },

    async updatePost(postId, updates) {
      const p = await request('post', `/wp/v2/posts/${postId}`, updates);
      log.info('WordPress post updated', { id: postId });
      return {
        id: p.id,
        title: p.title?.rendered || '',
        slug: p.slug,
        status: p.status,
        link: p.link,
        modified: p.modified,
      };
    },

    async schedulePost(postId, publishDate) {
      return this.updatePost(postId, { status: 'future', date: publishDate });
    },

    async deletePost(postId) {
      await request('delete', `/wp/v2/posts/${postId}`, null, { force: false }); // trash, not delete
      log.info('WordPress post trashed', { id: postId });
      return { id: postId, status: 'trashed' };
    },

    // --- Pages ---

    async listPages({ status = 'publish', perPage = 50 } = {}) {
      const pages = await request('get', '/wp/v2/pages', null, {
        status, per_page: perPage,
        _fields: 'id,title,slug,status,link,modified',
      });
      return pages.map(p => ({
        id: p.id,
        title: p.title?.rendered || '',
        slug: p.slug,
        status: p.status,
        link: p.link,
        modified: p.modified,
      }));
    },

    async getPage(pageId) {
      const p = await request('get', `/wp/v2/pages/${pageId}`);
      return {
        id: p.id,
        title: p.title?.rendered || '',
        slug: p.slug,
        content: p.content?.rendered || '',
        status: p.status,
        link: p.link,
        meta: p.meta || {},
        yoastMeta: p.yoast_head_json || null,
      };
    },

    async updatePage(pageId, updates) {
      const p = await request('post', `/wp/v2/pages/${pageId}`, updates);
      log.info('WordPress page updated', { id: pageId });
      return { id: p.id, title: p.title?.rendered || '', link: p.link };
    },

    // --- SEO Meta (Yoast SEO / Rank Math) ---

    async getPageSEO(pageId, type = 'posts') {
      const endpoint = type === 'pages' ? `/wp/v2/pages/${pageId}` : `/wp/v2/posts/${pageId}`;
      const p = await request('get', endpoint);
      return {
        id: p.id,
        title: p.title?.rendered || '',
        link: p.link,
        yoast: p.yoast_head_json || null,
        meta: p.meta || {},
        // Yoast fields (if Yoast SEO plugin installed)
        seoTitle: p.meta?._yoast_wpseo_title || p.yoast_head_json?.title || '',
        seoDescription: p.meta?._yoast_wpseo_metadesc || p.yoast_head_json?.description || '',
        focusKeyword: p.meta?._yoast_wpseo_focuskw || '',
        canonical: p.yoast_head_json?.canonical || p.link,
        ogTitle: p.yoast_head_json?.og_title || '',
        ogDescription: p.yoast_head_json?.og_description || '',
        schema: p.yoast_head_json?.schema || null,
      };
    },

    async updatePageSEO(pageId, seoData, type = 'posts') {
      const endpoint = type === 'pages' ? `/wp/v2/pages/${pageId}` : `/wp/v2/posts/${pageId}`;
      const meta = {};
      if (seoData.seoTitle) meta._yoast_wpseo_title = seoData.seoTitle;
      if (seoData.seoDescription) meta._yoast_wpseo_metadesc = seoData.seoDescription;
      if (seoData.focusKeyword) meta._yoast_wpseo_focuskw = seoData.focusKeyword;

      const p = await request('post', endpoint, { meta });
      log.info('WordPress SEO meta updated', { id: pageId, type });
      return { id: p.id, title: p.title?.rendered || '', meta: p.meta };
    },

    // --- Categories & Tags ---

    async listCategories() {
      const cats = await request('get', '/wp/v2/categories', null, { per_page: 100 });
      return cats.map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count }));
    },

    async createCategory(name, { description, parent } = {}) {
      const c = await request('post', '/wp/v2/categories', { name, description, parent });
      return { id: c.id, name: c.name, slug: c.slug };
    },

    async listTags({ search, perPage = 50 } = {}) {
      const params = { per_page: perPage };
      if (search) params.search = search;
      const tags = await request('get', '/wp/v2/tags', null, params);
      return tags.map(t => ({ id: t.id, name: t.name, slug: t.slug, count: t.count }));
    },

    async createTag(name) {
      const t = await request('post', '/wp/v2/tags', { name });
      return { id: t.id, name: t.name, slug: t.slug };
    },

    // --- Media ---

    async uploadMedia(buffer, filename, { mimeType = 'image/jpeg', altText, caption } = {}) {
      const res = await rateLimited('wordpress', () =>
        retry(async () => {
          const r = await api.post('/wp/v2/media', buffer, {
            headers: {
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Content-Type': mimeType,
            },
          });
          return r.data;
        }, { retries: 2, label: 'WP upload media', shouldRetry: isRetryableHttpError })
      );

      // Update alt text and caption if provided
      if (altText || caption) {
        await request('post', `/wp/v2/media/${res.id}`, {
          alt_text: altText || '',
          caption: caption || '',
        });
      }

      log.info('WordPress media uploaded', { id: res.id, filename });
      return {
        id: res.id,
        url: res.source_url,
        title: res.title?.rendered || filename,
        mimeType: res.mime_type,
      };
    },

    async listMedia({ perPage = 20, mimeType } = {}) {
      const params = { per_page: perPage, _fields: 'id,title,source_url,mime_type,date' };
      if (mimeType) params.mime_type = mimeType;
      const media = await request('get', '/wp/v2/media', null, params);
      return media.map(m => ({
        id: m.id,
        title: m.title?.rendered || '',
        url: m.source_url,
        mimeType: m.mime_type,
        date: m.date,
      }));
    },

    // --- Bulk Operations ---

    async getAllPagesSEO() {
      const [posts, pages] = await Promise.all([
        this.listPosts({ perPage: 100, status: 'publish' }),
        this.listPages({ perPage: 100 }),
      ]);

      const results = [];
      for (const p of [...posts, ...pages]) {
        try {
          const type = pages.find(pg => pg.id === p.id) ? 'pages' : 'posts';
          const seo = await this.getPageSEO(p.id, type);
          results.push({
            ...seo,
            type,
            slug: p.slug,
          });
        } catch (e) {
          results.push({ id: p.id, title: p.title, error: e.message });
        }
      }
      return results;
    },

    async bulkUpdateSEO(updates) {
      const results = [];
      for (const { pageId, type, seoData } of updates) {
        try {
          const result = await this.updatePageSEO(pageId, seoData, type);
          results.push({ ...result, status: 'updated' });
        } catch (e) {
          results.push({ id: pageId, status: 'failed', error: e.message });
        }
      }
      log.info('WordPress bulk SEO update', { total: updates.length, success: results.filter(r => r.status === 'updated').length });
      return results;
    },
  };
}

export default { createClient };
