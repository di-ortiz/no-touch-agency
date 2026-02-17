---
name: onboarding
description: Client onboarding flow for new PPC clients. Use this skill when modifying the onboarding process, welcome messages, questionnaire steps, or client activation.
user-invocable: true
---

# Client Onboarding Flow

## Overview

New clients go through a conversational onboarding via WhatsApp or Telegram. Sofia guides them through 20 questions, one at a time, then auto-provisions their infrastructure.

## Flow Sequence

### 1. Pre-Activation (Website)
- Client submits payment form on website
- `POST /api/client-init` stores them in `pending_clients` table with unique token
- System generates deep links: `wa.me/{phone}?text={token}` / `t.me/{bot}?start={token}`
- Language captured from website conversion page (en/es/pt)

### 2. Activation (First Message)
- Client opens WhatsApp/Telegram and sends their token
- Sofia recognizes token → creates `onboarding_sessions` record
- Sends personalized welcome via `buildPersonalizedWelcome(pendingData, language)`:
  - Greeting by name
  - Client code (token)
  - Plan details (modules, messages/day)
  - 3 next steps overview

### 3. Conversational Questionnaire (20 Steps)
Each step asks ONE question. Sofia uses Claude to extract the answer from natural language.

Steps in order:
1. `name` — Confirm contact name
2. `business_name` — Company/brand name
3. `website` — Website URL
4. `industry` — Industry/vertical
5. `product_service` — Main product or service
6. `description` — Brief business description
7. `target_audience` — Who they sell to
8. `location` — Geographic targeting
9. `competitors` — Main competitors
10. `goals` — Business/marketing goals
11. `primary_kpi` — Primary KPI (ROAS, CPA, leads, etc.)
12. `monthly_budget` — Monthly ad budget
13. `target_roas` — Target ROAS (if applicable)
14. `target_cpa` — Target CPA (if applicable)
15. `channels_have` — Current ad platforms
16. `channels_need` — Desired platforms
17. `current_campaigns` — Running campaigns?
18. `brand_voice` — Brand tone/voice
19. `sales_process` — Sales cycle description
20. `additional_info` — Anything else

### 4. Post-Questionnaire
- Create Google Drive folder structure (`setup_client_drive`)
- Generate Leadsie invite link for ad account access
- Request brand assets (logo, guidelines, past creatives)
- Create client profile in `clients` table
- Mark onboarding_sessions.status = 'complete'

## Plan Tiers

```javascript
const PLAN_INFO = {
  smb:        { modules: 3, dailyMessages: 20, label: 'SMB' },
  medium:     { modules: 6, dailyMessages: 50, label: 'Medium' },
  enterprise: { modules: 8, dailyMessages: 200, label: 'Enterprise' },
};
```

## Multi-Language Welcome

Welcome messages exist in 3 languages (en, es, pt) in `buildPersonalizedWelcome()`.
Each includes:
- `Hey *{name}*! I'm Sofia, your dedicated account manager.`
- `Your client code: *{token}*`
- `Plan: *{plan}* (up to {modules} modules, {messages} messages/day)`
- 3 next steps

## Key Files

- `src/services/client-onboarding-flow.js` — State machine, welcome builder, question handler
- `src/services/knowledge-base.js` — DB operations: createClient, createContact, pending_clients
- `src/commands/whatsapp-server.js` — Token recognition, session creation, message routing
- `src/api/leadsie.js` — Leadsie invite link generation

## Important Rules

- NEVER skip a step or ask multiple questions at once
- Always persist session state so client can resume later
- Validate answers gently — if unclear, ask for clarification
- Support language switching mid-onboarding if detected
- Token matching is case-insensitive
- Cross-channel: client can start on WhatsApp, continue on Telegram (linked by token)
