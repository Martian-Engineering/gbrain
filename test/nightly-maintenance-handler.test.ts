import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  makeNightlyMaintenanceHandler,
  nightlyContradictionQueries,
  type NightlyMaintenanceDependencies,
} from '../src/core/minions/handlers/nightly-maintenance.ts';
import { wholeCentReservation } from '../src/core/minions/nightly-maintenance.ts';
import type { BacklinksResult } from '../src/commands/backlinks.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { SemanticRepairManifest } from '../src/core/minions/semantic-repair-manifest.ts';
import type { NightlyRepairAgentResult } from '../src/core/minions/handlers/nightly-repair-agent.ts';

let engine: PGLiteEngine;

const cleanAudit: BacklinksResult = {
  action: 'check',
  mode: 'graph',
  gaps_found: 0,
  fixed: 0,
  pages_affected: 0,
  dryRun: false,
  reference_validation: {
    pages_scanned: 1,
    references_scanned: 0,
    resolved: 0,
    missing: 0,
    ambiguous: 0,
    blocked: 0,
    findings: [],
  },
  graph_findings: [],
};

const manifest = {
  schema_version: '1',
  manifest_id: 'semantic-repair:default:notes/example:finding:page',
  issued_at: '2026-07-28T10:00:00.000Z',
  source_id: 'default',
  page_slug: 'notes/example',
  page_hash: 'a'.repeat(64),
  finding_hash: 'b'.repeat(64),
  finding: {
    kind: 'link_reference',
    source_id: 'default',
    page_slug: 'notes/example',
    status: 'missing',
    target: 'people/alice',
    evidence: { diagnostic: 'missing' },
  },
  resolver: { path: 'skills/RESOLVER.md', sha256: 'c'.repeat(64) },
  schema: { identity: 'default@1.0.0+12345678', sha256: 'd'.repeat(64) },
  disposition: 'repair',
  allowed_actions: [{
    kind: 'replace_reference',
    source_id: 'default',
    page_slug: 'notes/example',
  }],
  required_verification: [
    'source_scope',
    'page_hash_changed',
    'reference_validation',
    'schema_validation',
  ],
  manifest_hash: 'e'.repeat(64),
} as SemanticRepairManifest;

