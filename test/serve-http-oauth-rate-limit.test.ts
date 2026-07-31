import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveOAuthRateLimit } from '../src/commands/serve-http.ts';

describe('resolveOAuthRateLimit', () => {
  test('retains the secure default when unset or invalid', () => {
    expect(resolveOAuthRateLimit(undefined)).toBe(50);
    expect(resolveOAuthRateLimit('')).toBe(50);
    expect(resolveOAuthRateLimit('0')).toBe(50);
    expect(resolveOAuthRateLimit('-1')).toBe(50);
    expect(resolveOAuthRateLimit('50 requests')).toBe(50);
    expect(resolveOAuthRateLimit('1000001')).toBe(50);
  });

  test('accepts a bounded positive integer override', () => {
    expect(resolveOAuthRateLimit(' 500 ')).toBe(500);
    expect(resolveOAuthRateLimit('1000000')).toBe(1_000_000);
  });
});

test('the OAuth limiter is mounted once for every token grant path', () => {
  const source = readFileSync(
    new URL('../src/commands/serve-http.ts', import.meta.url),
    'utf8',
  );
  expect(source.match(/app\.use\('\/token', ccRateLimiter\)/g)).toHaveLength(1);
  expect(source).not.toContain("app.post('/token', ccRateLimiter");
});
