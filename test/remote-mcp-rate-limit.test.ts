import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import { mintClientCredentialsToken } from '../src/core/remote-mcp-probe.ts';

let server: Server;
let tokenEndpoint = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 429;
    res.setHeader('Retry-After', '42');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'too_many_requests' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  tokenEndpoint = `http://127.0.0.1:${address.port}/token`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('OAuth token rate limits', () => {
  test('classifies 429 separately and preserves Retry-After', async () => {
    const result = await mintClientCredentialsToken(tokenEndpoint, 'client-a', 'secret-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate_limited');
    expect(result.status).toBe(429);
    expect(result.retryAfterSeconds).toBe(42);
    expect(result.message).toContain('retry after 42s');
  });
});
