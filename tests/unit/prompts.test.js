/**
 * Unit tests for prompt templates.
 * Validates that system prompts exist and user prompt generators produce correct output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set test environment before importing anything that touches config
process.env.NODE_ENV = 'test';

const { SYSTEM_PROMPTS, USER_PROMPTS } = await import('../../src/prompts/templates.js');

describe('Prompt Templates', () => {
  // ------------------------------------------------------------------
  // SYSTEM_PROMPTS
  // ------------------------------------------------------------------
  describe('SYSTEM_PROMPTS', () => {
    it('has all expected prompt keys defined', () => {
      const expectedKeys = [
        'morningBriefing',
        'performanceAnalysis',
        'strategicPlanning',
        'creativeBrief',
        'adCopyWriter',
        'competitorAnalysis',
        'clientReport',
        'commandParser',
        'anomalyDetection',
        'testRecommendation',
        'competitorCreativeAnalysis',
        'mediaPlanGenerator',
        'creativeRecommendations',
      ];
      for (const key of expectedKeys) {
        assert.ok(key in SYSTEM_PROMPTS, `Missing system prompt key: ${key}`);
      }
    });

    it('all SYSTEM_PROMPTS are non-empty strings', () => {
      for (const [key, value] of Object.entries(SYSTEM_PROMPTS)) {
        assert.equal(typeof value, 'string', `SYSTEM_PROMPTS.${key} should be a string`);
        assert.ok(value.trim().length > 0, `SYSTEM_PROMPTS.${key} should not be empty`);
      }
    });

    it('morningBriefing prompt mentions PPC agency context', () => {
      assert.ok(SYSTEM_PROMPTS.morningBriefing.includes('PPC'));
      assert.ok(SYSTEM_PROMPTS.morningBriefing.includes('morning briefing'));
    });

    it('commandParser prompt lists expected intents', () => {
      const prompt = SYSTEM_PROMPTS.commandParser;
      const expectedIntents = ['stats', 'pause', 'resume', 'report', 'briefing', 'budget', 'help', 'competitor_ads', 'media_plan'];
      for (const intent of expectedIntents) {
        assert.ok(prompt.includes(`"${intent}"`), `commandParser should list intent "${intent}"`);
      }
    });
  });

  // ------------------------------------------------------------------
  // USER_PROMPTS.morningBriefing
  // ------------------------------------------------------------------
  describe('USER_PROMPTS.morningBriefing', () => {
    it('is a function', () => {
      assert.equal(typeof USER_PROMPTS.morningBriefing, 'function');
    });

    it('generates output containing provided data fields', () => {
      const data = {
        platformPerformance: 'Meta: $5,000 spend, 3.2 ROAS | Google: $3,000 spend, 2.8 ROAS',
        tasksDueToday: '5 tasks',
        overdueTasks: '2 tasks',
        tasksDueSoon: '8 tasks',
        budgetPacing: 'Client A: 85% paced, Client B: 110% overspend',
        activeCampaigns: 42,
        activeClients: 15,
      };

      const output = USER_PROMPTS.morningBriefing(data);

      assert.equal(typeof output, 'string');
      assert.ok(output.length > 0, 'Output should not be empty');

      // Verify data is interpolated into the prompt
      assert.ok(output.includes('Meta: $5,000 spend'), 'Should include platform performance data');
      assert.ok(output.includes('5 tasks'), 'Should include tasks due today');
      assert.ok(output.includes('2 tasks'), 'Should include overdue tasks');
      assert.ok(output.includes('8 tasks'), 'Should include upcoming tasks');
      assert.ok(output.includes('85% paced'), 'Should include budget pacing');
      assert.ok(output.includes('42'), 'Should include active campaigns count');
      assert.ok(output.includes('15'), 'Should include active clients count');
    });

    it('includes structural instructions for the AI', () => {
      const data = {
        platformPerformance: '',
        tasksDueToday: '0',
        overdueTasks: '0',
        tasksDueSoon: '0',
        budgetPacing: '',
        activeCampaigns: 0,
        activeClients: 0,
      };

      const output = USER_PROMPTS.morningBriefing(data);

      // The prompt should guide the AI on what to produce
      assert.ok(output.includes('health score'), 'Should ask for health score');
      assert.ok(output.includes('urgent'), 'Should ask for urgent items');
      assert.ok(output.includes('WhatsApp'), 'Should mention WhatsApp delivery format');
    });
  });

  // ------------------------------------------------------------------
  // USER_PROMPTS.generateAdCopy
  // ------------------------------------------------------------------
  describe('USER_PROMPTS.generateAdCopy', () => {
    it('is a function', () => {
      assert.equal(typeof USER_PROMPTS.generateAdCopy, 'function');
    });

    it('generates output with all provided fields', () => {
      const data = {
        clientName: 'Acme Widgets',
        platform: 'meta',
        objective: 'conversions',
        targetAudience: 'Small business owners aged 30-50',
        brandVoice: 'Professional yet approachable',
        keyMessages: 'Save time, boost productivity',
        offer: '20% off first month',
        topPerformingCopy: '"Boost your workflow today" - 4.2% CTR',
      };

      const output = USER_PROMPTS.generateAdCopy(data);

      assert.equal(typeof output, 'string');
      assert.ok(output.includes('Acme Widgets'), 'Should include client name');
      assert.ok(output.includes('meta'), 'Should include platform');
      assert.ok(output.includes('conversions'), 'Should include objective');
      assert.ok(output.includes('Small business owners'), 'Should include target audience');
      assert.ok(output.includes('Professional yet approachable'), 'Should include brand voice');
      assert.ok(output.includes('Save time'), 'Should include key messages');
      assert.ok(output.includes('20% off first month'), 'Should include offer');
      assert.ok(output.includes('Boost your workflow today'), 'Should include top performing copy');
    });

    it('uses platform-specific character limits for Meta', () => {
      const data = {
        clientName: 'Test',
        platform: 'meta',
        objective: 'awareness',
        targetAudience: 'Everyone',
        brandVoice: 'Fun',
        keyMessages: 'Test',
        offer: null,
        topPerformingCopy: null,
      };

      const output = USER_PROMPTS.generateAdCopy(data);
      assert.ok(output.includes('40 chars max'), 'Meta headlines should be 40 chars max');
      assert.ok(output.includes('125 chars max'), 'Meta body copy should be 125 chars max');
    });

    it('uses platform-specific character limits for Google', () => {
      const data = {
        clientName: 'Test',
        platform: 'google',
        objective: 'search',
        targetAudience: 'Everyone',
        brandVoice: 'Professional',
        keyMessages: 'Test',
        offer: null,
        topPerformingCopy: null,
      };

      const output = USER_PROMPTS.generateAdCopy(data);
      assert.ok(output.includes('30 chars max'), 'Google headlines should be 30 chars max');
      assert.ok(output.includes('90 chars max'), 'Google body copy should be 90 chars max');
    });

    it('requests headline, body, and CTA variations', () => {
      const data = {
        clientName: 'Test',
        platform: 'meta',
        objective: 'conversions',
        targetAudience: 'Test',
        brandVoice: 'Test',
        keyMessages: 'Test',
      };

      const output = USER_PROMPTS.generateAdCopy(data);
      assert.ok(output.includes('headline variations'), 'Should request headline variations');
      assert.ok(output.includes('body copy variations'), 'Should request body copy variations');
      assert.ok(output.includes('CTA variations'), 'Should request CTA variations');
    });
  });

  // ------------------------------------------------------------------
  // USER_PROMPTS.analyzeCompetitorCreatives
  // ------------------------------------------------------------------
  describe('USER_PROMPTS.analyzeCompetitorCreatives', () => {
    it('is a function', () => {
      assert.equal(typeof USER_PROMPTS.analyzeCompetitorCreatives, 'function');
    });

    it('generates output with all provided fields', () => {
      const data = {
        clientName: 'Acme Corp',
        clientIndustry: 'ecommerce',
        clientBrandVoice: 'Bold and energetic',
        competitorName: 'Nike',
        adSummaries: 'Ad 1:\n  Headline: Just Do It\n  Body: Shop now',
        adCount: 1,
      };

      const output = USER_PROMPTS.analyzeCompetitorCreatives(data);
      assert.ok(output.includes('Acme Corp'));
      assert.ok(output.includes('Nike'));
      assert.ok(output.includes('ecommerce'));
      assert.ok(output.includes('Bold and energetic'));
      assert.ok(output.includes('Just Do It'));
      assert.ok(output.includes('Gaps & Opportunities'));
      assert.ok(output.includes('Actionable Takeaways'));
    });
  });

  // ------------------------------------------------------------------
  // USER_PROMPTS.generateMediaPlan
  // ------------------------------------------------------------------
  describe('USER_PROMPTS.generateMediaPlan', () => {
    it('is a function', () => {
      assert.equal(typeof USER_PROMPTS.generateMediaPlan, 'function');
    });

    it('generates a comprehensive prompt with all brief fields', () => {
      const data = {
        clientName: 'Acme Corp',
        clientContext: 'Client Profile: Acme Corp, ecommerce',
        brief: {
          goals: 'Increase online sales by 30%',
          pains: 'High CPA on Google',
          audience: 'Women 25-45',
          competitors: 'Nike, Adidas',
          budget: '$10,000/month',
          timeline: 'Q1 2025',
          platforms: 'Meta, Google Ads',
          offer: 'Free shipping over $50',
          brandVoice: 'Fun and energetic',
          industry: 'ecommerce',
          primaryKpi: 'ROAS',
          targetRoas: 4.0,
          targetCpa: '$25.00',
        },
        historySummary: 'Summer Sale: ROAS 3.5, CPA $22',
        creativeSummary: '"Shop Now" - CTR 4.2%',
      };

      const output = USER_PROMPTS.generateMediaPlan(data);
      assert.ok(output.includes('Acme Corp'));
      assert.ok(output.includes('Increase online sales'));
      assert.ok(output.includes('High CPA on Google'));
      assert.ok(output.includes('Women 25-45'));
      assert.ok(output.includes('$10,000/month'));
      assert.ok(output.includes('Executive Summary'));
      assert.ok(output.includes('Campaign Strategy'));
      assert.ok(output.includes('Budget Allocation'));
      assert.ok(output.includes('Content Calendar'));
      assert.ok(output.includes('KPIs & Success Metrics'));
    });
  });

  // ------------------------------------------------------------------
  // USER_PROMPTS.generateCreativeRecommendations
  // ------------------------------------------------------------------
  describe('USER_PROMPTS.generateCreativeRecommendations', () => {
    it('is a function', () => {
      assert.equal(typeof USER_PROMPTS.generateCreativeRecommendations, 'function');
    });

    it('includes platform character limits', () => {
      const data = {
        clientName: 'Test',
        brandVoice: 'Professional',
        audience: 'Everyone',
        platforms: 'Meta, Google',
        offer: null,
        mediaPlanSummary: 'Run Meta and Google campaigns',
        topCreatives: 'No data',
        industry: 'saas',
      };

      const output = USER_PROMPTS.generateCreativeRecommendations(data);
      assert.ok(output.includes('Meta: Headlines 40 chars'));
      assert.ok(output.includes('Google: Headlines 30 chars'));
      assert.ok(output.includes('A/B Test Plan'));
      assert.ok(output.includes('Creative Production Checklist'));
    });
  });
});
