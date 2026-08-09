import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/core/migrate.ts';

const root = join(import.meta.dir, '..');
const schemaPaths = [
  'src/schema.sql',
  'src/core/schema-embedded.ts',
  'src/core/pglite-schema.ts',
];

describe('proposal rejection ledger schema mirrors', () => {
  it('ships the bounded ledger to every fresh-install schema', () => {
    for (const path of schemaPaths) {
      const schema = readFileSync(join(root, path), 'utf8');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS agent_job_proposal_call_rejections');
      expect(schema).toContain("jsonb_typeof(calls) = 'array'");
      expect(schema).toContain('jsonb_array_length(calls) <= 8');
      expect(schema).toContain('octet_length(calls::text) <= 16384');
      expect(schema).toContain('feedback_message_index');
      expect(schema).toContain('attempt_generation');
      expect(schema).toContain('omitted_call_count');
    }
  });

  it('enables RLS for the Postgres fresh-install mirrors and migration', () => {
    for (const path of ['src/schema.sql', 'src/core/schema-embedded.ts', 'src/core/migrate.ts']) {
      const schema = readFileSync(join(root, path), 'utf8');
      expect(schema).toContain('ALTER TABLE agent_job_proposal_call_rejections ENABLE ROW LEVEL SECURITY');
    }
  });

  it('installs retry-safe identity without a compatibility migration', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 140);
    expect(migration?.sql).toContain('proposal_rejection_generation');
    expect(migration?.sql).toContain('uq_agent_job_proposal_call_rejections_feedback');
    expect(migration?.sql).not.toContain('DROP CONSTRAINT');
    expect(migration?.sqlFor?.pglite).toContain('CREATE TABLE IF NOT EXISTS agent_job_proposal_call_rejections');
  });
});
