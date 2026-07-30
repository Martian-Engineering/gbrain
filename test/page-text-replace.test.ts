import { describe, expect, test } from 'bun:test';
import {
  PageTextReplaceError,
  replaceAuthoredPageText,
} from '../src/core/page-text-replace.ts';

describe('replaceAuthoredPageText', () => {
  test('replaces the required number of literal authored matches', () => {
    const result = replaceAuthoredPageText(
      'Acme builds tools.\n\nAcme ships them.',
      'Acme',
      'Widget Co',
      2,
    );

    expect(result.content).toBe('Widget Co builds tools.\n\nWidget Co ships them.');
    expect(result.replaced).toBe(2);
    expect(result.protectedMatches).toBe(0);
  });

  test('matches case-sensitively and supports Unicode and multiline text', () => {
    const result = replaceAuthoredPageText(
      'Résumé\nold line\nsecond line\nrésumé',
      'Résumé\nold line',
      'Résumé\nnew line',
      1,
    );

    expect(result.content).toBe('Résumé\nnew line\nsecond line\nrésumé');
  });

  test('preserves every managed region byte-for-byte', () => {
    const managed = [
      '<!--- gbrain:takes:begin -->',
      '| 1 | Acme |',
      '<!--- gbrain:takes:end -->',
    ].join('\n');
    const input = `Acme authored\n\n${managed}\n\nAcme conclusion`;

    const result = replaceAuthoredPageText(input, 'Acme', 'Widget', 2);

    expect(result.content).toBe(`Widget authored\n\n${managed}\n\nWidget conclusion`);
    expect(result.protectedMatches).toBe(1);
    expect(result.content.slice(
      result.content.indexOf('<!--- gbrain:takes:begin -->'),
      result.content.indexOf('<!--- gbrain:takes:end -->') + '<!--- gbrain:takes:end -->'.length,
    )).toBe(managed);
  });

  test('protects managed regions using the two-hyphen marker form', () => {
    const input = [
      'Acme authored',
      '<!-- gbrain:backlinks:begin -->',
      'Acme generated',
      '<!-- gbrain:backlinks:end -->',
    ].join('\n');

    const result = replaceAuthoredPageText(input, 'Acme', 'Widget', 1);

    expect(result.content).toContain('Widget authored');
    expect(result.content).toContain('Acme generated');
    expect(result.protectedMatches).toBe(1);
  });

  test('rejects an empty old_text', () => {
    expect(() => replaceAuthoredPageText('body', '', 'new', 1))
      .toThrow(new PageTextReplaceError('invalid_old_text', 'old_text must be non-empty'));
  });

  test('reports authored and protected counts when the expected count differs', () => {
    const input = [
      'Acme authored',
      '<!--- gbrain:facts:begin -->',
      'Acme protected',
      '<!--- gbrain:facts:end -->',
    ].join('\n');

    try {
      replaceAuthoredPageText(input, 'Acme', 'Widget', 2);
      throw new Error('expected replacement to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PageTextReplaceError);
      expect((error as PageTextReplaceError).code).toBe('match_count_mismatch');
      expect((error as PageTextReplaceError).details).toEqual({
        expectedMatches: 2,
        editableMatches: 1,
        protectedMatches: 1,
      });
    }
  });

  test('rejects malformed and mismatched managed regions', () => {
    const unclosed = '<!--- gbrain:takes:begin -->\nAcme';
    const mismatched = [
      '<!--- gbrain:takes:begin -->',
      'Acme',
      '<!--- gbrain:facts:end -->',
    ].join('\n');

    for (const input of [unclosed, mismatched]) {
      try {
        replaceAuthoredPageText(input, 'Acme', 'Widget', 1);
        throw new Error('expected malformed fence to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(PageTextReplaceError);
        expect((error as PageTextReplaceError).code).toBe('malformed_managed_region');
      }
    }
  });
});
