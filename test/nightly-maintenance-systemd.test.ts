import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('nightly maintenance systemd units', () => {
  test('timer runs once at 10:00 UTC and is installable but not self-enabled', () => {
    const timer = readFileSync(
      join(root, 'ops/systemd/gbrain-nightly-maintenance.timer'),
      'utf8',
    );
    expect(timer).toContain('OnCalendar=*-*-* 10:00:00 UTC');
    expect(timer).toContain('Persistent=true');
    expect(timer).not.toContain('OnUnitActiveSec');
  });

  test('service submits the fixed production budget and mutation ceiling', () => {
    const service = readFileSync(
      join(root, 'ops/systemd/gbrain-nightly-maintenance.service'),
      'utf8',
    );
    expect(service).toContain('jobs nightly-maintenance');
    expect(service).toContain('--budget-cents 1500');
    expect(service).toContain('--max-page-mutations 10');
  });
});
