import { describe, expect, test } from 'bun:test';
import {
  contentHash,
  extractExistingTakesForDedup,
  hasCompleteFence,
  parseExtractorOutput,
} from '../src/core/cycle/propose-takes.ts';

describe('parseExtractorOutput', () => {
  test('parses arrays, fenced JSON, and a single object', () => {
    const array = parseExtractorOutput(
      '[{"claim_text":"Cities send messages","kind":"take","holder":"brain","weight":0.65}]',
    );
    const fenced = parseExtractorOutput(
      '```json\n[{"claim_text":"X","kind":"bet","holder":"world","weight":0.8}]\n```',
    );
    const object = parseExtractorOutput(
      '{"claim_text":"Y","kind":"hunch","holder":"brain","weight":0.4}',
    );

    expect(array[0]).toMatchObject({
      claim_text: 'Cities send messages',
      kind: 'take',
      weight: 0.65,
    });
    expect(fenced).toHaveLength(1);
    expect(object[0]?.kind).toBe('hunch');
  });

  test('accepts leading prose and rejects malformed or empty output', () => {
    expect(parseExtractorOutput(
      'Here are the takes:\n[{"claim_text":"Z","kind":"take","holder":"brain","weight":0.5}]',
    )).toHaveLength(1);
    expect(parseExtractorOutput('')).toEqual([]);
    expect(parseExtractorOutput('[not valid json')).toEqual([]);
    expect(parseExtractorOutput('unrelated prose')).toEqual([]);
  });

  test('validates rows and normalizes optional fields', () => {
    const longClaim = 'x'.repeat(600);
    const output = parseExtractorOutput(JSON.stringify([
      { kind: 'take', holder: 'brain', weight: 0.5 },
      { claim_text: longClaim, kind: 'take', holder: 'brain', weight: 0.5 },
      { claim_text: 'high', kind: 'unknown', holder: '', weight: 2, domain: 'macro' },
      { claim_text: 'low', kind: 'take', holder: 'brain', weight: -1 },
    ]));

    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      claim_text: 'high',
      kind: 'take',
      holder: 'brain',
      weight: 1,
      domain: 'macro',
    });
    expect(output[1]?.weight).toBe(0);
  });
});

describe('contentHash', () => {
  test('produces deterministic SHA-256 identities', () => {
    expect(contentHash('hello world')).toBe(contentHash('hello world'));
    expect(contentHash('hello world')).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('hasCompleteFence', () => {
  test('recognizes complete standard and triple-dash fences', () => {
    expect(hasCompleteFence(
      '<!-- gbrain:takes:begin -->\n| # |\n<!-- gbrain:takes:end -->',
    )).toBe(true);
    expect(hasCompleteFence(
      '<!--- gbrain:takes:begin -->\n| # |\n<!--- gbrain:takes:end -->',
    )).toBe(true);
  });

  test('rejects incomplete or absent fences', () => {
    expect(hasCompleteFence('<!-- gbrain:takes:begin -->\n| #')).toBe(false);
    expect(hasCompleteFence('plain prose')).toBe(false);
  });
});

describe('extractExistingTakesForDedup', () => {
  test('parses active fence rows and skips strikethrough rows', () => {
    const body = `<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight |
|---|-------|------|-----|--------|
| 1 | ~~stale claim~~ | take | brain | 0.5 |
| 2 | active claim | bet | world | 0.8 |
<!-- gbrain:takes:end -->`;

    expect(extractExistingTakesForDedup(body)).toEqual([{
      claim: 'active claim',
      kind: 'bet',
      holder: 'world',
      weight: 0.8,
    }]);
  });

  test('returns no rows without a fence', () => {
    expect(extractExistingTakesForDedup('plain prose')).toEqual([]);
  });
});
