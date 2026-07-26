import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationsByName } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let tempDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-link-pack-'));
});

function installPack(): string {
  const packDir = join(tempDir, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packPath = join(packDir, 'pack.yaml');
  writeFileSync(packPath, `api_version: gbrain-schema-pack-v1
name: link-pack-test
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
link_directories: [partners]
page_types: []
link_types: []
frontmatter_links: []
takes_kinds: [fact, take, bet, hunch]
enrichable_types: []
filing_rules: []
`, 'utf8');
  return packPath;
}

describe('pack-extensible link directories', () => {
  test('trusted put_page honors a DB-configured link_directories tree', async () => {
    const packPath = installPack();
    __setPackLocatorForTests((name) => name === 'link-pack-test' ? packPath : null);
    await engine.setConfig('schema_pack.source.default', 'link-pack-test');

    await engine.putPage('partners/example', {
      type: 'concept',
      title: 'Example Partner',
      compiled_truth: '',
      timeline: '',
      frontmatter: {},
    });

    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await operationsByName.put_page!.handler(
        {
          engine,
          config: {} as never,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          dryRun: false,
          remote: false,
          sourceId: 'default',
        },
        {
          slug: 'concepts/link-source',
          content: `---
type: concept
title: Link Source
---

See [[default:partners/example|Example Partner]].
`,
        },
      );
    });

    const links = await engine.getLinks('concepts/link-source', { sourceId: 'default' });
    expect(links.map((link) => link.to_slug)).toContain('partners/example');
  });

  test('unscoped stale extraction resolves directories per source', async () => {
    const packPath = installPack();
    __setPackLocatorForTests((name) => name === 'link-pack-test' ? packPath : null);
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      ['client-a'],
    );
    await engine.setConfig('schema_pack.source.client-a', 'link-pack-test');
    await engine.putPage('partners/example', {
      type: 'concept',
      title: 'Example Partner',
      compiled_truth: '',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'client-a' });
    await engine.putPage('concepts/link-source', {
      type: 'concept',
      title: 'Link Source',
      compiled_truth: 'See [[partners/example|Example Partner]].',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'client-a' });

    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, () =>
      extractStaleFromDB(engine, {
        dryRun: false,
        jsonMode: true,
        includeFrontmatter: false,
        catchUp: true,
      }));

    const links = await engine.getLinks('concepts/link-source', { sourceId: 'client-a' });
    expect(links.map((link) => link.to_slug)).toContain('partners/example');
  });
});
