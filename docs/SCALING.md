# Scaling Guide

## Adding New Clients

1. Add to knowledge base via code or API:
```javascript
import { createClient } from './src/services/knowledge-base.js';
createClient({ name: 'New Client', industry: '...', ... });
```

2. Link ad accounts by setting `metaAdAccountId`, `googleAdsCustomerId`, etc.
3. Create Google Drive folder structure: `ensureClientFolders('New Client')`
4. Create ClickUp project: `createOnboardingProject('New Client', listId)`

All workflows automatically pick up new clients — no code changes needed.

## Adding New Platforms

1. Create API client in `src/api/new-platform.js` following existing patterns
2. Add rate limiter entry in `src/utils/rate-limiter.js`
3. Add credentials to `.env.example` and `src/config.js`
4. Update monitoring workflows to pull data from new platform
5. Add platform to knowledge base client schema if needed

## Adding New Workflows

1. Create file in `src/workflows/new-workflow.js`
2. Register in scheduler (`src/services/scheduler.js` > `initializeSchedule`)
3. Add WhatsApp command if manual trigger needed
4. Add prompt templates in `src/prompts/templates.js`
5. Document in `docs/WORKFLOWS.md`

## Migration Path

### Current: Node.js + SQLite
Good for 20-50 clients. Single-server deployment.

### Scale to 50-100 clients:
- Move SQLite to PostgreSQL for concurrent access
- Add Redis for caching and job queues
- Deploy webhook server and scheduler separately
- Use Bull/BullMQ for job queue management

### Scale to 100+ clients:
- Microservices architecture (separate service per workflow)
- Kubernetes deployment for auto-scaling
- Dedicated databases per concern (costs, knowledge, audit)
- Message queue (RabbitMQ/Kafka) for workflow orchestration

## Make.com Integration

The system is designed to work standalone, but key workflows can be replicated in Make.com for visual management:
- Export workflow logic as Make.com scenarios
- Use Make.com HTTP modules to call this system's API
- Gradual migration: run both in parallel, then cut over

## Performance Tips

- The system processes clients sequentially per workflow. For 20 clients, each monitoring run takes 2-5 minutes.
- Rate limiters prevent API throttling.
- SQLite WAL mode handles concurrent reads well.
- Log rotation prevents disk fill (10MB per file, 10 files max).
