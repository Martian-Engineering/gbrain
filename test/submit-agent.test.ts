import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';
import { digestProposalValue } from '../src/core/ingestion-proposal-contract.ts';
import { buildProposalApplicationDigestInventory } from '../src/core/minions/agent-job-proposal-relations.ts';

/**
 * v0.38 Slice 3 — `submit_agent` MCP op tests.
 *
 * Covers the load-bearing trust-boundary surface:
 *   - Per-dispatch binding enforcement against oauth_clients.bound_*
 *   - allowed_tools ⊆ bound_tools subset check
 *   - allowed_slug_prefixes prefix-match against bound_slug_prefixes
 *   - bound_max_concurrent concurrency cap
 *   - Local CLI bypass (ctx.remote === false → invalid_request)
 *   - Refusal when client has scope but missing bindings
 *   - Refusal for unknown client_id
 *   - dry_run path
 *   - Happy-path submission writes audit row + queue row
 *
 * Audit-trail writes go to a tmpdir via GBRAIN_AUDIT_DIR (withEnv-wrapped).
 */

const submit_agent = operationsByName['submit_agent'];
const get_agent_job = operationsByName['get_agent_job'];
const stage_ingestion_proposal_page = operationsByName['stage_ingestion_proposal_page'];
const finalize_ingestion_proposal = operationsByName['finalize_ingestion_proposal'];
const apply_ingestion_proposal_page = operationsByName['apply_ingestion_proposal_page'];
const get_agent_job_proposal = operationsByName['get_agent_job_proposal'];
const get_agent_job_execution_evidence =
  operationsByName['get_agent_job_execution_evidence'];
if (!submit_agent) {
  throw new Error('submit_agent op missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates `config` table; restore the version row so
  // MinionQueue.ensureSchema() sees the migrated state. The schema itself
  // is preserved (initSchema applied in beforeAll); only the config-table
  // marker row needs re-seeding.
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-agent-audit-'));
});

interface SeedOpts {
  bound_tools?: string[] | null;
  bound_source_id?: string | null;
  bound_brain_id?: string | null;
  bound_slug_prefixes?: string[] | null;
  bound_max_concurrent?: number;
  budget_usd_per_day?: number | null;
  scope?: string;
}

