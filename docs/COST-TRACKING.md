# Cost Tracking & Management

## How Costs Are Tracked

Every API call to Claude or other AI services is recorded in a SQLite database (`data/costs.db`) with:
- Platform (anthropic, openai)
- Model used
- Input/output token counts
- Calculated cost in cents
- Workflow that triggered it
- Client ID (for per-client billing)

## Model Pricing (per 1K tokens)

| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| Claude Sonnet 4.5 | $0.003 | $0.015 | Deep analysis, reports, strategy |
| Claude Haiku 3.5 | $0.0008 | $0.004 | Command parsing, quick analysis |
| GPT-4o | $0.0025 | $0.01 | Fallback |
| DALL-E 3 | $0.04/image | — | Creative concepts |

## Token Optimization Strategies
- Use Haiku for simple tasks (command parsing, data formatting)
- Use Sonnet for complex analysis (strategy, reports, anomaly detection)
- Cache client profiles in system prompts with Claude's prompt caching
- Batch similar requests when possible
- Keep prompts concise (templates in `src/prompts/templates.js`)

## Reports

```bash
# View cost report
npm run cost-report

# Via WhatsApp
"AI cost report"        # Monthly summary
"cost report today"     # Today only
"cost report week"      # Last 7 days
```

## Budget Settings (in .env)
- `MONTHLY_AI_BUDGET_CENTS=100000` — $1,000/month cap
- `DAILY_COST_ALERT_THRESHOLD_CENTS=5000` — Alert if daily cost > $50

## Target: $500-1000/month for 20 clients
- ~$25-50 per client per month for AI operations
- Morning briefing: ~$0.50/day (1 Sonnet call)
- Performance monitor: ~$0.30/run x 3/day = $0.90/day
- Command parsing: ~$0.01/command (Haiku)
- Weekly reports: ~$1.00/client x 20 = $20/week
- Monthly deep analysis: ~$2.00/client x 20 = $40/month
