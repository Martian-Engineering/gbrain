import { createAuditWriter } from './audit-writer.ts';

export type SlugAliasAuditActor =
  | 'cli'
  | `mcp:${string}`
  | `principal:${string}`;
export type SlugAliasAuditOutcome =
  | 'added'
  | 'replaced'
  | 'unchanged'
  | 'removed'
  | 'not_found'
  | 'failure';

export interface SlugAliasAuditEvent {
  ts: string;
  op: 'add_slug_alias' | 'remove_slug_alias';
  actor: SlugAliasAuditActor;
  source_id: string;
  alias_slug: string;
  canonical_slug?: string;
  notes?: string;
  outcome: SlugAliasAuditOutcome;
  reason?: string;
}

const writer = createAuditWriter<SlugAliasAuditEvent>({
  featureName: 'slug-aliases',
  errorLabel: 'slug-alias-audit',
  errorTrailer: '; operation continues',
});

export function logSlugAliasAudit(
  event: Omit<SlugAliasAuditEvent, 'ts'> & { ts?: string },
): void {
  writer.log(event);
}

export function readRecentSlugAliasAudit(
  days = 7,
  now: Date = new Date(),
): SlugAliasAuditEvent[] {
  return writer.readRecent(days, now);
}
