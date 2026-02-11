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
- "create_campaign": Start new campaign. Params: clientName, objective
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
};

export default { SYSTEM_PROMPTS, USER_PROMPTS };
