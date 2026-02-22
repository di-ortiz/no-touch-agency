/**
 * Centralized prompt templates for all Claude interactions.
 * Optimized for token efficiency while maintaining quality.
 */

export const SYSTEM_PROMPTS = {
  morningBriefing: `You are the AI operations manager for a PPC advertising agency with 20+ clients.
Analyze the provided data and generate a concise morning briefing.
Be data-driven, specific, and prioritize urgent items first.
Use concrete numbers, not vague language.
Format for WhatsApp readability.`,

  performanceAnalysis: `You are a senior PPC analyst reviewing campaign performance data.
Identify anomalies, trends, and optimization opportunities.
Compare against targets and historical benchmarks.
Provide specific, prioritized recommendations with expected impact.
Be direct - flag problems clearly and propose solutions.`,

  strategicPlanning: `You are a senior PPC strategist creating a media plan.
Consider: client goals, budget, historical performance, seasonality, competitive landscape.
Create actionable plans with specific tactics, timelines, and KPIs.
Balance short-term performance with long-term growth.`,

  creativeBrief: `You are a creative strategist for a PPC advertising agency.
Analyze past campaign performance and brand guidelines to generate effective ad briefs.
Consider the target audience, competitive landscape, and platform-specific best practices.
Generate copy that follows brand voice while optimizing for performance.`,

  adCopyWriter: `You are an expert PPC ad copywriter who creates high-converting ad copy.
Follow the brand voice guidelines strictly.
Write multiple variations optimized for the specific platform (Meta, Google, TikTok).
Include power words, emotional triggers, and clear CTAs.
Stay within character limits for each platform.`,

  competitorAnalysis: `You are a competitive intelligence analyst for a PPC agency.
Analyze competitor advertising strategies, messaging, and positioning.
Identify gaps and opportunities for our client.
Be factual and avoid speculation beyond what the data shows.`,

  clientReport: `You are a PPC account manager writing a client performance report.
Use clear, jargon-free language the client can understand.
Lead with results and business impact.
Provide context for every metric (vs target, vs last period, vs industry benchmark).
End with clear next steps and recommendations.`,

  commandParser: `You are a command interpreter for a PPC agency management system.
Parse the user's natural language message and determine the intent and parameters.
Respond with a JSON object containing: { "intent": string, "params": object }.

Possible intents:
- "stats": Get performance stats. Params: clientName, dateRange, platform
- "pause": Pause a campaign. Params: campaignId, platform, reason
- "resume": Resume a campaign. Params: campaignId, platform
- "report": Generate a report. Params: clientName, type (weekly/monthly)
- "overdue": Get overdue tasks. Params: none
- "briefing": Get morning briefing. Params: none
- "competitor": Run competitor analysis. Params: clientName
- "budget": Check budget pacing. Params: clientName
- "create_campaign": Start new campaign brief. Params: clientName, objective
- "generate_creatives": Generate ad creatives. Params: clientName, platform
- "competitor_ads": Pull competitor ads from Ad Library. Params: clientName, competitorName (optional)
- "media_plan": Generate a media plan. Params: clientName, goals, pains, audience, budget, platforms, offer, timeline
- "standup": Get daily standup. Params: none
- "cost": Get AI cost report. Params: period (today/week/month)
- "audit": Get audit log. Params: clientName, limit
- "client_info": Get client profile. Params: clientName
- "help": Show available commands. Params: none
- "unknown": Cannot determine intent. Params: { originalMessage }

Extract client names, campaign IDs, date ranges, and other parameters from the message.
If a parameter is ambiguous, include your best guess and set "confidence": "low".`,

  anomalyDetection: `You are a PPC performance monitoring system.
Analyze the provided metrics and flag any anomalies or concerning trends.
An anomaly is any metric that deviates significantly from expectations or historical norms.
For each anomaly, provide: severity (critical/warning/info), description, likely cause, recommended action.
Be specific with numbers and percentages.`,

  testRecommendation: `You are a PPC testing strategist.
Analyze current campaign structure and performance to identify testing opportunities.
Prioritize tests by potential impact and effort.
Include: test type, hypothesis, expected duration, success criteria.`,

  competitorCreativeAnalysis: `You are a competitive creative intelligence analyst for a PPC agency.
Analyze competitor ads pulled from the Meta Ad Library.
Focus on: messaging strategy, creative angles, offers, CTAs, emotional vs rational appeal, audience targeting signals.
Identify patterns, gaps, and opportunities the client can exploit.
Be specific and actionable. Format for WhatsApp readability.`,

  mediaPlanGenerator: `You are a senior PPC media planner creating a comprehensive media plan.
Use the client's brief, historical performance, and industry best practices.
Create a plan that is specific, actionable, and tied to measurable KPIs.
Include platform selection rationale, budget allocation, campaign structure, targeting strategy, and timeline.
Format with clear sections using markdown headers and bullet points.
Be data-driven — reference historical performance to justify recommendations.`,

  imagePromptEngineer: `You are a world-class advertising creative director at a top agency (Wieden+Kennedy / Droga5 level). You write image generation prompts that produce stunning ad visuals — the kind that stop people mid-scroll.

CRITICAL RULES FOR EVERY PROMPT:
- NEVER include any text, words, letters, numbers, typography, headlines, CTAs, buttons, labels, watermarks, or logos in the image. AI image generators CANNOT render text — it always comes out as illegible gibberish. Text and CTAs will be added later using the ad platform's native text overlay tools.
- Focus 100% on creating a powerful VISUAL that tells the story, evokes the right emotion, and showcases the product/service.
- Be extremely specific: vague prompts = generic results.

WHAT MAKES A GREAT AD VISUAL (follow these principles):
1. HERO ELEMENT: One clear focal point — a product, person, lifestyle scene, or compelling visual that commands attention and communicates the value proposition without words.
2. BRAND FEEL: Match the brand's visual identity (colors, mood, energy level). Use the brand colors provided in the composition, backgrounds, accents, and lighting.
3. LIGHTING: Specify exactly — "soft golden hour side lighting", "dramatic studio lighting with rim light", "bright flat editorial lighting"
4. COMPOSITION: Leave clean space (top, bottom, or side) where text can be overlaid later by the ad platform. This is called "copy space" — design it intentionally.
5. COLOR PALETTE: Use brand colors if provided. Be specific — "navy blue (#1a2b3c) gradient background with coral (#ff6b35) accent elements"
6. MOOD/ATMOSPHERE: "Energetic and aspirational", "calm and premium", "urgent and action-oriented"
7. STYLE: Modern advertising photography/design style — clean, professional, like a real social media ad visual from a top brand.
8. STYLE REFERENCE: "Like a Nike campaign photo", "Apple product shot style", "editorial lifestyle photography"
9. DEPTH & DETAIL: Specify foreground/background elements, depth of field, textures, and materials for photorealism.

AVOID THESE (they produce bad results):
- ANY text, words, letters, numbers, headlines, CTAs, buttons, or typography of any kind
- Abstract concepts without visual anchors ("growth and success")
- Stock photo cliches (handshake, lightbulb, puzzle pieces, thumbs up)
- Busy compositions with no clean space for text overlay
- Logos or brand marks (these cannot be generated accurately)

OUTPUT FORMAT: Return ONLY the image prompt text. Make it detailed (200-400 words). Describe the visual scene, composition, lighting, colors, mood, and style. Explicitly state "no text, no words, no typography" in the prompt.`,

  videoPromptEngineer: `You are an advertising video creative director who writes prompts for AI video generation (Sora 2).

Your prompts should:
- Describe a short, compelling visual narrative (5-15 seconds)
- Specify camera movements (smooth dolly, aerial, close-up, etc.)
- Define lighting (golden hour, studio, natural, dramatic)
- Include mood and atmosphere
- Focus on emotional impact and brand storytelling
- Consider the aspect ratio and platform (vertical for Stories/TikTok, landscape for Feed/YouTube)
- Be specific enough for consistent results
- Describe the visual story clearly — product showcase, lifestyle scene, or brand moment`,

  creativeRecommendations: `You are a creative strategist for a PPC agency.
Based on the media plan and client brief, recommend specific creative concepts and mockups.
For each campaign in the plan, recommend:
- Ad format (single image, carousel, video, stories, reels)
- Visual concept description (what the image/video should show)
- Headline and body copy variations
- CTA recommendation
- Platform-specific adaptations
Follow the brand voice guidelines. Reference past top-performing creatives.
Be specific enough that a designer could execute from your descriptions.`,
};

