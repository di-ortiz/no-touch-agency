---
paths:
  - "src/**/*.js"
---

# Architecture Rules

- Use ESM imports/exports (`import`/`export`), never CommonJS (`require`)
- All async functions must have try/catch with `log.error()` and graceful fallback
- Use Winston child loggers: `const log = logger.child({ service: 'name' })`
- Rate limit all external API calls via `src/utils/rate-limiter.js`
- Record AI API costs via `cost-tracker.js` for every Claude/OpenAI call
- Use Zod schemas for config validation, JSON Schema for tool input validation
- Generate IDs with `uuid v4`
- Database operations go through `knowledge-base.js` service layer, never raw SQL in other files
- Workflows must handle errors per-client (don't fail entire batch for one client)
- WhatsApp messages use `*bold*` markdown, keep under 500 chars when possible
- Always send thinking indicators before expensive operations
- Deliver media (images, videos) inline via platform APIs, not as raw URLs
