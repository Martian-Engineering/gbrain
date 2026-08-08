/** Bounded model-context projection for authenticated get_page results. */

import { isValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';
import type { ToolLoopContextPolicy } from './ai/tool-loop-context.ts';

const PROJECTION_SCHEMA = 'gbrain.page_read_verification_projection.v1';
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

interface PageReadVerificationIdentity {
  source_id: string;
  slug: string;
  content_hash: string;
}

/** Keep oversized page reads useful for hash verification without retaining private body text. */
export const pageReadVerificationContextPolicy: ToolLoopContextPolicy = {
  toolName: 'brain_get_page',
  projectResult: projectPageReadResult,
};

/** Project a large authenticated page result to validated identity and revision only. */
function projectPageReadResult(value: unknown, maxBytes: number): unknown {
  const serialized = safeJson(value);
  const identity = readVerificationIdentity(value);
  if (!identity) return unavailableProjection(maxBytes);
  if (utf8Bytes(serialized) <= maxBytes) return value;

  const projection = {
    ...identity,
    working_context_projection: {
      schema: PROJECTION_SCHEMA,
      original_json_utf8_bytes: utf8Bytes(serialized),
      interpretation: 'authenticated_page_identity_and_content_hash_only',
    },
  };
  return jsonBytes(projection) <= maxBytes
    ? projection
    : unavailableProjection(maxBytes);
}

/** Accept only bounded canonical identity and a complete lowercase SHA-256 hash. */
function readVerificationIdentity(value: unknown): PageReadVerificationIdentity | null {
  const record = recordValue(value);
  if (
    !record
    || !isValidSourceId(record.source_id)
    || !isValidPageSlug(record.slug)
    || typeof record.content_hash !== 'string'
    || !CONTENT_HASH_RE.test(record.content_hash)
  ) {
    return null;
  }
  return {
    source_id: record.source_id,
    slug: record.slug,
    content_hash: record.content_hash,
  };
}

/** Accept canonical stored-page slugs while bounding projected identity size. */
function isValidPageSlug(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) return false;
  try {
    return validateSlug(value) === value;
  } catch {
    return false;
  }
}

/** Emit no partial identity when verification data is malformed or cannot fit. */
function unavailableProjection(maxBytes: number): unknown {
  const projection = {
    working_context_projection: {
      schema: PROJECTION_SCHEMA,
      verification: 'unavailable',
      interpretation: 'malformed_page_identity_or_content_hash',
    },
  };
  return jsonBytes(projection) <= maxBytes
    ? projection
    : { working_context_projection: true };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(safeJson(value));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? String(value);
  } catch {
    return String(value);
  }
}
