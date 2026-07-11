import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  getOrCreateCachedOAuthToken,
  oauthTokenCacheKey,
  readOAuthTokenCache,
  writeOAuthTokenCache,
} from '../src/core/oauth-token-cache.ts';
import { parseRetryAfterSeconds } from '../src/core/remote-mcp-probe.ts';
import { withEnv } from './helpers/with-env.ts';

const cleanup: string[] = [];

async function isolatedHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-oauth-cache-'));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('OAuth token cache', () => {
  test('writes a private file and reads it before expiry', async () => {
    const home = await isolatedHome();
    const identity = { tokenEndpoint: 'https://issuer.example/token', clientId: 'client-a', scope: 'read write' };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await writeOAuthTokenCache(identity, { accessToken: 'short-lived-token', expiresAtMs: 20_000 });
      expect(await readOAuthTokenCache(identity, 10_000)).toEqual({
        accessToken: 'short-lived-token',
        expiresAtMs: 20_000,
      });
      const path = join(home, '.gbrain', 'oauth-token-cache', `${oauthTokenCacheKey(identity)}.json`);
      const metadata = await stat(path);
      if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o600);
      expect(await readFile(path, 'utf8')).not.toContain('client_secret');
    });
  });

  test('misses expired tokens and isolates client/scope identities', async () => {
    const home = await isolatedHome();
    const identity = { tokenEndpoint: 'https://issuer.example/token', clientId: 'client-a', scope: 'read' };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await writeOAuthTokenCache(identity, { accessToken: 'token-a', expiresAtMs: 20_000 });
      expect(await readOAuthTokenCache(identity, 20_001)).toBeNull();
      expect(await readOAuthTokenCache({ ...identity, clientId: 'client-b' }, 10_000)).toBeNull();
      expect(await readOAuthTokenCache({ ...identity, scope: 'write' }, 10_000)).toBeNull();
    });
  });

  test('serializes concurrent cold-cache mints', async () => {
    const home = await isolatedHome();
    const identity = { tokenEndpoint: 'https://issuer.example/token', clientId: 'client-a' };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      let mints = 0;
      const mint = async () => {
        mints++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { accessToken: 'shared-token', expiresAtMs: Date.now() + 60_000 };
      };
      const tokens = await Promise.all(Array.from({ length: 8 }, () => getOrCreateCachedOAuthToken(identity, mint)));
      expect(mints).toBe(1);
      expect(tokens.every(token => token.accessToken === 'shared-token')).toBe(true);
    });
  });

  test('force bypasses an otherwise valid cached token', async () => {
    const home = await isolatedHome();
    const identity = { tokenEndpoint: 'https://issuer.example/token', clientId: 'client-a' };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await writeOAuthTokenCache(identity, { accessToken: 'old-token', expiresAtMs: Date.now() + 60_000 });
      let mints = 0;
      const result = await getOrCreateCachedOAuthToken(identity, async () => {
        mints++;
        return { accessToken: 'fresh-token', expiresAtMs: Date.now() + 60_000 };
      }, { force: true });
      expect(mints).toBe(1);
      expect(result.accessToken).toBe('fresh-token');
      expect((await readOAuthTokenCache(identity))?.accessToken).toBe('fresh-token');
    });
  });

  test('reuses one token across separate CLI processes', async () => {
    const home = await isolatedHome();
    let tokenRequests = 0;
    let server: Server;
    server = createServer((req, res) => {
      if (req.url !== '/token') {
        res.statusCode = 404;
        res.end();
        return;
      }
      tokenRequests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: 'cross-process-token', token_type: 'bearer', expires_in: 3600 }));
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      const moduleUrl = pathToFileURL(resolve('src/core/oauth-token-cache.ts')).href;
      const code = `
        import { getOrCreateCachedOAuthToken } from ${JSON.stringify(moduleUrl)};
        await getOrCreateCachedOAuthToken(
          { tokenEndpoint: ${JSON.stringify(`http://127.0.0.1:${address.port}/token`)}, clientId: 'client-a' },
          async () => {
            const response = await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/token`)}, { method: 'POST' });
            const token = await response.json();
            return { accessToken: token.access_token, expiresAtMs: Date.now() + 3_600_000 };
          },
        );
      `;
      for (let i = 0; i < 2; i++) {
        const child = Bun.spawn([process.execPath, '-e', code], {
          cwd: process.cwd(),
          env: { ...process.env, GBRAIN_HOME: home },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
      }
      expect(tokenRequests).toBe(1);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });
});

describe('Retry-After parsing', () => {
  test('accepts delta-seconds and HTTP dates', () => {
    expect(parseRetryAfterSeconds('37', 0)).toBe(37);
    expect(parseRetryAfterSeconds('Thu, 01 Jan 1970 00:01:00 GMT', 30_000)).toBe(30);
  });

  test('returns undefined for absent or malformed values', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds('later')).toBeUndefined();
  });
});