const receipt = {
  source_id: 'default',
  slug: 'notes/example',
  before_hash: 'a'.repeat(64),
  after_hash: 'f'.repeat(64),
  manifest_hash: 'e'.repeat(64),
  validation_status: 'passed',
  disposition: 'repair',
  outcome: {
    status: 'applied',
    decision: 'replace_reference',
    source_id: 'default',
    page_slug: 'notes/example',
    manifest_hash: 'e'.repeat(64),
    broken_reference: 'people/alice',
    occurrence_context: 'The old reference points to [[people/alice]].',
    candidates: [{
      slug: 'people/alicia',
      title: 'Alicia',
      evidence: ['The candidate is the same person.'],
      confidence: 0.98,
    }],
    proposed_replacement: 'people/alicia',
    exact_edit_description: 'Replace only the broken link target.',
    rationale: 'This is the unique canonical identity.',
    confidence: 0.98,
    unresolved_questions: [],
    operations: ['get_page', 'search', 'put_page', 'validate_links'],
    verification: { page_reread: true, links_validated: true },
  },
  agent: { turns_count: 2, stop_reason: 'end_turn', cost_cents: 2.5 },
  verification_reason: null,
} as NightlyRepairAgentResult;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function job(progressUpdates: Record<string, unknown>[]): MinionJobContext {
  return {
    id: 501,
    name: 'nightly-maintenance',
    data: {
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['default'],
      budget_limit_cents: 1500,
      max_page_mutations: 10,
      model: 'openai:gpt-5.6-terra',
      reasoning_effort: 'high',
    },
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 2 * 60 * 60_000,
    shutdownSignal: new AbortController().signal,
    async updateProgress(value) {
      progressUpdates.push(value as Record<string, unknown>);
    },
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

function dependencies(
  overrides: Partial<NightlyMaintenanceDependencies> = {},
): NightlyMaintenanceDependencies {
  return {
    async loadProgress(_jobId, input) {
      return {
        schema_version: '1',
        run_id: input.run_id,
        status: 'running',
        checkpoints: {},
      };
    },
    async snapshotSource() {
      return {
        source_id: 'default',
        last_commit: null,
        last_sync_at: null,
        local_path: null,
        audit: cleanAudit,
      };
    },
    async auditSource() { return cleanAudit; },
    async runDreamMaintenance() {
      return {
        schema_version: '1',
        timestamp: new Date().toISOString(),
        duration_ms: 1,
        status: 'clean',
        brain_dir: null,
        phases: [],
        totals: {},
      } as never;
    },
    async runGlobalMaintenance() {
      return {
        schema_version: '1',
        timestamp: new Date().toISOString(),
        duration_ms: 1,
        status: 'clean',
        brain_dir: null,
        phases: [],
        totals: {},
      } as never;
    },
    async runDeterministicRepair(_engine, input) {
      return {
        source_id: 'default',
        run_id: input.run_id,
        dry_run: false,
        resumed: false,
        completed_stages: ['gazetteer', 'mentions', 'ner', 'timeline', 'backlinks'],
        stages: { backlinks: cleanAudit },
      };
    },
    async buildManifests() { return []; },
    async runRepairChild() { throw new Error('unexpected repair child'); },
    async loadProbeQueries() { return []; },
    async runProbe() { throw new Error('unexpected contradiction probe'); },
    now: () => '2026-07-28T10:01:00.000Z',
    ...overrides,
  };
}

describe('nightly maintenance root handler', () => {
  test('floors fractional ledger headroom before whole-cent reservations', () => {
    expect(wholeCentReservation(1488.89)).toBe(1488);
    expect(wholeCentReservation(0.99)).toBe(0);
    expect(wholeCentReservation(-0.01)).toBe(0);
  });

  test('checkpoints every phase and completes a clean zero-cost run', async () => {
    const updates: Record<string, unknown>[] = [];
    const result = await makeNightlyMaintenanceHandler(
      engine,
      dependencies(),
    )(job(updates));

    expect(result).toMatchObject({
      run_id: 'nightly-maintenance:2026-07-28',
      status: 'completed',
      model: 'openai:gpt-5.6-terra',
      reasoning_effort: 'high',
      mutation_receipts: [],
    });
    expect(Object.keys((result as any).checkpoints)).toEqual([
      'snapshot',
      'dream',
      'deterministic_repair',
      'semantic_repair',
      'verification',
      'contradiction_probe',
      'report',
    ]);
    expect(updates.length).toBeGreaterThanOrEqual(7);
  });

  test('runs manifest children serially and reports verified page hashes', async () => {
    const updates: Record<string, unknown>[] = [];
    let activeChildren = 0;
    let maxActiveChildren = 0;
    const result = await makeNightlyMaintenanceHandler(engine, dependencies({
      async buildManifests() { return [manifest]; },
      async runRepairChild(_input, _manifest, reservationCents) {
        expect(reservationCents).toBe(1500);
        activeChildren++;
        maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
        activeChildren--;
        return receipt;
      },
    }))(job(updates));

    expect(maxActiveChildren).toBe(1);
    expect((result as any).mutation_receipts).toEqual([receipt]);
    expect((result as any).mutation_receipts[0].outcome).toEqual(receipt.outcome);
  });

  test('does not spend agent budget on non-executable proposal manifests', async () => {
    let childCalls = 0;
    const proposalManifest = {
      ...manifest,
      manifest_id: `${manifest.manifest_id}:proposal`,
      manifest_hash: '8'.repeat(64),
      disposition: 'proposal',
      allowed_actions: [{
        kind: 'create_proposal',
        source_id: manifest.source_id,
        page_slug: manifest.page_slug,
      }],
    } as SemanticRepairManifest;

    const result = await makeNightlyMaintenanceHandler(engine, dependencies({
      async buildManifests() { return [proposalManifest, manifest]; },
      async runRepairChild() {
        childCalls++;
        return receipt;
      },
    }))(job([]));

    expect(childCalls).toBe(1);
    expect((result as any).mutation_receipts).toEqual([receipt]);
  });

  test('does not charge a deferred outcome against the mutation ceiling', async () => {
    let childCalls = 0;
    const deferredReceipt = {
      ...receipt,
      after_hash: receipt.before_hash,
      outcome: {
        ...receipt.outcome,
        status: 'deferred',
        decision: 'recover_source',
        candidates: [],
        proposed_replacement: null,
        exact_edit_description: 'Recover the missing source without changing the page.',
        operations: ['get_page', 'search'],
        verification: { page_reread: true, links_validated: false },
      },
    } as NightlyRepairAgentResult;
    const secondManifest = {
      ...manifest,
      manifest_id: `${manifest.manifest_id}:second`,
      manifest_hash: '9'.repeat(64),
    };
    const constrainedJob = job([]);
    constrainedJob.data.max_page_mutations = 1;

    const result = await makeNightlyMaintenanceHandler(engine, dependencies({
      async buildManifests() { return [manifest, secondManifest]; },
      async runRepairChild() {
        childCalls++;
        return childCalls === 1 ? deferredReceipt : receipt;
      },
    }))(constrainedJob);

    expect(childCalls).toBe(2);
    expect((result as any).mutation_receipts).toHaveLength(2);
  });

  test('does not repeat a child whose receipt was durably persisted', async () => {
    let childCalls = 0;
    const result = await makeNightlyMaintenanceHandler(engine, dependencies({
      async loadProgress(_jobId, input) {
        return {
          schema_version: '1',
          run_id: input.run_id,
          status: 'running',
          checkpoints: {},
          semantic_receipts: [receipt],
        };
      },
      async buildManifests() { return [manifest]; },
      async runRepairChild() {
        childCalls++;
        return receipt;
      },
    }))(job([]));

    expect(childCalls).toBe(0);
    expect((result as any).mutation_receipts).toEqual([receipt]);
  });

  test('stops semantic work after a child reports the provider hard cap', async () => {
    let childCalls = 0;
    const budgetReceipt = {
      ...receipt,
      after_hash: receipt.before_hash,
      validation_status: 'failed_rolled_back',
      verification_reason: 'budget_exhausted',
      agent: { ...receipt.agent, cost_cents: 0, stop_reason: 'error' },
    } as NightlyRepairAgentResult;
    const secondManifest = {
      ...manifest,
      manifest_id: `${manifest.manifest_id}:second`,
      manifest_hash: '9'.repeat(64),
    };
    const result = await makeNightlyMaintenanceHandler(engine, dependencies({
      async buildManifests() { return [manifest, secondManifest]; },
      async runRepairChild() {
        childCalls++;
        return budgetReceipt;
      },
    }))(job([]));

    expect(childCalls).toBe(1);
    expect(result).toMatchObject({ status: 'budget_exhausted' });
  });

  test('re-audits after a resumed deterministic repair omits completed stages', async () => {
    const staleAudit: BacklinksResult = {
      ...cleanAudit,
      reference_validation: {
        pages_scanned: 1,
        references_scanned: 1,
        resolved: 0,
        missing: 1,
        ambiguous: 0,
        blocked: 0,
        findings: [{
          source_slug: 'notes/example',
          target: 'people/alice',
          status: 'missing',
          source_id: 'default',
        }],
      },
    };
    let manifestAudit: BacklinksResult | undefined;
    await makeNightlyMaintenanceHandler(engine, dependencies({
      async snapshotSource() {
        return {
          source_id: 'default',
          last_commit: null,
          last_sync_at: null,
          local_path: null,
          audit: staleAudit,
        };
      },
      async runDeterministicRepair(_engine, input) {
        return {
          source_id: 'default',
          run_id: input.run_id,
          dry_run: false,
          resumed: true,
          completed_stages: ['gazetteer', 'mentions', 'ner', 'timeline', 'backlinks'],
          stages: {},
        };
      },
      async auditSource() { return cleanAudit; },
      async buildManifests(_engine, _input, audits) {
        manifestAudit = audits.get('default');
        return [];
      },
    }))(job([]));

    expect(manifestAudit).toBe(cleanAudit);
  });
});

describe('nightly contradiction queries', () => {
  test('deduplicates, sorts, and excludes resolved references', () => {
    const audit: BacklinksResult = {
      ...cleanAudit,
      reference_validation: {
        pages_scanned: 1,
        references_scanned: 3,
        resolved: 1,
        missing: 1,
        ambiguous: 1,
        blocked: 0,
        findings: [
          { source_slug: 'a', target: 'zeta', status: 'missing', source_id: 'default' },
          { source_slug: 'a', target: 'alpha', status: 'ambiguous', source_id: 'default' },
          { source_slug: 'a', target: 'ignored', status: 'resolved', source_id: 'default' },
        ],
      },
    };
    expect(nightlyContradictionQueries([audit, audit])).toEqual(['alpha', 'zeta']);
  });
});
