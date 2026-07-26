import { describe, expect, test } from 'bun:test';
import {
  renderTakeMiningRequest,
  TAKE_MINING_MAX_OUTPUT_TOKENS,
} from '../src/core/cycle/take-mining-request.ts';

describe('take-mining extractor request', () => {
  test('estimates the complete rendered request from UTF-8 bytes', () => {
    const existingTakes = [{
      claim: 'A prior judgment',
      kind: 'take',
      holder: 'brain',
      weight: 0.5,
    }];
    const request = renderTakeMiningRequest({
      pagePath: 'notes/example',
      pageBody: 'A multibyte belief: café will expand.',
      existingTakes,
      modelHint: 'anthropic:claude-haiku-4-5',
    });

    expect(request.messages[0]?.content).toContain(JSON.stringify(existingTakes, null, 2));
    expect(request.messages[0]?.content).toContain('A multibyte belief: café will expand.');
    expect(request.estimatedInputTokens).toBe(
      Buffer.byteLength(JSON.stringify(request.messages), 'utf8'),
    );
    expect(request.maxTokens).toBe(TAKE_MINING_MAX_OUTPUT_TOKENS);
    expect(request.maxTokens).toBe(2048);
  });

  test('charges larger page bodies and existing-take context more', () => {
    const base = renderTakeMiningRequest({
      pagePath: 'notes/short',
      pageBody: 'Short.',
      existingTakes: [],
    });
    const larger = renderTakeMiningRequest({
      pagePath: 'notes/long',
      pageBody: `Short.\n${'Long semantic context. '.repeat(100)}`,
      existingTakes: [{
        claim: 'Already captured',
        kind: 'take',
        holder: 'brain',
        weight: 0.7,
      }],
    });

    expect(larger.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens);
  });
});
