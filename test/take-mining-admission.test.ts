import { describe, expect, test } from 'bun:test';
import {
  classifyTakeMiningAdmission,
  type TakeMiningAdmission,
  type WriteIntent,
} from '../src/core/take-mining-admission.ts';

const semanticChangeCases = [
  ['user_edit', 'immediate'],
  ['live_ingest', 'immediate'],
  ['maintenance', 'deferred'],
  ['backfill', 'deferred'],
  ['derived', 'deferred'],
] as const satisfies ReadonlyArray<readonly [WriteIntent, TakeMiningAdmission]>;

const writeIntents = semanticChangeCases.map(([intent]) => intent);

describe('classifyTakeMiningAdmission', () => {
  test.each(semanticChangeCases)(
    'classifies a semantic change from %s as %s',
    (writeIntent, expected) => {
      expect(classifyTakeMiningAdmission({ writeIntent, semanticChanged: true })).toBe(expected);
    },
  );

  test.each(writeIntents)('semantic no-op dominates the %s write intent', (writeIntent) => {
    expect(classifyTakeMiningAdmission({ writeIntent, semanticChanged: false })).toBe('none');
  });
});