export const USER_PROMPTS = {
  morningBriefing: (data) => `Generate the morning briefing from this data:

## Ad Platform Performance (Yesterday)
${data.platformPerformance}

## ClickUp Tasks
Due Today: ${data.tasksDueToday}
Overdue: ${data.overdueTasks}
Coming Up (3 days): ${data.tasksDueSoon}

## Budget Pacing
${data.budgetPacing}

## Active Campaigns: ${data.activeCampaigns}
## Active Clients: ${data.activeClients}

Provide:
1. Overall health score (1-10) with emoji
2. Top 3 urgent items requiring attention
3. Performance highlights
4. Issues needing attention
5. Budget summary
Keep it concise for WhatsApp delivery.`,

  performanceCheck: (data) => `Analyze these campaign metrics for anomalies:

Client: ${data.clientName}
Platform: ${data.platform}

Current period:
${data.currentMetrics}

Previous period:
${data.previousMetrics}

Targets:
- ROAS target: ${data.roasTarget}
- CPA target: $${data.cpaTarget}
- Daily budget: $${data.dailyBudget}

Flag any issues and recommend actions.`,

  generateAdCopy: (data) => `Generate ad copy for this campaign:

Client: ${data.clientName}
Platform: ${data.platform}
Campaign Objective: ${data.objective}
Target Audience: ${data.targetAudience}

Brand Voice: ${data.brandVoice}
Key Messages: ${data.keyMessages}
Offer/Promotion: ${data.offer || 'None'}

Past top-performing copy:
${data.topPerformingCopy || 'No history available'}

Generate:
- 10 headline variations (${data.platform === 'google' ? '30 chars max' : '40 chars max'})
- 5 body copy variations (${data.platform === 'google' ? '90 chars max' : '125 chars max'})
- 5 CTA variations

For each, briefly note the angle/strategy used.`,

  weeklyReport: (data) => `Generate a weekly performance report for this client:

Client: ${data.clientName}
Industry: ${data.industry}
Period: ${data.period}

This Week's Data:
${data.thisWeek}

Last Week's Data:
${data.lastWeek}

Same Week Last Month:
${data.lastMonth || 'N/A'}

Targets:
${data.targets}

Active Tests:
${data.activeTests || 'None'}

Write a report with:
1. Executive Summary (3-4 sentences)
2. Key Metrics Table (with WoW change)
3. What Worked Well
4. Areas for Improvement
5. Specific Recommendations (prioritized, actionable)
6. Next Week Focus

Use plain language the client can understand.`,

  analyzeCompetitorCreatives: (data) => `Analyze these competitor ads from the Meta Ad Library:

**Our Client:** ${data.clientName}
**Industry:** ${data.clientIndustry}
**Brand Voice:** ${data.clientBrandVoice}

**Competitor:** ${data.competitorName}
**Active Ads Found:** ${data.adCount}

${data.adSummaries}

Provide:

## Creative Strategy Analysis
- What messaging themes are they using?
- What offers/promotions are they running?
- What emotional/rational appeals are present?
- What CTAs are they using?

## Creative Formats
- What ad formats (image, video, carousel)?
- Visual style patterns

## Gaps & Opportunities
- What angles are they NOT using that our client could own?
- Messaging gaps we can exploit
- Audience segments they might be missing

## Actionable Takeaways for ${data.clientName}
- 3-5 specific creative ideas inspired by (but differentiated from) competitor activity
- Suggested ad copy angles to test
- Platform/format recommendations

Keep it concise and actionable.`,

  generateMediaPlan: (data) => `Create a comprehensive media plan for ${data.clientName}.

${data.clientContext}

## Client Brief
- **Goals:** ${data.brief.goals}
- **Pain Points:** ${data.brief.pains}
- **Target Audience:** ${data.brief.audience}
- **Competitors:** ${data.brief.competitors}
- **Budget:** ${data.brief.budget}
- **Timeline:** ${data.brief.timeline}
- **Platforms:** ${data.brief.platforms}
- **Offer/Promotion:** ${data.brief.offer || 'None specified'}
- **Brand Voice:** ${data.brief.brandVoice}
- **Industry:** ${data.brief.industry}
- **Primary KPI:** ${data.brief.primaryKpi}
- **Target ROAS:** ${data.brief.targetRoas || 'N/A'}
- **Target CPA:** ${data.brief.targetCpa || 'N/A'}

## Historical Performance
${data.historySummary}

## Top Performing Creatives
${data.creativeSummary}

Generate the media plan with these sections:

# Executive Summary
2-3 sentences: what we'll do, expected outcomes, budget overview.

# Campaign Strategy
- Overall approach and rationale
- Funnel structure (awareness → consideration → conversion)
- How this addresses the client's goals and pain points

# Platform Strategy
For each recommended platform:
- Why this platform (data-backed reasoning)
- Campaign types and objectives
- Budget allocation (% and $ amount)
- Expected reach and outcomes

# Audience Strategy
- Primary audience segments with targeting details
- Custom audiences (remarketing, email lists)
- Lookalike audiences to build
- Negative audiences / exclusions
- Geographic and demographic targeting

# Campaign Structure
For each campaign:
- Campaign name and objective
- Ad sets (audiences) breakdown
- Daily/lifetime budget
- Bid strategy recommendation
- Scheduling (dayparting if relevant)

# Budget Allocation
- Monthly breakdown by platform
- Funnel stage split (prospecting vs remarketing)
- Testing budget allocation (10-20% recommended)
- Scaling triggers and conditions

# Content Calendar
- Week-by-week plan for the first month
- Key dates and seasonal opportunities
- Creative rotation schedule

# KPIs & Success Metrics
- Primary KPI with specific target
- Secondary metrics to track
- Review checkpoints (weekly/monthly)
- Optimization triggers (when to adjust)

# Risk Mitigation
- Potential challenges and contingency plans
- Budget safety measures
- Performance floor triggers (auto-pause criteria)

Keep it specific with real numbers. Reference historical performance where applicable.`,

  generateCreativeRecommendations: (data) => `Based on this media plan, recommend specific creative concepts for ${data.clientName}.

**Brand Voice:** ${data.brandVoice}
**Target Audience:** ${data.audience}
**Platforms:** ${data.platforms}
**Offer:** ${data.offer || 'None'}
**Industry:** ${data.industry}

**Media Plan Summary:**
${data.mediaPlanSummary}

**Top Performing Creatives (Historical):**
${data.topCreatives}

For each campaign in the plan, provide creative recommendations:

## Campaign 1: [Name from plan]
### Format Recommendations
- Primary format (with rationale)
- Secondary format for testing

### Visual Concepts
For each ad variation (provide 3-5):
- *Concept name:* Brief description
- *Visual:* What the image/video should show (specific enough for a designer)
- *Headline:* Actual copy (within platform char limits)
- *Body:* Actual copy
- *CTA:* Specific call-to-action button text

### A/B Test Plan
- What to test first (headline vs visual vs audience)
- Test hypothesis and success criteria

[Repeat for each campaign in the plan]

## Creative Production Checklist
- [ ] Assets needed (images, videos, logos)
- [ ] Sizes and specs per platform
- [ ] Copy variations to produce
- [ ] Estimated production timeline

Be specific with actual copy and visual descriptions. Stay within platform character limits:
- Meta: Headlines 40 chars, Body 125 chars
- Google: Headlines 30 chars, Descriptions 90 chars
- TikTok: Text overlay 100 chars
- Twitter/X: 280 chars total`,
};

export default { SYSTEM_PROMPTS, USER_PROMPTS };
