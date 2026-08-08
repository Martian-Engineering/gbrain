/**
 * Subagent brain-tool registry tests. Covers:
 *   - every allow-list name exists in OPERATIONS (catches renames upstream)
 *   - Anthropic tool-name constraint enforced
 *   - put_page schema is namespace-wrapped per subagent
 *   - execute() invokes the op handler with viaSubagent=true + subagentId
 *   - filterAllowedTools narrows registry + rejects unknown names
 *   - denied ops (file_upload etc.) do NOT appear in the registry
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import {
  BRAIN_TOOL_ALLOWLIST,
  NON_IDEMPOTENT_BRAIN_TOOLS,
  buildBrainTools,
  filterAllowedTools,
  __testing,
} from '../src/core/minions/tools/brain-allowlist.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000); // OAuth v25 + full migration chain needs breathing room

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
});

describe('BRAIN_TOOL_ALLOWLIST', () => {
  test('every name exists in src/core/operations.ts OPERATIONS', () => {
    const opNames = new Set(operations.map(o => o.name));
    const missing = [...BRAIN_TOOL_ALLOWLIST].filter(n => !opNames.has(n));
    expect(missing).toEqual([]);
  });

  test('contains the reviewed read and namespace-fenced write tools', () => {
    // v0.29 added get_recent_salience + find_anomalies (read-only).
    // get_recent_transcripts is deliberately excluded — subagent calls always
    // have ctx.remote=true, and the v0.29 trust gate rejects remote callers.
    // v114 (#1941) added list_link_sources (read-only provenance discovery);
    // Reviewed graph reads and namespace-fenced writes remain explicit here.
    // #2778 added add_timeline_entry (write, fenced like put_page via
    // operations.ts:enforceSubagentSlugFence).
    // lore-cd8 added replace_page_text (write, fenced like put_page and
    // CAS-guarded by expected_content_hash).
    // Durable ingestion proposals add two non-corpus-mutating staging tools.
    expect(BRAIN_TOOL_ALLOWLIST.size).toBe(31);
    expect(BRAIN_TOOL_ALLOWLIST.has('apply_ingestion_proposal_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('add_timeline_entry')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('query')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('search')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('list_pages')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_links')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('put_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('replace_page_text')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('suppress_claim')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('unsuppress_claim')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_salience')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('find_anomalies')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('list_link_sources')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('add_link')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('remove_link')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('rename_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('add_slug_alias')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('forget_fact')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('supersede_take')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_transcripts')).toBe(false);
  });

  test('does NOT contain destructive ops', () => {
    expect(BRAIN_TOOL_ALLOWLIST.has('file_upload')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_file')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('sync')).toBe(false);
  });
});

describe('buildBrainTools', () => {
  test('produces one ToolDef per allow-listed op that exists in operations.ts', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const opNames = new Set(operations.map(o => o.name));
    const expected = [...BRAIN_TOOL_ALLOWLIST].filter(n => opNames.has(n)).length;
    expect(tools.length).toBe(expected);
  });

  test('tool names are brain_<op> and match Anthropic constraint', () => {
    const tools = buildBrainTools({ subagentId: 7, engine, config });
    for (const t of tools) {
      expect(t.name).toMatch(__testing.ANTHROPIC_NAME_RE);
      expect(t.name.startsWith('brain_')).toBe(true);
    }
  });

  test('marks replay-unsafe correction tools non-idempotent', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    for (const tool of tools) {
      const shortName = tool.name.replace(/^brain_/, '');
      expect(tool.idempotent).toBe(!NON_IDEMPOTENT_BRAIN_TOOLS.has(shortName));
    }
  });

  test('carries mutation semantics separately from crash-replay idempotence', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    for (const tool of tools) {
      const shortName = tool.name.replace(/^brain_/, '');
      const operation = operations.find(candidate => candidate.name === shortName);
      expect(tool.mutating).toBe(operation?.mutating === true);
    }

    const putPage = tools.find(tool => tool.name === 'brain_put_page');
    expect(putPage?.idempotent).toBe(true);
    expect(putPage?.mutating).toBe(true);
  });

  test('tools carry the op description verbatim', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const op = operations.find(o => o.name === 'get_page');
    expect(getPage?.description).toBe(op!.description);
  });

  test('put_page schema is namespace-wrapped per subagent', () => {
    const tools42 = buildBrainTools({ subagentId: 42, engine, config });
    const putPage42 = tools42.find(t => t.name === 'brain_put_page');
    const properties42 = (putPage42!.input_schema as any).properties as any;
    const slug42 = properties42.slug;
    expect(slug42.pattern).toBe('^wiki/agents/42/.+');
    expect(slug42.description).toContain('wiki/agents/42/');
    expect(properties42.expected_content_hash).toMatchObject({ type: ['string', 'null'] });
    expect((putPage42!.input_schema as any).required).toContain('expected_content_hash');

    const tools7 = buildBrainTools({ subagentId: 7, engine, config });
    const putPage7 = tools7.find(t => t.name === 'brain_put_page');
    const slug7 = ((putPage7!.input_schema as any).properties as any).slug;
    expect(slug7.pattern).toBe('^wiki/agents/7/.+');
  });

  test('non-put_page tools do NOT get a pattern on slug', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const slug = ((getPage!.input_schema as any).properties as any).slug;
    expect(slug).toBeDefined();
    expect(slug.pattern).toBeUndefined();
  });

  test('execute() on put_page with valid namespace slug succeeds', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    const res = await putPage!.execute(
      {
        slug: 'wiki/agents/42/notes',
        content: '---\ntitle: Notes\n---\nbody',
        expected_content_hash: null,
      },
      ctx,
    );
    expect(res).toBeTruthy();
  });

  test('execute() on put_page with out-of-namespace slug throws permission_denied', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await expect(
      putPage!.execute(
        { slug: 'wiki/analysis/stomp', content: '---\ntitle: x\n---\nb' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('every correction mutation rejects targets outside the job slug fence', async () => {
    const tools = buildBrainTools({
      subagentId: 42,
      engine,
      config,
      allowedSlugPrefixes: ['people/'],
    });
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['brain_rename_page', { old_slug: 'projects/outside', new_slug: 'people/new', content: 'x' }],
      ['brain_add_slug_alias', { alias_slug: 'projects/outside', canonical_slug: 'people/new' }],
      ['brain_delete_page', { slug: 'projects/outside' }],
      ['brain_add_link', { from: 'projects/outside', to: 'people/new' }],
      ['brain_remove_link', { from: 'projects/outside', to: 'people/new' }],
      ['brain_forget_fact', { id: 1, slug: 'projects/outside' }],
      ['brain_supersede_take', { slug: 'projects/outside', take_id: 1, replacement: 'x' }],
      ['brain_replace_page_text', {
        slug: 'projects/outside',
        old_text: 'x',
        new_text: 'y',
        expected_content_hash: 'a'.repeat(64),
        expected_matches: 1,
      }],
    ];
    for (const [name, input] of cases) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool).toBeDefined();
      await expect(tool!.execute(input, ctx)).rejects.toBeInstanceOf(OperationError);
    }
  });

  // #1586: sourceId threads through buildBrainTools → buildOpContext →
  // put_page → importFromContent, so subagent writes land in the cycle's
  // resolved source instead of the hardcoded 'default'.
  test('execute() on put_page writes to the configured sourceId (#1586)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('mybrain', 'My Brain', '/tmp/mybrain', '{}'::jsonb, false, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    const tools = buildBrainTools({
      subagentId: 42,
      engine,
      config,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
      sourceId: 'mybrain',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await putPage!.execute(
      {
        slug: 'wiki/personal/reflections/2026-07-17-scoped',
        content: '---\ntitle: Scoped\n---\nbody',
        expected_content_hash: null,
      },
      ctx,
    );
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'wiki/personal/reflections/2026-07-17-scoped'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('mybrain');
  });

  test('trusted subagents do not derive graph data from raw source pages', async () => {
    await engine.setConfig('auto_link', 'true');
    await engine.setConfig('auto_timeline', 'true');
    const tools = buildBrainTools({
      subagentId: 42,
      engine,
      config,
      allowedSlugPrefixes: ['people/', 'sources/'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await putPage!.execute(
      {
        slug: 'people/injected',
        content: '---\ntitle: Injected Target\n---\n\nCanonical page.',
        expected_content_hash: null,
      },
      ctx,
    );

    const result = await putPage!.execute(
      {
        slug: 'sources/granola-note',
        content: [
          '---',
          'title: Raw Granola Note',
          '---',
          '',
          '```text',
          'Untrusted transcript says people/injected.',
          '## Timeline',
          '- 2026-07-30: Injected event',
          '```',
        ].join('\n'),
        expected_content_hash: null,
      },
      ctx,
    ) as {
      auto_links?: { skipped?: string };
      auto_timeline?: { skipped?: string };
      facts_backstop?: { skipped?: string };
      chronicle_backstop?: { skipped?: string };
    };

    expect(result.auto_links?.skipped).toBe('remote');
    expect(result.auto_timeline?.skipped).toBe('remote');
    expect(result.facts_backstop?.skipped).toBe('raw_source');
    expect(result.chronicle_backstop?.skipped).toBe('remote');
    expect(await engine.getLinks('sources/granola-note')).toEqual([]);
  });

  test('buildBrainTools rejects a malformed sourceId at build time (#1586)', () => {
    expect(() =>
      buildBrainTools({ subagentId: 1, engine, config, sourceId: '../evil' }),
    ).toThrow();
  });
});

describe('filterAllowedTools', () => {
  test('passes prefixed names through', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'brain_search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('accepts un-prefixed names as a convenience', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['get_page', 'search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('rejects unknown tool names (no silent ignore)', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(() => filterAllowedTools(tools, ['brain_typo_nope'])).toThrow(/unknown tool/);
  });

  test('deduplicates when both prefixed + unprefixed given', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'get_page']);
    expect(filtered.length).toBe(1);
  });

  test('empty array yields empty registry', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(filterAllowedTools(tools, [])).toEqual([]);
  });
});

describe('sanitizeToolName', () => {
  test('returns within 64 chars', () => {
    // Synthetic: simulate an op name long enough to need slicing.
    const long = 'a'.repeat(100);
    expect(__testing.sanitizeToolName(long).length).toBeLessThanOrEqual(64);
  });

  test('replaces non-conforming chars with _', () => {
    expect(__testing.sanitizeToolName('foo.bar')).toBe('brain_foo_bar');
  });
});
