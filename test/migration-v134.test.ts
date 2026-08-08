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

  test('registers the nullable idempotent column migration', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 134);
    expect(migration).toMatchObject({
      name: 'take_proposals_review_owner',
      idempotent: true,
    });
    expect(migration?.sql).toContain(
      'ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS review_owner TEXT',
    );
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(134);
  });

  test('adds the nullable column and can safely reapply it', async () => {
    const pendingMigrations = MIGRATIONS.filter(entry => entry.version > 133).length;
    await engine.executeRaw(
      `ALTER TABLE take_proposals DROP COLUMN IF EXISTS review_owner`,
    );
    await engine.setConfig('version', '133');

    const first = await runMigrations(engine);
    expect(first).toEqual({
      applied: pendingMigrations,
      current: LATEST_VERSION,
    });
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
    expect(second).toEqual({
      applied: pendingMigrations,
      current: LATEST_VERSION,
    });
  }, 30_000);
});
