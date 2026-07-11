/**
 * Cross-process cache for short-lived OAuth client-credentials access tokens.
 *
 * Thin-client CLI commands are one process per operation. An in-memory cache
 * therefore cannot prevent every invocation from minting a new token. This
 * cache stores only the short-lived access token (never the client secret) in
 * a private directory under GBRAIN_HOME, with one file per token endpoint /
 * client / scope tuple.
 */

import { createHash } from 'crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'fs/promises';
import { join } from 'path';
import { gbrainPath } from './config.ts';

const CACHE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

export interface OAuthTokenCacheIdentity {
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
}

export interface OAuthTokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

interface StoredOAuthToken extends OAuthTokenCacheEntry {
  version: typeof CACHE_VERSION;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
}

function cacheEnabled(): boolean {
  return process.env.GBRAIN_REMOTE_TOKEN_CACHE !== '0';
}

function normalizedIdentity(identity: OAuthTokenCacheIdentity): Required<OAuthTokenCacheIdentity> {
  return {
    tokenEndpoint: identity.tokenEndpoint,
    clientId: identity.clientId,
    scope: identity.scope ?? '',
  };
}

export function oauthTokenCacheKey(identity: OAuthTokenCacheIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function cachePaths(identity: OAuthTokenCacheIdentity): {
  dir: string;
  entry: string;
  lock: string;
} {
  const dir = gbrainPath('oauth-token-cache');
  const key = oauthTokenCacheKey(identity);
  return {
    dir,
    entry: join(dir, `${key}.json`),
    lock: join(dir, `${key}.lock`),
  };
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir honors umask only at creation time. Tighten an existing directory
  // too; a bearer cache must never inherit group/world-readable permissions.
  await chmod(dir, 0o700);
}

function isStoredToken(value: unknown, identity: OAuthTokenCacheIdentity): value is StoredOAuthToken {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredOAuthToken>;
  const normalized = normalizedIdentity(identity);
  return candidate.version === CACHE_VERSION
    && candidate.tokenEndpoint === normalized.tokenEndpoint
    && candidate.clientId === normalized.clientId
    && candidate.scope === normalized.scope
    && typeof candidate.accessToken === 'string'
    && candidate.accessToken.length > 0
    && typeof candidate.expiresAtMs === 'number'
    && Number.isFinite(candidate.expiresAtMs);
}

/** Read a still-valid cached token. Invalid, expired, or insecure files miss. */
export async function readOAuthTokenCache(
  identity: OAuthTokenCacheIdentity,
  nowMs = Date.now(),
): Promise<OAuthTokenCacheEntry | null> {
  if (!cacheEnabled()) return null;
  const paths = cachePaths(identity);
  try {
    const metadata = await stat(paths.entry);
    // POSIX mode bits are meaningful on Unix. Refuse to consume a bearer
    // token that another user could read; the next successful write repairs it.
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(await readFile(paths.entry, 'utf8'));
    if (!isStoredToken(parsed, identity) || parsed.expiresAtMs <= nowMs) return null;
    return { accessToken: parsed.accessToken, expiresAtMs: parsed.expiresAtMs };
  } catch {
    return null;
  }
}

/** Atomically publish one private cache entry. */
export async function writeOAuthTokenCache(
  identity: OAuthTokenCacheIdentity,
  token: OAuthTokenCacheEntry,
): Promise<void> {
  if (!cacheEnabled()) return;
  const paths = cachePaths(identity);
  await ensurePrivateDirectory(paths.dir);
  const normalized = normalizedIdentity(identity);
  const stored: StoredOAuthToken = {
    version: CACHE_VERSION,
    ...normalized,
    accessToken: token.accessToken,
    expiresAtMs: token.expiresAtMs,
  };
  const temp = join(paths.dir, `.${oauthTokenCacheKey(identity)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, paths.entry);
    await chmod(paths.entry, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function removeStaleLock(lockPath: string, nowMs: number): Promise<void> {
  try {
    const metadata = await stat(lockPath);
    if (nowMs - metadata.mtimeMs > LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // It disappeared between checks, which is the desired outcome.
  }
}

async function releaseOwnedLock(handle: FileHandle, lockPath: string): Promise<void> {
  try {
    const [owned, current] = await Promise.all([handle.stat(), stat(lockPath)]);
    // A stale-lock recovery may have replaced our pathname while our original
    // file descriptor remained open. Never unlink a successor's lock.
    if (owned.dev === current.dev && owned.ino === current.ino) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Missing/replaced lock is already released from this process's view.
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Return a cached token or mint exactly once behind a cross-process lock.
 * Cache I/O is best-effort: an unwritable home must not make remote auth fail.
 */
export async function getOrCreateCachedOAuthToken(
  identity: OAuthTokenCacheIdentity,
  mint: () => Promise<OAuthTokenCacheEntry>,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<OAuthTokenCacheEntry> {
  const now = opts.now ?? Date.now;
  if (!cacheEnabled()) return mint();
  if (!opts.force) {
    const cached = await readOAuthTokenCache(identity, now());
    if (cached) return cached;
  }

  const paths = cachePaths(identity);
  try {
    await ensurePrivateDirectory(paths.dir);
  } catch {
    return mint();
  }

  const deadline = now() + LOCK_WAIT_MS;
  let lockHandle: FileHandle;
  while (true) {
    try {
      lockHandle = await open(paths.lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return mint();
      if (!opts.force) {
        const cached = await readOAuthTokenCache(identity, now());
        if (cached) return cached;
      }
      await removeStaleLock(paths.lock, now());
      if (now() >= deadline) return mint();
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    // The process ahead of us may have populated the cache before releasing
    // the lock. Recheck after acquisition to avoid a duplicate token mint.
    if (!opts.force) {
      const cached = await readOAuthTokenCache(identity, now());
      if (cached) return cached;
    }
    const token = await mint();
    await writeOAuthTokenCache(identity, token).catch(() => {});
    return token;
  } finally {
    await releaseOwnedLock(lockHandle, paths.lock);
  }
}
