import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  buildSuppressionPromptBlock,
  collectSuppressionBackstopEvents,
  loadActiveSuppressedClaims,
} from '../src/core/claim-suppression.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing as synthTest } from '../src/core/cycle/synthesize.ts';
import { __testing as patternsTest } from '../src/core/cycle/patterns.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

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
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

async function seedSuppression(): Promise<void> {
  const slug = 'wiki/personal/patterns/launch-timing';
  await engine.putPage(slug, {
    type: 'note',
    title: 'Launch timing',
    compiled_truth: 'The corrected launch date is Monday.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'default' });
  await operationsByName.suppress_claim.handler(ctx(), {
    slug,
    claim_text: 'The launch is Friday.',
    reason: 'User corrected the date',
  });
}

describe('dream-cycle suppression contract', () => {
  test('loads active page suppressions and renders an explicit do-not-reassert block', async () => {
    await seedSuppression();
    const claims = await loadActiveSuppressedClaims(engine, 'default', [
      'wiki/personal/patterns/*',
    ]);
    const block = buildSuppressionPromptBlock(claims);

    expect(claims).toEqual([
      expect.objectContaining({
        slug: 'wiki/personal/patterns/launch-timing',
        claim_text: 'The launch is Friday.',
      }),
    ]);
    expect(block).toContain('DO NOT REASSERT SUPPRESSED CLAIMS');
    expect(block).toContain('wiki/personal/patterns/launch-timing');
    expect(block).toContain('The launch is Friday.');
  });

  test('synthesize and patterns prompts include the suppression block', () => {
    const block = '\nDO NOT REASSERT SUPPRESSED CLAIMS\n- test';
    const transcript = {
      filePath: '/tmp/transcript.txt',
      basename: '2026-07-23-test',
      content: 'The launch is Friday.',
      contentHash: 'abcdef1234567890',
      inferredDate: '2026-07-23',
    };

    const synthPrompt = synthTest.buildSynthesisPrompt(
      transcript,
      transcript.content,
      0,
      1,
      '',
      'wiki',
      block,
    );
    const patternsPrompt = patternsTest.buildPatternsPrompt(
      [{
        slug: 'wiki/personal/reflections/a',
        title: 'A',
        excerpt: 'The launch is Friday.',
      }],
      1,
      'wiki',
      block,
    );

    expect(synthPrompt).toContain(block);
    expect(patternsPrompt).toContain(block);
  });

  test('patterns gathers reflection inputs only from the cycle source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('other', 'Other', '{}'::jsonb)`,
    );
    const slug = 'wiki/personal/reflections/source-boundary';
    await engine.putPage(slug, {
      type: 'reflection',
      title: 'Default reflection',
      compiled_truth: 'Default-only input.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage(slug, {
      type: 'reflection',
      title: 'Other reflection',
      compiled_truth: 'Other-only input.',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'other' });

    const reflections = await patternsTest.gatherReflections(
      engine,
      30,
      'wiki',
      'other',
    );
    expect(reflections).toEqual([{
      slug,
      title: 'Other reflection',
      excerpt: 'Other-only input.',
    }]);
  });

  test('mocked synthesize generation is skipped and recorded when it reasserts a claim', async () => {
    await seedSuppression();
    const slug = 'wiki/personal/patterns/launch-timing';
    const generated = await operationsByName.put_page.handler(ctx({
      remote: true,
      viaSubagent: true,
      subagentId: 9001,
      allowedSlugPrefixes: ['wiki/personal/patterns/*'],
    }), {
      slug,
      content: '---\ntitle: Launch timing\n---\n\nTHE   LAUNCH is friday.',
    });
    expect(generated).toMatchObject({
      status: 'skipped',
      suppression_backstop: {
        action: 'skipped_page_write',
        slug,
        matched_claims: ['The launch is Friday.'],
      },
    });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth)
      .toContain('The corrected launch date is Monday.');

    await engine.executeRaw(
      `INSERT INTO minion_jobs (id, name, status, data)
       VALUES ($1, 'subagent', 'completed', '{}'::jsonb)`,
      [9001],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES
         ($1, 0, 'tool-1', 'brain_put_page', $2::text::jsonb, 'complete', $3::text::jsonb)`,
      [
        9001,
        JSON.stringify({ slug }),
        JSON.stringify(generated),
      ],
    );

    const events = await collectSuppressionBackstopEvents(engine, [9001]);
    expect(events).toEqual([{
      action: 'skipped_page_write',
      slug,
      matched_claims: ['The launch is Friday.'],
    }]);
    const written = await synthTest.collectChildPutPageSlugs(
      engine,
      [9001],
      new Map(),
    );
    expect(written).toEqual([]);
  });
});