async function seedClient(clientId: string, opts: SeedOpts = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
        bound_max_concurrent, budget_usd_per_day, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $3, $4, $5, $6, $7, $8, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       bound_source_id = EXCLUDED.bound_source_id,
       bound_slug_prefixes = EXCLUDED.bound_slug_prefixes,
       bound_max_concurrent = EXCLUDED.bound_max_concurrent,
       budget_usd_per_day = EXCLUDED.budget_usd_per_day,
       scope = EXCLUDED.scope`,
    [
      clientId,
      opts.scope ?? 'read agent',
      opts.bound_tools ?? null,
      opts.bound_source_id ?? null,
      opts.bound_brain_id ?? null,
      opts.bound_slug_prefixes ?? null,
      opts.bound_max_concurrent ?? 1,
      opts.budget_usd_per_day ?? null,
    ],
  );
}

function makeCtx(
  opts: {
    clientId?: string;
    remote?: boolean;
    dryRun?: boolean;
    scopes?: string[];
  } = {},
): any {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: opts.dryRun ?? false,
    remote: opts.remote ?? true,
    auth: opts.clientId
      ? { clientId: opts.clientId, scopes: opts.scopes ?? [] }
      : undefined,
  };
}

async function callSubmitAgent(ctx: any, params: Record<string, unknown>): Promise<any> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
    return await submit_agent.handler(ctx, params);
  });
}

describe('submit_agent op (v0.38 Slice 3 — remote-callable agent dispatch with binding enforcement)', () => {
  describe('op surface', () => {
    it('declares scope=agent + mutating=true', () => {
      expect(submit_agent.scope).toBe('agent' as any);
      expect(submit_agent.mutating).toBe(true);
    });
    it('declares required prompt param', () => {
      expect(submit_agent.params.prompt).toBeDefined();
      expect((submit_agent.params.prompt as any).required).toBe(true);
    });
    it('declares an explicit reasoning_effort param', () => {
      expect(submit_agent.params.reasoning_effort).toBeDefined();
    });
    it('publishes the bounded per-job output budget', () => {
      expect(submit_agent.params.max_output_tokens).toMatchObject({
        type: 'number',
        description: expect.stringContaining('1-32768'),
      });
    });
    it('publishes non-corpus-mutating staged proposal operations', () => {
      expect(submit_agent.params.proposal_artifact_id).toBeDefined();
      expect(submit_agent.params.proposal_capture_page_slug).toBeDefined();
      expect(submit_agent.params.proposal_admission_scope).toBeDefined();
      expect(submit_agent.params.approved_proposal_job_id).toBeDefined();
      expect(submit_agent.params.approved_proposal_digest).toBeDefined();
      expect(stage_ingestion_proposal_page?.scope).toBe('agent');
      expect(stage_ingestion_proposal_page?.mutating).toBe(false);
      expect(stage_ingestion_proposal_page?.params.total_pages.description)
        .toContain('(1-32)');
      expect(stage_ingestion_proposal_page?.params.page_inventory).toMatchObject({
        type: 'array',
        required: true,
        items: { type: 'object' },
      });
      expect(stage_ingestion_proposal_page?.params.page_inventory.description)
        .toContain('validates effects against live pages in the bound source');
      expect(finalize_ingestion_proposal?.scope).toBe('agent');
      expect(finalize_ingestion_proposal?.mutating).toBe(false);
      expect(finalize_ingestion_proposal?.params.total_pages.description)
        .toContain('(1-32)');
      expect(finalize_ingestion_proposal?.params.page_digests).toBeUndefined();
      expect(get_agent_job_proposal?.scope).toBe('agent');
      expect(apply_ingestion_proposal_page).toMatchObject({
        scope: 'agent',
        mutating: true,
      });
      expect(Object.keys(apply_ingestion_proposal_page!.params).sort()).toEqual([
        'page_digest',
        'proposal_digest',
        'proposal_job_id',
        'sequence',
        'source_id',
      ]);
    });
  });

  describe('local CLI bypass (ctx.remote === false)', () => {
    it('throws invalid_request — local CLI must use gbrain agent run', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /local CLI.*gbrain agent run/i,
      );
    });
  });

  describe('OAuth client requirement', () => {
    it('refuses when no clientId in ctx.auth', async () => {
      const ctx = makeCtx(); // no clientId
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /requires an OAuth client with the `agent` scope/i,
      );
    });

    it('refuses when client_id is unknown', async () => {
      const ctx = makeCtx({ clientId: 'nobody-here' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /client_id nobody-here not found/,
      );
    });
  });

  describe('binding requirement (D13 — opt-in only)', () => {
    it('refuses when client has agent scope but bound_tools is NULL', async () => {
      // Legacy admin client gets agent scope appended via re-registration but
      // forgot to set --bound-tools. Refuse with the paste-ready hint.
      await seedClient('legacy-admin', { bound_tools: null });
      const ctx = makeCtx({ clientId: 'legacy-admin' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /has the agent scope but no bindings.*re-register/i,
      );
    });
  });

  describe('allowed_tools subset enforcement', () => {
    it('passes when allowed_tools ⊆ bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_tools: ['search', 'get_page'],
      });
      expect(result.dry_run).toBe(true);
      expect(result.action).toBe('submit_agent');
    });

    it('refuses when allowed_tools requests a tool outside bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'go', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/tool "put_page" is not in client cursor's bound_tools/);
    });

    it('defaults to bound_tools when allowed_tools omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'go' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('allowed_slug_prefixes enforcement', () => {
    it('passes when each requested prefix is under a bound prefix', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/', 'people/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      // 'wiki/' starts with 'wiki/' (exact prefix match)
      const r1 = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_slug_prefixes: ['wiki/'],
      });
      expect(r1.dry_run).toBe(true);
    });

    it('refuses when a requested prefix has no bound parent', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, {
          prompt: 'go',
          allowed_slug_prefixes: ['private/'],
        }),
      ).rejects.toThrow(/slug_prefix "private\/" is not under any.*bound_slug_prefixes/);
    });

    it('does not widen an exact slug binding into a recursive namespace', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['people'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      await expect(
        callSubmitAgent(ctx, {
          prompt: 'go',
          allowed_slug_prefixes: ['people/'],
        }),
      ).rejects.toThrow(/slug_prefix "people\/" is not under any.*bound_slug_prefixes/);
    });

    it('allows a recursive binding to narrow to a child namespace', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['people/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_slug_prefixes: ['people/team/'],
      });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('concurrency cap enforcement', () => {
    it('refuses when inflight count >= bound_max_concurrent', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 2,
      });
      // Seed 2 already-running subagent jobs for this client.
      for (let i = 0; i < 2; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `existing-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'one too many' })).rejects.toThrow(
        /at concurrency cap \(2\/2\)/,
      );
    });

    it('allows submit when inflight count < cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'one', __owner_client_id: 'cursor' })],
      );
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'two' });
      expect(result.dry_run).toBe(true);
      expect(result.bound_max_concurrent).toBe(3);
    });

    it('does NOT count terminal-state jobs toward the cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // 5 completed jobs — none counted (status filter is waiting/active/waiting-children).
      for (let i = 0; i < 5; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `done-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'fresh' });
      expect(result.dry_run).toBe(true);
    });

    it('isolates inflight count by client_id (no cross-client leakage)', async () => {
      await seedClient('alice', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      await seedClient('bob', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // Alice has 1 active — at her cap.
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'alice-busy', __owner_client_id: 'alice' })],
      );
      // Bob's submit should succeed — his cap (1) is independent.
      const ctxBob = makeCtx({ clientId: 'bob', dryRun: true });
      const result = await callSubmitAgent(ctxBob, { prompt: 'bob-fresh' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('happy-path submission', () => {
    it('requires ingestion artifact and capture bindings while allowing first-stage scope selection', async () => {
      await seedClient('cursor', {
        bound_tools: ['stage_ingestion_proposal_page', 'finalize_ingestion_proposal'],
        bound_source_id: 'company',
        bound_slug_prefixes: ['sources/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'propose',
        proposal_artifact_id: 'artifact-1',
      })).rejects.toThrow(/capture page slug/i);
      await expect(callSubmitAgent(ctx, {
        prompt: 'propose',
        proposal_admission_scope: 'Include delivery notes.',
      })).rejects.toThrow(/artifact and capture/i);

      const result = await callSubmitAgent(ctx, {
        prompt: 'propose',
        proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
      });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1',
        [result.id],
      );
      expect(row.data.proposal_artifact_id).toBe('artifact-1');
      expect(row.data.proposal_capture_page_slug).toBe('sources/example');
      expect(row.data.proposal_admission_scope).toBeUndefined();
      expect(row.data.source_id).toBe('company');
    });

    it('rejects proposal-tool jobs without a bound source, slug fence, or capture inside the fence', async () => {
      await seedClient('unscoped', {
        bound_tools: ['stage_ingestion_proposal_page', 'finalize_ingestion_proposal'],
        bound_source_id: null,
        bound_slug_prefixes: ['sources/'],
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'unscoped' }), {
        prompt: 'propose', proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
      })).rejects.toThrow(/bound source/i);

      await seedClient('unfenced', {
        bound_tools: ['stage_ingestion_proposal_page', 'finalize_ingestion_proposal'],
        bound_source_id: 'company',
        bound_slug_prefixes: [],
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'unfenced' }), {
        prompt: 'propose', proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
      })).rejects.toThrow(/slug fence/i);

      await seedClient('wrong-capture', {
        bound_tools: ['stage_ingestion_proposal_page', 'finalize_ingestion_proposal'],
        bound_source_id: 'company',
        bound_slug_prefixes: ['projects/'],
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'wrong-capture' }), {
        prompt: 'propose', proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
      })).rejects.toThrow(/capture page.*slug fence/i);
    });

    it('accepts a 4,000-character proposal scope and rejects 4,001 characters', async () => {
      await seedClient('scope-limit', {
        bound_tools: ['stage_ingestion_proposal_page', 'finalize_ingestion_proposal'],
        bound_source_id: 'company',
        bound_slug_prefixes: ['sources/'],
      });
      const ctx = makeCtx({ clientId: 'scope-limit' });
      const maximumScope = 's'.repeat(4_000);
      await expect(callSubmitAgent(ctx, {
        prompt: 'propose', proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: `${maximumScope}s`,
      })).rejects.toThrow(/admission scope exceeds/i);

      const result = await callSubmitAgent(ctx, {
        prompt: 'propose', proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: maximumScope,
      });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1', [result.id],
      );
      expect(row!.data.proposal_admission_scope).toBe(maximumScope);
    });

    it('deduplicates a client idempotency key before enforcing concurrency', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      const ctx = makeCtx({ clientId: 'cursor' });

      const first = await callSubmitAgent(ctx, {
        prompt: 'correct the selected claim',
        idempotency_key: 'lore-job-01',
      });
      const repeated = await callSubmitAgent(ctx, {
        prompt: 'x'.repeat(500_000),
        idempotency_key: 'lore-job-01',
      });

      expect(repeated.id).toBe(first.id);
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM minion_jobs
          WHERE idempotency_key = 'submit-agent:cursor:lore-job-01'`,
      );
      expect(rows[0]?.n).toBe(1);
    });

    it('persists and audits the requested model and reasoning effort', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'correct the selected claim',
        model: 'openai:gpt-5.6-luna',
        reasoning_effort: 'high',
      });
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.model).toBe('openai:gpt-5.6-luna');
      expect(data.reasoning_effort).toBe('high');

      const auditFile = fs.readdirSync(tmpAuditDir).find(f => f.startsWith('agent-jobs-'));
      const auditLine = JSON.parse(fs.readFileSync(path.join(tmpAuditDir, auditFile!), 'utf8').trim());
      expect(auditLine.model).toBe('openai:gpt-5.6-luna');
      expect(auditLine.reasoning_effort).toBe('high');
    });

    it('rejects an unsupported reasoning effort', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'go',
        reasoning_effort: 'extreme',
      })).rejects.toThrow(/reasoning_effort.*none.*xhigh/i);
    });

    it('rejects an adapter effort unsupported by the selected model', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'go',
        model: 'openai:gpt-5.6-terra',
        reasoning_effort: 'minimal',
      })).rejects.toThrow(/does not support reasoning_effort "minimal"/i);
    });

    it('rejects reasoning effort for a non-OpenAI model', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'go',
        model: 'anthropic:claude-sonnet-4-6',
        reasoning_effort: 'high',
      })).rejects.toThrow(/does not support reasoning_effort/i);
    });

    it('rejects reasoning effort when the model is omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'go',
        reasoning_effort: 'high',
      })).rejects.toThrow(/reasoning_effort requires an explicit compatible model/i);
    });

    it('rejects reasoning effort for an OpenAI model without reasoning support', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, {
        prompt: 'go',
        model: 'openai:gpt-4o-mini',
        reasoning_effort: 'high',
      })).rejects.toThrow(/does not support reasoning_effort/i);
    });

    it.each([0, -1, 1.5, 32_769, Number.NaN, Number.POSITIVE_INFINITY, null, '32768'])(
      'rejects invalid max_output_tokens=%p before enqueue',
      async (maxOutputTokens) => {
        await seedClient('cursor', {
          bound_tools: ['search'],
          bound_source_id: 'default',
          bound_slug_prefixes: ['wiki/'],
        });
        const ctx = makeCtx({ clientId: 'cursor' });

        await expect(callSubmitAgent(ctx, {
          prompt: 'go',
          max_output_tokens: maxOutputTokens,
        })).rejects.toMatchObject({
          code: 'invalid_params',
          message: expect.stringMatching(/max_output_tokens.*integer.*1.*32768/i),
        });
        const rows = await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM minion_jobs
            WHERE data->>'__owner_client_id' = 'cursor'`,
        );
        expect(rows[0]?.n).toBe(0);
        expect(fs.readdirSync(tmpAuditDir)).toEqual([]);
      },
    );

    it('uses the configured output budget when max_output_tokens is omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      await engine.setConfig('agent.max_output_tokens', '5000');
      const ctx = makeCtx({ clientId: 'cursor' });

      const result = await callSubmitAgent(ctx, { prompt: 'go' });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1',
        [result.id],
      );
      expect(row?.data.max_tokens).toBe(5_000);
    });

    it('uses the explicit max_output_tokens for prompt admission and durable execution', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      await engine.setConfig('agent.max_output_tokens', '8192');
      const ctx = makeCtx({ clientId: 'cursor' });

      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        model: 'openai:gpt-5.6-terra',
        max_output_tokens: 32_768,
      });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1',
        [result.id],
      );
      expect(row?.data.max_tokens).toBe(32_768);
    });

    it('inserts a subagent job + writes audit row', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
        budget_usd_per_day: 5.00,
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'research the YC W26 batch',
        allowed_tools: ['search'],
      });
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('subagent');
      expect(result.client_id).toBe('cursor');

      // Job persisted with correct shape.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT name, status, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('subagent');
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.prompt).toBe('research the YC W26 batch');
      expect(data.allowed_tools).toEqual(['search']);
      expect(data.__owner_client_id).toBe('cursor');
      expect(data.source_id).toBe('default'); // auto-set from bound_source_id
      expect(data.use_gateway_loop).toBe(true);

      // Audit file written.
      const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
      expect(auditFiles.length).toBe(1);
      const auditContent = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
      const auditLine = JSON.parse(auditContent.trim().split('\n')[0]);
      expect(auditLine.client_id).toBe('cursor');
      expect(auditLine.job_id).toBe(result.id);
      expect(auditLine.bound_tools).toEqual(['search']);
      expect(auditLine.bound_source).toBe('default');
      expect(auditLine.budget_remaining_cents).toBe(500); // 5.00 USD → 500 cents
      expect(auditLine.outcome).toBe('submitted');
      // CRITICAL: prompt text MUST NOT be in audit (only byte count).
      expect(auditContent).not.toContain('YC W26 batch');
    });

    it('caps max_turns at 100', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'long',
        max_turns: 9999, // way over cap
      });
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.max_turns).toBe(100);
    });

    it('loads a named server skill into immutable job instructions', async () => {
      await seedClient('lore', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['people/', 'projects/', 'wiki/'],
      });
      await engine.setConfig('mcp.publish_skills', 'true');
      const ctx = makeCtx({ clientId: 'lore', scopes: ['read', 'agent'] });
      ctx.config = { mcp: { skills_dir: path.resolve(import.meta.dir, '../skills') } };
      const result = await callSubmitAgent(ctx, {
        prompt: 'correct the selected claim',
        skill_name: 'knowledge-correction',
      });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1',
        [result.id],
      );
      expect(row.data.skill_name).toBe('knowledge-correction');
      expect(row.data.skill_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row.data.system).toContain('Knowledge Correction');
    });

    it('accepts a production-sized 128 KiB prompt with the published GitHub skill on Terra', async () => {
      const tools = [
        'get_active_schema_pack', 'search', 'query', 'get_page', 'list_pages',
        'resolve_slugs', 'get_links', 'get_backlinks',
        'stage_ingestion_proposal_page', 'finalize_ingestion_proposal',
        'put_page', 'add_link', 'add_timeline_entry', 'validate_links',
      ];
      await seedClient('lore', {
        bound_tools: tools,
        bound_source_id: 'company',
        bound_slug_prefixes: ['sources/', 'projects/', 'people/', 'companies/'],
        bound_max_concurrent: 3,
      });
      await engine.setConfig('mcp.publish_skills', 'true');
      await engine.setConfig('agent.max_output_tokens', '8192');
      const ctx = makeCtx({ clientId: 'lore', scopes: ['read', 'agent'] });
      ctx.config = { mcp: { skills_dir: path.resolve(import.meta.dir, '../skills') } };

      const result = await callSubmitAgent(ctx, {
        prompt: 'p'.repeat(128 * 1024),
        skill_name: 'github-project-ingestion',
        model: 'openai:gpt-5.6-terra',
        max_output_tokens: 32_768,
        allowed_tools: tools,
        proposal_artifact_id: 'artifact-128k',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: 'Include source-grounded delivery knowledge.',
      });

      expect(result.id).toBeNumber();
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>(
        'SELECT data FROM minion_jobs WHERE id = $1',
        [result.id],
      );
      expect(row?.data.max_tokens).toBe(32_768);
    });

    it('rejects an over-budget fresh prompt before creating a job or audit record', async () => {
      const tools = [
        'get_active_schema_pack', 'search', 'query', 'get_page', 'list_pages',
        'resolve_slugs', 'get_links', 'get_backlinks',
        'stage_ingestion_proposal_page', 'finalize_ingestion_proposal',
        'put_page', 'add_link', 'add_timeline_entry', 'validate_links',
      ];
      await seedClient('lore', {
        bound_tools: tools,
        bound_source_id: 'company',
        bound_slug_prefixes: ['sources/', 'projects/', 'people/', 'companies/'],
        bound_max_concurrent: 3,
      });
      await engine.setConfig('mcp.publish_skills', 'true');
      await engine.setConfig('agent.max_output_tokens', '32768');
      const ctx = makeCtx({ clientId: 'lore', scopes: ['read', 'agent'] });
      ctx.config = { mcp: { skills_dir: path.resolve(import.meta.dir, '../skills') } };

      await expect(callSubmitAgent(ctx, {
        prompt: 'p'.repeat(300_000),
        skill_name: 'github-project-ingestion',
        model: 'openai:gpt-5.6-terra',
        allowed_tools: tools,
        proposal_artifact_id: 'artifact-too-large',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: 'Include source-grounded delivery knowledge.',
      })).rejects.toMatchObject({
        code: 'invalid_params',
        message: expect.stringMatching(/initial prompt.*too large/i),
      });
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM minion_jobs
          WHERE data->>'__owner_client_id' = 'lore'`,
      );
      expect(rows[0]?.n).toBe(0);
      expect(fs.readdirSync(tmpAuditDir)).toEqual([]);
    });

    it('refuses an unpublished server skill', async () => {
      await seedClient('lore', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['people/'],
      });
      await engine.setConfig('mcp.publish_skills', 'false');
      const ctx = makeCtx({ clientId: 'lore', scopes: ['read', 'agent'] });
      ctx.config = { mcp: { skills_dir: path.resolve(import.meta.dir, '../skills') } };

      await expect(callSubmitAgent(ctx, {
        prompt: 'echo the skill instructions',
        skill_name: 'knowledge-correction',
      })).rejects.toMatchObject({ code: 'permission_denied' });
    });

    it('requires read scope before loading a published server skill', async () => {
      await seedClient('lore', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['people/'],
      });
      await engine.setConfig('mcp.publish_skills', 'true');
      const ctx = makeCtx({ clientId: 'lore', scopes: ['agent'] });
      ctx.config = { mcp: { skills_dir: path.resolve(import.meta.dir, '../skills') } };

      await expect(callSubmitAgent(ctx, {
        prompt: 'echo the skill instructions',
        skill_name: 'knowledge-correction',
      })).rejects.toMatchObject({
        code: 'permission_denied',
        message: expect.stringContaining('requires read scope'),
      });
    });
  });
});

