/**
 * Unit tests for the knowledge base service.
 * Uses a temporary SQLite database for isolation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Configure test environment BEFORE importing modules that depend on config
process.env.NODE_ENV = 'test';

const dbPath = path.join(os.tmpdir(), `kb-test-${Date.now()}.db`);
process.env.KB_DB_PATH = dbPath;
process.env.COST_DB_PATH = path.join(os.tmpdir(), `kb-test-costs-${Date.now()}.db`);

const {
  createClient,
  getClient,
  getAllClients,
  updateClient,
  searchClients,
  buildClientContext,
  recordCampaignPerformance,
  saveCreative,
} = await import('../../src/services/knowledge-base.js');

describe('Knowledge Base', () => {
  let testClientId;

  // ------------------------------------------------------------------
  // createClient & getClient
  // ------------------------------------------------------------------
  describe('createClient and getClient', () => {
    it('creates a client and retrieves it by ID', () => {
      const data = {
        name: 'Test Corp',
        industry: 'ecommerce',
        website: 'https://testcorp.com',
        description: 'A test ecommerce company',
        targetAudience: 'Adults 25-45',
        brandVoice: 'Professional yet friendly',
        monthlyBudgetCents: 500000,
        targetRoas: 4.0,
        targetCpaCents: 2500,
        primaryKpi: 'ROAS',
        competitors: ['CompetitorA', 'CompetitorB'],
        goals: { q1: 'Scale Meta campaigns', q2: 'Launch Google Shopping' },
        metaAdAccountId: 'act_12345',
        googleAdsCustomerId: '123-456-7890',
      };

      const created = createClient(data);
      assert.ok(created.id, 'Created client should have an ID');
      testClientId = created.id;

      const fetched = getClient(created.id);
      assert.ok(fetched, 'Should find client by ID');
      assert.equal(fetched.name, 'Test Corp');
      assert.equal(fetched.industry, 'ecommerce');
      assert.equal(fetched.monthly_budget_cents, 500000);
      assert.equal(fetched.target_roas, 4.0);
      assert.deepEqual(fetched.competitors, ['CompetitorA', 'CompetitorB']);
      assert.deepEqual(fetched.goals, { q1: 'Scale Meta campaigns', q2: 'Launch Google Shopping' });
    });

    it('retrieves a client by name (case-insensitive)', () => {
      const fetched = getClient('test corp');
      assert.ok(fetched, 'Should find client by name');
      assert.equal(fetched.name, 'Test Corp');
    });

    it('returns undefined for a non-existent client', () => {
      const fetched = getClient('non-existent-id');
      assert.equal(fetched, undefined);
    });
  });

  // ------------------------------------------------------------------
  // getAllClients
  // ------------------------------------------------------------------
  describe('getAllClients', () => {
    before(() => {
      createClient({ name: 'Alpha Inc', industry: 'saas', status: 'active' });
      createClient({ name: 'Beta Ltd', industry: 'fintech', status: 'active' });
      createClient({ name: 'Gamma Co', industry: 'retail', status: 'paused' });
    });

    it('returns all active clients by default', () => {
      const clients = getAllClients();
      assert.ok(clients.length >= 3, 'Should have at least 3 active clients');
      const names = clients.map(c => c.name);
      assert.ok(names.includes('Alpha Inc'));
      assert.ok(names.includes('Beta Ltd'));
      assert.ok(names.includes('Test Corp'));
    });

    it('filters by status when specified', () => {
      const paused = getAllClients('paused');
      assert.ok(paused.length >= 1, 'Should have at least 1 paused client');
      const names = paused.map(c => c.name);
      assert.ok(names.includes('Gamma Co'));
    });

    it('returns clients sorted by name', () => {
      const clients = getAllClients();
      const names = clients.map(c => c.name);
      const sorted = [...names].sort();
      assert.deepEqual(names, sorted);
    });
  });

  // ------------------------------------------------------------------
  // updateClient
  // ------------------------------------------------------------------
  describe('updateClient', () => {
    it('updates client fields', () => {
      updateClient(testClientId, { industry: 'retail', targetRoas: 5.5 });
      const fetched = getClient(testClientId);
      assert.equal(fetched.industry, 'retail');
      assert.equal(fetched.target_roas, 5.5);
    });

    it('updates the updated_at timestamp', () => {
      const before = getClient(testClientId).updated_at;
      // Tiny delay to ensure timestamp difference
      updateClient(testClientId, { brandVoice: 'Bold and energetic' });
      const after = getClient(testClientId).updated_at;
      assert.ok(after >= before, 'updated_at should be greater than or equal to before');
    });
  });

  // ------------------------------------------------------------------
  // searchClients
  // ------------------------------------------------------------------
  describe('searchClients', () => {
    it('finds clients by name substring', () => {
      const results = searchClients('Alpha');
      assert.ok(results.length >= 1);
      assert.ok(results.some(r => r.name === 'Alpha Inc'));
    });

    it('finds clients by industry', () => {
      const results = searchClients('fintech');
      assert.ok(results.length >= 1);
      assert.ok(results.some(r => r.name === 'Beta Ltd'));
    });

    it('is case-insensitive', () => {
      const results = searchClients('alpha');
      assert.ok(results.length >= 1);
      assert.ok(results.some(r => r.name === 'Alpha Inc'));
    });

    it('returns empty array for no matches', () => {
      const results = searchClients('zzz_nonexistent_zzz');
      assert.equal(results.length, 0);
    });
  });

  // ------------------------------------------------------------------
  // buildClientContext
  // ------------------------------------------------------------------
  describe('buildClientContext', () => {
    it('returns "Client not found." for an invalid ID', () => {
      const context = buildClientContext('invalid-id');
      assert.equal(context, 'Client not found.');
    });

    it('builds a context string with client profile info', () => {
      const context = buildClientContext(testClientId);
      assert.ok(context.includes('Test Corp'));
      assert.ok(context.includes('retail'));       // updated industry
      assert.ok(context.includes('Client Profile'));
      assert.ok(context.includes('Monthly Budget'));
      assert.ok(context.includes('Target ROAS'));
      assert.ok(context.includes('CompetitorA'));
    });

    it('includes campaign history when present', () => {
      // Add a campaign record
      recordCampaignPerformance({
        clientId: testClientId,
        platform: 'meta',
        campaignId: 'camp_001',
        campaignName: 'Summer Sale 2024',
        spendCents: 150000,
        roas: 3.5,
        cpaCents: 1200,
        conversions: 42,
      });

      const context = buildClientContext(testClientId);
      assert.ok(context.includes('Campaign History'));
      assert.ok(context.includes('Summer Sale 2024'));
    });

    it('includes top creatives when present', () => {
      saveCreative({
        clientId: testClientId,
        platform: 'meta',
        creativeType: 'image',
        headline: 'Shop the Sale Now',
        ctr: 0.045,
        conversions: 15,
        status: 'active',
      });

      const context = buildClientContext(testClientId);
      assert.ok(context.includes('Top Performing Creatives'));
      assert.ok(context.includes('Shop the Sale Now'));
    });
  });

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------
  after(() => {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
  });
});
