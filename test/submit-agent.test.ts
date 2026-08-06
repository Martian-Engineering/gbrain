import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';

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
        prompt: 'correct the selected claim',
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
    await expect(
      get_agent_job.handler(makeCtx({ clientId: 'other' }), { id: row.id }),
    ).rejects.toThrow(/not owned/i);
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
       VALUES ($1, 1, 'delete-unsupported', 'brain_delete_page', $2::jsonb, 'complete', $3::jsonb, 0)`,
      [
        row.id,
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
  });
});
