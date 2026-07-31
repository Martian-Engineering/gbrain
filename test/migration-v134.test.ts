/**
 * Migration v134 — nullable take-proposal review ownership.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  LATEST_VERSION,
  MIGRATIONS,
  runMigrations,
} from '../src/core/migrate.ts';

describe('migration v134 — take proposal review owner', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('registers the nullable idempotent column migration as latest', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 134);
    expect(migration).toMatchObject({
      name: 'take_proposals_review_owner',
      idempotent: true,
    });
    expect(migration?.sql).toContain(
      'ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS review_owner TEXT',
    );
    expect(LATEST_VERSION).toBe(134);
  });

  test('adds the nullable column and can safely reapply it', async () => {
    await engine.executeRaw(
      `ALTER TABLE take_proposals DROP COLUMN IF EXISTS review_owner`,
    );
    await engine.setConfig('version', '133');

    const first = await runMigrations(engine);
    expect(first).toEqual({ applied: 1, current: 134 });
    const columns = await engine.executeRaw<{
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'take_proposals'
          AND column_name = 'review_owner'`,
    );
    expect(columns).toEqual([{
      is_nullable: 'YES',
      column_default: null,
    }]);

    await engine.setConfig('version', '133');
    const second = await runMigrations(engine);
    expect(second).toEqual({ applied: 1, current: 134 });
  }, 30_000);
});
