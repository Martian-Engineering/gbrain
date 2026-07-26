import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
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

function page(title: string) {
  return {
    type: 'person',
    title,
    compiled_truth: `${title} is an engineer.`,
    timeline: '',
    frontmatter: { title },
  };
}

async function seedPage(slug: string, title: string, sourceId = 'default') {
  await engine.putPage(slug, page(title), { sourceId });
}

function ctx(
  sourceId = 'default',
  auth: OperationContext['auth'] = {
    token: 'token',
    clientId: 'source-admin',
    scopes: ['admin'],
    sourceId,
  },
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth,
  };
}

const renamedContent = `---
title: Rowan North
aliases:
  - Rowan Old
---

Rowan North is an engineer.
`;

describe('rename_page operation', () => {
  test('is a remote-capable write operation with a source-qualified result', async () => {
    const op = operationsByName.rename_page;
    expect(op).toBeDefined();
    expect(op.scope).toBe('write');
    expect(op.localOnly).not.toBe(true);
    expect(op.params).toHaveProperty('old_slug');
    expect(op.params).toHaveProperty('new_slug');
    expect(op.params).toHaveProperty('content');
    expect(op.params).toHaveProperty('source_id');
  });

  test('atomically creates the destination and aliases the retired origin', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');

    const result = await operationsByName.rename_page.handler(ctx(), {
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
      content: renamedContent,
      source_id: 'default',
    });

    expect(result).toMatchObject({
      status: 'renamed',
      source_id: 'default',
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
      alias_created: true,
      old_page_soft_deleted: true,
    });
    expect(await engine.getPage('people/rowan-north', { sourceId: 'default' }))
      .toMatchObject({ title: 'Rowan North', source_id: 'default' });
    expect(await engine.getPage('people/rowan-old', {
      sourceId: 'default',
      includeDeleted: true,
    })).toMatchObject({ title: 'Rowan Old' });
    expect(await engine.resolveSlugWithAlias('people/rowan-old', 'default'))
      .toBe('people/rowan-north');
  });

  test('rejects file removal from a source-bound write-only client', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');
    const writeAuth = {
      token: 'token',
      clientId: 'source-writer',
      scopes: ['write'],
      sourceId: 'default',
    };

    await expect(operationsByName.rename_page.handler(
      ctx('default', writeAuth),
      {
        old_slug: 'people/rowan-old',
        new_slug: 'people/rowan-north',
        content: renamedContent,
        remove_file: true,
      },
    )).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getPage('people/rowan-old', { sourceId: 'default' }))
      .not.toBeNull();
  });

  test('allows a source-bound source admin to request confined file removal', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');
    const sourceAdmin = {
      token: 'token',
      clientId: 'source-admin',
      scopes: ['read', 'write', 'source_admin'],
      sourceId: 'default',
    };
    const result = await operationsByName.rename_page.handler(ctx('default', sourceAdmin), {
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
      content: renamedContent,
      remove_file: true,
    });
    expect(result).toMatchObject({
      status: 'renamed',
      source_id: 'default',
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
    });
  });

  test('preserves the origin suppression fence on the destination', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug: 'people/rowan-old',
      claim_text: 'Rowan Old is an engineer.',
      reason: 'Refuted',
    });

    await operationsByName.rename_page.handler(ctx(), {
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
      content: renamedContent,
    });

    const destination = await engine.getPage('people/rowan-north', {
      sourceId: 'default',
    });
    expect(destination?.compiled_truth).toContain('gbrain:suppressions:begin');
    expect(destination?.compiled_truth).toContain('Rowan Old is an engineer.');
  });

  test('rejects a rename that reasserts an active suppressed claim', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug: 'people/rowan-old',
      claim_text: 'Rowan Old is an engineer.',
      reason: 'Refuted',
    });

    await expect(operationsByName.rename_page.handler(ctx(), {
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
      content: `---
title: Rowan North
---

Rowan Old is an engineer.
`,
    })).rejects.toMatchObject({ code: 'suppression_reassertion' });
    expect(await engine.getPage('people/rowan-old', { sourceId: 'default' }))
      .not.toBeNull();
    expect(await engine.getPage('people/rowan-north', { sourceId: 'default' }))
      .toBeNull();
  });

  test('rolls back the destination when alias retirement fails', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');
    const originalMigrateFacts = engine.migrateFactsToCanonical;
    engine.migrateFactsToCanonical = async () => {
      throw new Error('injected alias failure');
    };

    try {
      await expect(operationsByName.rename_page.handler(ctx(), {
        old_slug: 'people/rowan-old',
        new_slug: 'people/rowan-north',
        content: renamedContent,
      })).rejects.toThrow('injected alias failure');
    } finally {
      engine.migrateFactsToCanonical = originalMigrateFacts;
    }

    expect(await engine.getPage('people/rowan-old', { sourceId: 'default' }))
      .toMatchObject({ title: 'Rowan Old', deleted_at: null });
    expect(await engine.getPage('people/rowan-north', { sourceId: 'default' }))
      .toBeNull();
    expect(await engine.resolveSlugWithAlias('people/rowan-old', 'default'))
      .toBe('people/rowan-old');
  });

  test('cannot route a remote rename outside the OAuth write source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ('restricted', 'restricted'), ('public', 'public')
       ON CONFLICT (id) DO NOTHING`,
    );
    await seedPage('people/rowan-old', 'Rowan Old', 'restricted');
    await seedPage('people/rowan-old', 'Public Rowan', 'public');

    await expect(operationsByName.rename_page.handler(
      ctx('restricted'),
      {
        old_slug: 'people/rowan-old',
        new_slug: 'people/rowan-north',
        content: renamedContent,
        source_id: 'public',
      },
    )).rejects.toMatchObject({ code: 'permission_denied' });

    expect(await engine.getPage('people/rowan-old', { sourceId: 'restricted' }))
      .toMatchObject({ title: 'Rowan Old' });
    expect(await engine.getPage('people/rowan-old', { sourceId: 'public' }))
      .toMatchObject({ title: 'Public Rowan' });
    expect(await engine.getPage('people/rowan-north', { sourceId: 'restricted' }))
      .toBeNull();
    expect(await engine.getPage('people/rowan-north', { sourceId: 'public' }))
      .toBeNull();
  });

  test('dry-run validates the source and reports the exact destination', async () => {
    await seedPage('people/rowan-old', 'Rowan Old');

    const result = await operationsByName.rename_page.handler(
      { ...ctx(), dryRun: true },
      {
        old_slug: 'people/rowan-old',
        new_slug: 'people/rowan-north',
        content: renamedContent,
      },
    );

    expect(result).toEqual({
      dry_run: true,
      action: 'rename_page',
      source_id: 'default',
      old_slug: 'people/rowan-old',
      new_slug: 'people/rowan-north',
    });
    expect(await engine.getPage('people/rowan-old', { sourceId: 'default' }))
      .toMatchObject({ title: 'Rowan Old' });
    expect(await engine.getPage('people/rowan-north', { sourceId: 'default' }))
      .toBeNull();
  });
});