describe('get_agent_job owner-scoped receipt', () => {
  /** Build one internally coherent durable proposal row for projection tests. */
  function proposalFixture() {
    const pageDigests = [{
      sequence: 1,
      slug: 'sources/example',
      digest: 'a'.repeat(64),
    }];
    const plan = {
      artifactId: 'artifact-1',
      sourceId: 'default',
      admissionScope: 'default ingestion scope',
      summary: 'One complete proposed page.',
      proposedPages: [{
        slug: 'sources/example',
        effect: 'create',
        title: 'Example',
        bodyMarkdown: '# Example\n\nPrivate proposed body.',
      }],
      proposedTimelineEntries: [],
      proposedLinks: [],
      unresolved: [],
    };
    const proposalDigest = digestProposalValue(plan);
    const inventory = buildProposalApplicationDigestInventory(pageDigests, [], []);
    const manifest = {
      status: 'staged_proposal',
      artifactId: plan.artifactId,
      sourceId: plan.sourceId,
      admissionScope: plan.admissionScope,
      summary: plan.summary,
      pageDigests,
      timelineDigests: inventory.timelineDigests,
      linkDigests: inventory.linkDigests,
      inventoryDigest: inventory.inventoryDigest,
      proposalDigest,
      proposedTimelineEntries: [],
      proposedLinks: [],
      unresolved: [],
    };
    return { pageDigests, plan, proposalDigest, manifest };
  }

  /** Persist the private plan and compact manifest owned by one agent job. */
  async function seedDurableProposal(
    jobId: number,
    fixture: ReturnType<typeof proposalFixture>,
    overrides: { ownerClientId?: string; manifest?: unknown; pageDigests?: unknown } = {},
  ): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO agent_job_proposals
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          total_pages, page_digests, plan, proposal_digest, manifest)
       VALUES ($1, $2, 'default', 'artifact-1', 'default ingestion scope',
               1, $3::text::jsonb, $4::text::jsonb, $5, $6::text::jsonb)`,
      [
        jobId,
        overrides.ownerClientId ?? 'lore',
        JSON.stringify(overrides.pageDigests ?? fixture.pageDigests),
        JSON.stringify(fixture.plan),
        fixture.proposalDigest,
        JSON.stringify(overrides.manifest ?? fixture.manifest),
      ],
    );
  }

  /** Seed a proposal-bound job and its durable compact proposal row. */
  async function seedProposalJob(
    fixture: ReturnType<typeof proposalFixture>,
    options: {
      status?: string;
      rawResult?: string;
      proposalOwner?: string;
      manifest?: unknown;
      pageDigests?: unknown;
    } = {},
  ): Promise<number> {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, result, queue, priority, created_at)
       VALUES ('subagent', $1, $2::text::jsonb, $3::text::jsonb, 'default', 0, now())
       RETURNING id`,
      [
        options.status ?? 'completed',
        JSON.stringify({
          __owner_client_id: 'lore',
          source_id: 'default',
          proposal_artifact_id: 'artifact-1',
          proposal_admission_scope: 'default ingestion scope',
        }),
        JSON.stringify(options.rawResult === undefined ? null : { result: options.rawResult }),
      ],
    );
    await seedDurableProposal(row.id, fixture, {
      ownerClientId: options.proposalOwner,
      manifest: options.manifest,
      pageDigests: options.pageDigests,
    });
    return row.id;
  }

  it('returns the complete durable manifest over a partial model receipt', async () => {
    const fixture = proposalFixture();
    const partialReceipt = {
      status: 'staged_proposal',
      artifactId: fixture.manifest.artifactId,
      sourceId: fixture.manifest.sourceId,
      admissionScope: fixture.manifest.admissionScope,
      summary: fixture.manifest.summary,
      pageDigests: fixture.manifest.pageDigests,
      proposalDigest: fixture.manifest.proposalDigest,
      proposedTimelineEntries: [],
      proposedLinks: [],
      unresolved: [],
    };
    const rawResult = JSON.stringify(partialReceipt);
    const jobId = await seedProposalJob(fixture, { rawResult });

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: jobId },
    ) as any;

    expect(owned.receipt).toEqual(fixture.manifest);
    expect(owned.result_text).toBe(rawResult);
    expect(owned.receipt.proposedPages).toBeUndefined();
    expect(JSON.stringify(owned.receipt)).not.toContain('Private proposed body');
  });

  it('returns structured JSON only to the submitting client', async () => {
    await seedClient('lore', { bound_tools: ['search'] });
    await seedClient('other', { bound_tools: ['search'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, result, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, $2::jsonb, 'default', 0, now())
       RETURNING id`,
      [
        JSON.stringify({ __owner_client_id: 'lore' }),
        JSON.stringify({ result: JSON.stringify({ status: 'ready', effects: [] }) }),
      ],
    );
    const owned = await get_agent_job.handler(makeCtx({ clientId: 'lore' }), { id: row.id });
    expect((owned as any).receipt).toEqual({ status: 'ready', effects: [] });
    expect((owned as any).result_text).toBe(JSON.stringify({ status: 'ready', effects: [] }));
    await expect(
      get_agent_job.handler(makeCtx({ clientId: 'other' }), { id: row.id }),
    ).rejects.toThrow(/not owned/i);
  });

  it('does not surface a durable manifest before the job completes', async () => {
    const fixture = proposalFixture();
    const rawResult = JSON.stringify({ status: 'working' });
    const jobId = await seedProposalJob(fixture, { status: 'active', rawResult });

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: jobId },
    ) as any;

    expect(owned.receipt).toEqual({ status: 'working' });
    expect(owned.receipt).not.toEqual(fixture.manifest);
  });

  it('fails closed when a durable proposal row belongs to another owner', async () => {
    const fixture = proposalFixture();
    const jobId = await seedProposalJob(fixture, { proposalOwner: 'other' });

    await expect(get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: jobId },
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('fails closed when the durable manifest identity is corrupt', async () => {
    const fixture = proposalFixture();
    const jobId = await seedProposalJob(fixture, {
      manifest: { ...fixture.manifest, artifactId: 'different-artifact' },
    });

    await expect(get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: jobId },
    )).rejects.toMatchObject({ code: 'proposal_identity_mismatch' });
  });

  it('fails closed on corrupt nested manifest fields and bounds', async () => {
    const fixture = proposalFixture();
    const pageDigestsWithExtraField = fixture.pageDigests.map(entry => ({
      ...entry,
      privatePlan: 'must not cross the compact receipt boundary',
    }));
    const corruptions = [
      {
        manifest: { ...fixture.manifest, pageDigests: pageDigestsWithExtraField },
        pageDigests: pageDigestsWithExtraField,
      },
      {
        manifest: {
          ...fixture.manifest,
          proposedTimelineEntries: [{
            pageSlug: 'sources/example',
            date: '2026-08-08',
            text: 'Example event',
            ref: 'sources/example',
            arbitrary: 'unexpected',
          }],
        },
      },
      {
        manifest: {
          ...fixture.manifest,
          proposedTimelineEntries: [{
            pageSlug: 'sources/example',
            date: '2026-08-08',
            text: 'Valid nested event with stale digest inventory.',
            ref: 'sources/example',
          }],
        },
      },
      {
        manifest: {
          ...fixture.manifest,
          proposedLinks: [{
            from: 'sources/example',
            to: 'sources/other',
            type: 'related-to',
            arbitrary: 'unexpected',
          }],
        },
      },
      {
        manifest: { ...fixture.manifest, unresolved: ['x'.repeat(501)] },
      },
      {
        manifest: { ...fixture.manifest, sourceId: '../invalid-source' },
      },
    ];

    for (const corruption of corruptions) {
      const jobId = await seedProposalJob(fixture, corruption);
      await expect(get_agent_job.handler(
        makeCtx({ clientId: 'lore' }),
        { id: jobId },
      )).rejects.toMatchObject({ code: 'proposal_identity_mismatch' });
    }
  });

  it('attributes unbound jobs to the runtime default source', async () => {
    await seedClient('lore', { bound_tools: ['put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES ($1, 1, 'put-default', 'brain_put_page', $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({ slug: 'concepts/example', content: '# Example' }),
        JSON.stringify({
          slug: 'concepts/example',
          status: 'created_or_updated',
          content_hash: 'b'.repeat(64),
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.source_id).toBe('default');
    expect(owned.execution_evidence.operations).toEqual([
      expect.objectContaining({ source_id: 'default' }),
    ]);
  });

  it('projects authority-bound deterministic page apply evidence without private text', async () => {
    await seedClient('lore', { bound_tools: ['apply_ingestion_proposal_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'company' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES ($1, 1, 'apply-page-1', 'brain_apply_ingestion_proposal_page',
               $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          sequence: 2,
          page_digest: 'b'.repeat(64),
          source_id: 'company',
          appendMarkdown: 'private reviewed text',
        }),
        JSON.stringify({
          status: 'applied',
          effect: 'update',
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          sequence: 2,
          page_digest: 'b'.repeat(64),
          source_id: 'company',
          slug: 'sources/example',
          previous_content_hash: 'c'.repeat(64),
          content_hash: 'd'.repeat(64),
          rebased: true,
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence).toMatchObject({
      availability: 'complete',
      unsupported_mutation_count: 0,
      operations: [{
        sequence: 0,
        operation: 'apply_ingestion_proposal_page',
        execution_status: 'complete',
        source_id: 'company',
        proposal_job_id: 41,
        proposal_sequence: 2,
        proposal_digest: 'a'.repeat(64),
        page_digest: 'b'.repeat(64),
        effect: 'update',
        slug: 'sources/example',
        previous_content_hash: 'c'.repeat(64),
        applied_content_hash: 'd'.repeat(64),
        rebased: true,
        outcome: 'applied',
      }],
    });
    expect(JSON.stringify(owned.execution_evidence)).not.toContain('private reviewed text');
  });

  it('projects relation and proposal-finalizer evidence without frozen relation content', async () => {
    await seedClient('lore', {
      bound_tools: [
        'apply_ingestion_proposal_relation',
        'finalize_ingestion_proposal_application',
      ],
    });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'company' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES
         ($1, 1, 'relation-1', 'brain_apply_ingestion_proposal_relation',
          $2::jsonb, 'complete', $3::jsonb, 0),
         ($1, 2, 'finalize-1', 'brain_finalize_ingestion_proposal_application',
          $4::jsonb, 'complete', $5::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          relation_kind: 'timeline',
          sequence: 1,
          source_id: 'company',
          text: 'private relation text must not appear',
        }),
        JSON.stringify({
          status: 'applied',
          relation_kind: 'timeline',
          proposal_job_id: 41,
          sequence: 1,
          source_id: 'company',
          proposal_digest: 'a'.repeat(64),
          relation_digest: 'b'.repeat(64),
          target_slug: 'sources/example',
          write_through: { written: true, path: '/private/repo/sources/example.md' },
        }),
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          source_id: 'company',
        }),
        JSON.stringify({
          status: 'applied_proposal',
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          source_id: 'company',
          inventory_digest: 'c'.repeat(64),
          pages: { total: 2, applied: 2, rebased: 1 },
          timeline_entries: { total: 1, applied: 1 },
          links: { total: 3, applied: 3 },
          receipt_digest: 'd'.repeat(64),
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence).toMatchObject({
      availability: 'complete',
      unsupported_mutation_count: 0,
      operations: [
        {
          sequence: 0,
          operation: 'apply_ingestion_proposal_relation',
          execution_status: 'complete',
          source_id: 'company',
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          relation_kind: 'timeline',
          proposal_sequence: 1,
          relation_digest: 'b'.repeat(64),
          target_slug: 'sources/example',
          outcome: 'applied',
          write_through_status: 'written',
        },
        {
          sequence: 1,
          operation: 'finalize_ingestion_proposal_application',
          execution_status: 'complete',
          source_id: 'company',
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          inventory_digest: 'c'.repeat(64),
          receipt_digest: 'd'.repeat(64),
          pages_total: 2,
          pages_applied: 2,
          pages_rebased: 1,
          timeline_total: 1,
          timeline_applied: 1,
          links_total: 3,
          links_applied: 3,
          outcome: 'applied_proposal',
        },
      ],
    });
    expect(owned.execution_evidence.allowed_recovery_actions).toContain(
      'finalize_verified_success',
    );
    const evidence = JSON.stringify(owned.execution_evidence);
    expect(evidence).not.toContain('private relation text');
    expect(evidence).not.toContain('/private/repo');
  });

  it('projects bounded proposal failure codes without raw diagnostics', async () => {
    await seedClient('lore', { bound_tools: ['apply_ingestion_proposal_relation'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'failed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'company' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, ordinal)
       VALUES ($1, 1, 'relation-failed', 'brain_apply_ingestion_proposal_relation',
               $2::jsonb, 'failed', $3::jsonb, $4, 0)`,
      [
        row.id,
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          relation_kind: 'timeline',
          sequence: 1,
          source_id: 'company',
        }),
        JSON.stringify({ failure_code: 'proposal_authority_unavailable' }),
        'private authority lookup diagnostic',
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.operations[0]).toMatchObject({
      operation: 'apply_ingestion_proposal_relation',
      execution_status: 'failed',
      failure_code: 'proposal_authority_unavailable',
      outcome: 'unknown',
    });
    expect(JSON.stringify(owned.execution_evidence)).not.toContain('private authority lookup');
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'finalize_verified_success',
    );
  });

  it('requires a completed finalizer before proposal application is verified', async () => {
    await seedClient('lore', { bound_tools: ['apply_ingestion_proposal_relation'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'company' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES ($1, 1, 'relation-complete', 'brain_apply_ingestion_proposal_relation',
               $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          relation_kind: 'link',
          sequence: 1,
          source_id: 'company',
        }),
        JSON.stringify({
          status: 'applied',
          relation_kind: 'link',
          proposal_job_id: 41,
          sequence: 1,
          source_id: 'company',
          proposal_digest: 'a'.repeat(64),
          relation_digest: 'b'.repeat(64),
          target_slug: 'sources/example',
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.availability).toBe('complete');
    expect(owned.execution_evidence.allowed_recovery_actions).toContain(
      'continue_approved_work',
    );
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'finalize_verified_success',
    );
  });

  it('never offers verified-success closeout after the latest finalizer failed', async () => {
    await seedClient('lore', { bound_tools: ['finalize_ingestion_proposal_application'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'failed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'company' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, ordinal)
       VALUES ($1, 1, 'finalizer-failed', 'brain_finalize_ingestion_proposal_application',
               $2::jsonb, 'failed', $3::jsonb, $4, 0)`,
      [
        row.id,
        JSON.stringify({
          proposal_job_id: 41,
          proposal_digest: 'a'.repeat(64),
          source_id: 'company',
        }),
        JSON.stringify({ failure_code: 'incomplete_application' }),
        'private finalizer diagnostic',
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence).toMatchObject({
      availability: 'complete',
      operations: [{
        operation: 'finalize_ingestion_proposal_application',
        execution_status: 'failed',
        failure_code: 'incomplete_application',
        outcome: 'unknown',
        inventory_digest: null,
        receipt_digest: null,
      }],
    });
    expect(owned.execution_evidence.allowed_recovery_actions).toContain(
      'retry_filing_from_current_state',
    );
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'finalize_verified_success',
    );
    expect(JSON.stringify(owned.execution_evidence)).not.toContain('private finalizer diagnostic');
  });

  it('returns bounded authoritative write evidence without raw content or errors', async () => {
    await seedClient('lore', { bound_tools: ['get_page', 'put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, result, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, $2::jsonb, 'default', 0, now())
       RETURNING id`,
      [
        JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' }),
        JSON.stringify({ result: JSON.stringify({ status: 'succeeded' }) }),
      ],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, ordinal)
       VALUES
         ($1, 1, 'put-1', 'brain_put_page', $2::jsonb, 'complete', $3::jsonb, NULL, 0),
         ($1, 2, 'get-1', 'brain_get_page', $4::jsonb, 'complete', $5::jsonb, NULL, 0),
         ($1, 3, 'timeline-1', 'brain_add_timeline_entry', $6::jsonb, 'complete', $7::jsonb, NULL, 0),
         ($1, 4, 'link-1', 'brain_add_link', $8::jsonb, 'complete', $9::jsonb, NULL, 0),
         ($1, 5, 'put-2', 'brain_put_page', $10::jsonb, 'failed', NULL, 'private database detail', 0),
         ($1, 6, 'unlink-1', 'brain_remove_link', $11::jsonb, 'complete', $12::jsonb, NULL, 0)`,
      [
        row.id,
        JSON.stringify({
          slug: 'concepts/example',
          content: '# private proposed page',
          expected_content_hash: 'a'.repeat(64),
        }),
        JSON.stringify({ slug: 'concepts/example', status: 'created_or_updated' }),
        JSON.stringify({ slug: 'concepts/example' }),
        JSON.stringify({
          slug: 'concepts/example',
          source_id: 'default',
          content_hash: 'b'.repeat(64),
          compiled_truth: '# private landed page',
        }),
        JSON.stringify({
          slug: 'concepts/example',
          date: '2026-08-06',
          summary: 'A bounded event.',
          ref: 'sources/example',
        }),
        JSON.stringify({ status: 'ok', inserted: true }),
        JSON.stringify({
          from: 'concepts/example',
          to: 'sources/example',
          link_type: 'supports',
          context: 'private link context',
        }),
        JSON.stringify({ status: 'ok' }),
        JSON.stringify({
          slug: 'concepts/failed-example',
          content: '# must not escape',
          expected_content_hash: 'c'.repeat(64),
        }),
        JSON.stringify({
          from: 'concepts/example',
          to: 'sources/example',
          link_type: 'supports',
        }),
        JSON.stringify({ status: 'ok' }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence).toEqual({
      schema_version: 1,
      availability: 'complete',
      truncated: false,
      unsupported_mutation_count: 0,
      allowed_recovery_actions: [
        'finalize_verified_success',
        'continue_approved_work',
        'retry_filing_from_current_state',
        'refresh_proposal',
        'close_without_remaining_writes',
      ],
      source_id: 'default',
      operations: [
        {
          sequence: 0,
          operation: 'put_page',
          execution_status: 'complete',
          source_id: 'default',
          slug: 'concepts/example',
          expected_content_hash: 'a'.repeat(64),
          content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_content_hash: 'b'.repeat(64),
          outcome: 'changed',
        },
        {
          sequence: 1,
          operation: 'get_page',
          execution_status: 'complete',
          source_id: 'default',
          slug: 'concepts/example',
          observed_content_hash: 'b'.repeat(64),
        },
        {
          sequence: 2,
          operation: 'add_timeline_entry',
          execution_status: 'complete',
          source_id: 'default',
          slug: 'concepts/example',
          timeline_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          outcome: 'inserted',
        },
        {
          sequence: 3,
          operation: 'add_link',
          execution_status: 'complete',
          source_id: 'default',
          from: 'concepts/example',
          to: 'sources/example',
          link_type: 'supports',
          link_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          outcome: 'applied',
        },
        {
          sequence: 4,
          operation: 'put_page',
          execution_status: 'failed',
          source_id: 'default',
          slug: 'concepts/failed-example',
          expected_content_hash: 'c'.repeat(64),
          content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_content_hash: null,
          outcome: 'unknown',
        },
        {
          sequence: 5,
          operation: 'remove_link',
          execution_status: 'complete',
          source_id: 'default',
          from: 'concepts/example',
          to: 'sources/example',
          link_type: 'supports',
          link_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          outcome: 'applied',
        },
      ],
    });
    expect(
      owned.execution_evidence.operations[3].link_payload_sha256,
    ).not.toBe(
      owned.execution_evidence.operations[5].link_payload_sha256,
    );
    expect(JSON.stringify(owned.execution_evidence)).not.toContain('private');
  });

  it('attributes failed reads to the job-bound source', async () => {
    await seedClient('lore', { bound_tools: ['get_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'private' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, ordinal)
       VALUES ($1, 1, 'get-missing', 'brain_get_page', $2::jsonb, 'failed', NULL,
               'private database detail', 0)`,
      [row.id, JSON.stringify({ slug: 'concepts/missing' })],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.operations).toEqual([
      expect.objectContaining({
        operation: 'get_page',
        execution_status: 'failed',
        source_id: 'private',
        slug: 'concepts/missing',
      }),
    ]);
    expect(JSON.stringify(owned.execution_evidence)).not.toContain(
      'private database detail',
    );
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'retry_filing_from_current_state',
    );
  });

  it('does not attribute a skipped duplicate hash to the requested slug', async () => {
    await seedClient('lore', { bound_tools: ['put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES ($1, 1, 'put-duplicate', 'brain_put_page', $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({
          slug: 'concepts/requested',
          content: '# Requested',
          expected_content_hash: null,
        }),
        JSON.stringify({
          slug: 'concepts/existing-duplicate',
          status: 'skipped',
          content_hash: 'b'.repeat(64),
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.operations).toEqual([expect.objectContaining({
      slug: 'concepts/requested',
      applied_content_hash: null,
      outcome: 'unknown',
    })]);
  });

  it('fingerprints omitted link types according to each mutation contract', async () => {
    await seedClient('lore', { bound_tools: ['add_link', 'remove_link'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES
         ($1, 1, 'link-default', 'brain_add_link', $2::jsonb, 'complete', $3::jsonb, 0),
         ($1, 2, 'unlink-wildcard', 'brain_remove_link', $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({ from: 'concepts/example', to: 'sources/example' }),
        JSON.stringify({ status: 'ok' }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.availability).toBe('complete');
    expect(owned.execution_evidence.operations).toEqual([
      expect.objectContaining({
        operation: 'add_link',
        link_type: '',
        link_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        operation: 'remove_link',
        link_type: null,
        link_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(owned.execution_evidence.operations[0].link_payload_sha256).not.toBe(
      owned.execution_evidence.operations[1].link_payload_sha256,
    );
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'retry_filing_from_current_state',
    );
  });

  it('does not use a same-slug read from another source as write-back proof', async () => {
    await seedClient('lore', { bound_tools: ['put_page', 'get_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES
         ($1, 1, 'put-default', 'brain_put_page', $2::jsonb, 'complete', $3::jsonb, 0),
         ($1, 2, 'get-foreign', 'brain_get_page', $4::jsonb, 'complete', $5::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({ slug: 'concepts/example', content: '# Example' }),
        JSON.stringify({ slug: 'concepts/example', status: 'created_or_updated' }),
        JSON.stringify({ slug: 'concepts/example' }),
        JSON.stringify({
          slug: 'concepts/example',
          source_id: 'other',
          content_hash: 'b'.repeat(64),
        }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.operations).toEqual([
      expect.objectContaining({
        operation: 'put_page',
        source_id: 'default',
        applied_content_hash: null,
      }),
      expect.objectContaining({
        operation: 'get_page',
        source_id: 'other',
        observed_content_hash: 'b'.repeat(64),
      }),
    ]);
    expect(owned.execution_evidence.availability).toBe('incomplete');
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'finalize_verified_success',
    );
  });

  it('keeps evidence incomplete while the parent job can still execute tools', async () => {
    await seedClient('lore', { bound_tools: ['put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES ($1, 1, 'put-active', 'brain_put_page', $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({ slug: 'concepts/example', content: '# Example' }),
        JSON.stringify({ status: 'created_or_updated' }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.availability).toBe('incomplete');
    expect(owned.execution_evidence.allowed_recovery_actions).toEqual([]);
  });

  it('does not authorize current-state retry while a mutation is pending', async () => {
    await seedClient('lore', { bound_tools: ['put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES
         ($1, 1, 'put-failed', 'brain_put_page', $2::jsonb, 'failed', NULL, 0),
         ($1, 2, 'put-pending', 'brain_put_page', $3::jsonb, 'pending', NULL, 0)`,
      [
        row.id,
        JSON.stringify({ slug: 'concepts/failed', content: '# Failed' }),
        JSON.stringify({ slug: 'concepts/pending', content: '# Pending' }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.availability).toBe('incomplete');
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'retry_filing_from_current_state',
    );
  });

  it('does not authorize current-state retry when mutation evidence is truncated', async () => {
    await seedClient('lore', { bound_tools: ['put_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       SELECT $1, item, 'put-' || item, 'brain_put_page',
              jsonb_build_object('slug', 'concepts/' || item, 'content', '# Failed'),
              'failed', NULL, 0
         FROM generate_series(1, 501) AS item`,
      [row.id],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence.truncated).toBe(true);
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'retry_filing_from_current_state',
    );
  });

  it('keeps evidence incomplete when an unsupported mutating tool ran', async () => {
    await seedClient('lore', { bound_tools: ['put_page', 'delete_page'] });
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ __owner_client_id: 'lore', source_id: 'default' })],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, ordinal)
       VALUES
         ($1, 1, 'put-failed', 'brain_put_page', $2::jsonb, 'failed', NULL, 0),
         ($1, 2, 'delete-unsupported', 'brain_delete_page', $3::jsonb, 'complete', $4::jsonb, 0)`,
      [
        row.id,
        JSON.stringify({ slug: 'concepts/failed', content: '# Failed' }),
        JSON.stringify({ slug: 'concepts/private-deletion' }),
        JSON.stringify({ status: 'ok' }),
      ],
    );

    const owned = await get_agent_job.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id },
    ) as any;

    expect(owned.execution_evidence).toMatchObject({
      availability: 'incomplete',
      unsupported_mutation_count: 1,
      allowed_recovery_actions: [
        'refresh_proposal',
        'close_without_remaining_writes',
      ],
    });
    expect(JSON.stringify(owned.execution_evidence)).not.toContain('private-deletion');
    expect(owned.execution_evidence.allowed_recovery_actions).not.toContain(
      'retry_filing_from_current_state',
    );
  });
});

describe('staged proposal operation contract', () => {
  it('stages only inside the bound job, finalizes compactly, and retrieves by exact owner and digest', async () => {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({
        __owner_client_id: 'lore',
        source_id: 'company',
        proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: 'Include delivery notes.',
        allowed_slug_prefixes: ['sources/*'],
      })],
    );
    const agentCtx = { ...makeCtx({ clientId: 'lore' }), viaSubagent: true, jobId: row.id };
    const staged = await stage_ingestion_proposal_page!.handler(agentCtx, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include delivery notes.',
      sequence: 1,
      total_pages: 1,
      page_inventory: [{ slug: 'sources/example', effect: 'create' }],
      page: {
        slug: 'sources/example',
        effect: 'create',
        title: 'Example',
        bodyMarkdown: '# Example',
      },
    }) as any;
    const manifest = await finalize_ingestion_proposal!.handler(agentCtx, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include delivery notes.',
      total_pages: 1,
      summary: 'Ready for review.',
      proposed_timeline_entries: [{
        pageSlug: 'sources/example',
        date: '2026-08-08',
        text: 'The reviewed event occurred.',
        ref: 'sources/example',
      }],
      proposed_links: [{ from: 'sources/example', to: 'sources/example', type: 'related' }],
      unresolved: [],
    }) as any;

    expect(manifest).toEqual({
      status: 'staged_proposal',
      artifactId: 'artifact-1',
      sourceId: 'company',
      admissionScope: 'Include delivery notes.',
      summary: 'Ready for review.',
      pageDigests: [{ sequence: 1, slug: 'sources/example', digest: staged.digest }],
      timelineDigests: [{ sequence: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      linkDigests: [{ sequence: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      inventoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedTimelineEntries: [{
        pageSlug: 'sources/example',
        date: '2026-08-08',
        text: 'The reviewed event occurred.',
        ref: 'sources/example',
      }],
      proposedLinks: [{ from: 'sources/example', to: 'sources/example', type: 'related' }],
      unresolved: [],
    });

    const retrieved = await get_agent_job_proposal!.handler(
      makeCtx({ clientId: 'lore' }),
      { id: row.id, proposal_digest: manifest.proposalDigest },
    ) as any;
    expect(retrieved).toEqual({
      id: row.id,
      proposal_digest: manifest.proposalDigest,
      page_digests: manifest.pageDigests,
      timeline_digests: manifest.timelineDigests,
      link_digests: manifest.linkDigests,
      inventory_digest: manifest.inventoryDigest,
      plan: {
        artifactId: 'artifact-1',
        sourceId: 'company',
        admissionScope: 'Include delivery notes.',
        summary: 'Ready for review.',
        proposedPages: [{
          slug: 'sources/example',
          effect: 'create',
          title: 'Example',
          bodyMarkdown: '# Example',
        }],
        proposedTimelineEntries: manifest.proposedTimelineEntries,
        proposedLinks: manifest.proposedLinks,
        unresolved: [],
      },
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('company', 'Company') ON CONFLICT (id) DO NOTHING`,
    );
    await seedClient('lore', {
      bound_tools: [
        'apply_ingestion_proposal_page',
        'apply_ingestion_proposal_relation',
        'finalize_ingestion_proposal_application',
      ],
      bound_source_id: 'company',
      bound_slug_prefixes: ['sources/'],
      bound_max_concurrent: 3,
    });
    const applyJob = await callSubmitAgent(makeCtx({ clientId: 'lore' }), {
      prompt: 'Apply the exact approved proposal.',
      allowed_tools: [
        'apply_ingestion_proposal_page',
        'apply_ingestion_proposal_relation',
        'finalize_ingestion_proposal_application',
      ],
      allowed_slug_prefixes: ['sources/'],
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
      idempotency_key: 'approved-create-plan',
    });
    const [applyRow] = await engine.executeRaw<{ data: Record<string, unknown> }>(
      `SELECT data FROM minion_jobs WHERE id = $1`,
      [applyJob.id],
    );
    expect(applyRow!.data).toMatchObject({
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
      approved_proposal_page_digests: manifest.pageDigests,
      approved_proposal_timeline_digests: manifest.timelineDigests,
      approved_proposal_link_digests: manifest.linkDigests,
      approved_proposal_inventory_digest: manifest.inventoryDigest,
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
    });
    await expect(callSubmitAgent(makeCtx({ clientId: 'lore' }), {
      prompt: 'Apply a tampered proposal.',
      allowed_tools: ['apply_ingestion_proposal_page'],
      allowed_slug_prefixes: ['sources/'],
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
      approved_proposal_job_id: row.id,
      approved_proposal_digest: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'permission_denied' });
    const createOnlyPreview = await callSubmitAgent(
      makeCtx({ clientId: 'lore', dryRun: true }),
      {
        prompt: 'Apply the exact approved create.',
        allowed_tools: ['apply_ingestion_proposal_page'],
        allowed_slug_prefixes: ['sources/'],
        proposal_artifact_id: 'artifact-1',
        proposal_capture_page_slug: 'sources/example',
        proposal_admission_scope: 'Include delivery notes.',
        approved_proposal_job_id: row.id,
        approved_proposal_digest: manifest.proposalDigest,
      },
    );
    expect(createOnlyPreview).toMatchObject({
      dry_run: true,
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
    });
    await seedClient('lore', {
      bound_tools: ['stage_ingestion_proposal_page', 'apply_ingestion_proposal_page'],
      bound_source_id: 'company',
      bound_slug_prefixes: ['sources/'],
      bound_max_concurrent: 3,
    });
    await expect(callSubmitAgent(makeCtx({ clientId: 'lore', dryRun: true }), {
      prompt: 'Mix propose and apply.',
      allowed_tools: ['stage_ingestion_proposal_page', 'apply_ingestion_proposal_page'],
      allowed_slug_prefixes: ['sources/'],
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
    })).rejects.toThrow(/staging and approved proposal application require separate jobs/i);
    await seedClient('lore', {
      bound_tools: ['apply_ingestion_proposal_page', 'put_page', 'add_link'],
      bound_source_id: 'company',
      bound_slug_prefixes: ['sources/'],
      bound_max_concurrent: 3,
    });
    await expect(callSubmitAgent(makeCtx({ clientId: 'lore', dryRun: true }), {
      prompt: 'Mix bound and generic mutation authority.',
      allowed_tools: ['apply_ingestion_proposal_page', 'put_page'],
      allowed_slug_prefixes: ['sources/'],
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
    })).rejects.toThrow(/only through server-bound proposal operations/i);
    await expect(get_agent_job_proposal!.handler(
      makeCtx({ clientId: 'other' }),
      { id: row.id, proposal_digest: manifest.proposalDigest },
    )).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(stage_ingestion_proposal_page!.handler(makeCtx({ clientId: 'lore' }), {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include delivery notes.',
      sequence: 1, total_pages: 1, page: {},
    })).rejects.toMatchObject({ code: 'permission_denied' });

    await engine.executeRaw('DELETE FROM agent_job_proposals WHERE job_id = $1', [row.id]);
    const replayedApplyJob = await callSubmitAgent(makeCtx({ clientId: 'lore' }), {
      prompt: 'Retry after losing the submit response.',
      allowed_tools: ['apply_ingestion_proposal_page'],
      allowed_slug_prefixes: ['sources/'],
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include delivery notes.',
      approved_proposal_job_id: row.id,
      approved_proposal_digest: manifest.proposalDigest,
      idempotency_key: 'approved-create-plan',
    });
    expect(replayedApplyJob.id).toBe(applyJob.id);
  });
});

describe('get_agent_job_execution_evidence admin fallback', () => {
  it('is an admin-only operation with exact owner and source inputs', () => {
    expect(get_agent_job_execution_evidence).toBeDefined();
    if (!get_agent_job_execution_evidence) return;

    expect(get_agent_job_execution_evidence.scope).toBe('admin');
    expect(get_agent_job_execution_evidence.mutating).not.toBe(true);
    expect(get_agent_job_execution_evidence.params).toMatchObject({
      id: { type: 'number', required: true },
      owner_client_id: { type: 'string', required: true },
      source_id: { type: 'string', required: true },
    });
  });

  it('rejects a remote caller without admin scope', async () => {
    expect(get_agent_job_execution_evidence).toBeDefined();
    if (!get_agent_job_execution_evidence) return;

    await expect(get_agent_job_execution_evidence.handler(
      makeCtx({ clientId: 'reader', scopes: ['read'] }),
      { id: 1, owner_client_id: 'retired-owner', source_id: 'company' },
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('returns only bounded execution evidence after the owner client is retired', async () => {
    expect(get_agent_job_execution_evidence).toBeDefined();
    if (!get_agent_job_execution_evidence) return;

    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, result, error_text, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::jsonb, $2::jsonb, $3, 'default', 0, now())
       RETURNING id`,
      [
        JSON.stringify({
          __owner_client_id: 'retired-owner',
          source_id: 'company',
          prompt: 'private original prompt',
        }),
        JSON.stringify({ result: 'private model receipt' }),
        'private parent error',
      ],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, ordinal)
       VALUES ($1, 1, 'put-retired', 'brain_put_page', $2::jsonb,
               'complete', $3::jsonb, 'private tool error', 0)`,
      [
        row.id,
        JSON.stringify({
          slug: 'projects/example',
          content: '# private page body',
          expected_content_hash: null,
        }),
        JSON.stringify({
          slug: 'projects/example',
          status: 'created_or_updated',
          content_hash: 'b'.repeat(64),
        }),
      ],
    );

    const result = await get_agent_job_execution_evidence.handler(
      makeCtx({ clientId: 'admin', scopes: ['admin'] }),
      {
        id: row.id,
        owner_client_id: 'retired-owner',
        source_id: 'company',
      },
    ) as Record<string, unknown>;

    expect(result).toEqual({
      id: row.id,
      status: 'completed',
      execution_evidence: expect.objectContaining({
        schema_version: 1,
        source_id: 'company',
        operations: [expect.objectContaining({
          operation: 'put_page',
          slug: 'projects/example',
          content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })],
      }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private original prompt');
    expect(serialized).not.toContain('private model receipt');
    expect(serialized).not.toContain('private page body');
    expect(serialized).not.toContain('private tool error');
    expect(serialized).not.toContain('private parent error');
  });

  it('fails closed when the expected owner or source does not match the job', async () => {
    expect(get_agent_job_execution_evidence).toBeDefined();
    if (!get_agent_job_execution_evidence) return;

    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'dead', $1::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({
        __owner_client_id: 'retired-owner',
        source_id: 'company',
      })],
    );
    const ctx = makeCtx({ clientId: 'admin', scopes: ['admin'] });

    for (const params of [{
      id: row.id,
      owner_client_id: 'different-owner',
      source_id: 'company',
    }, {
      id: row.id,
      owner_client_id: 'retired-owner',
      source_id: 'other-company',
    }]) {
      await expect(get_agent_job_execution_evidence.handler(ctx, params))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });
});
