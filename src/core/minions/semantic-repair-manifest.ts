import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { canonicalJson } from '../remediation-step.ts';
import { assertValidSourceId } from '../source-id.ts';
import type { Page } from '../types.ts';
import { contentHash } from '../utils.ts';
import type { BacklinksResult } from '../../commands/backlinks.ts';

export type SemanticRepairFinding =
  | {
      kind: 'link_reference';
      source_id: string;
      page_slug: string;
      status: 'missing' | 'ambiguous' | 'blocked';
      target: string;
      candidates?: string[];
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'frontmatter';
      source_id: string;
      page_slug: string;
      status: 'invalid';
      field: string;
      rule: string;
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'graph_parity';
      source_id: string;
      page_slug: string;
      status: 'missing_graph_edge' | 'missing_backlink_view';
      target: string;
      evidence: Record<string, unknown>;
    };

export interface SemanticRepairReference {
  path?: string;
  identity?: string;
  sha256: string;
}

export interface SemanticRepairManifestContext {
  issued_at: string;
  resolver: SemanticRepairReference;
  schema: SemanticRepairReference;
}

export type SemanticRepairAction =
  | {
      kind: 'replace_reference' | 'update_frontmatter';
      source_id: string;
      page_slug: string;
    }
  | {
      kind: 'create_proposal';
      source_id: string;
      page_slug: string;
    };

export type SemanticRepairVerification =
  | 'source_scope'
  | 'page_hash_changed'
  | 'reference_validation'
  | 'schema_validation';

export interface SemanticRepairManifest {
  schema_version: '1';
  manifest_id: string;
  issued_at: string;
  source_id: string;
  page_slug: string;
  page_hash: string;
  finding_hash: string;
  finding: SemanticRepairFinding;
  resolver: SemanticRepairReference;
  schema: SemanticRepairReference;
  disposition: 'repair' | 'proposal';
  allowed_actions: SemanticRepairAction[];
  required_verification: SemanticRepairVerification[];
  manifest_hash: string;
}

export interface BuildSemanticRepairManifestsOptions {
  /** Hard output bound applied after stable source/page/finding ordering. */
  limit: number;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Return the same canonical page hash used to reject stale repair work. */
export function semanticRepairPageHash(page: Page): string {
  return contentHash({
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
  });
}

/** Hash an arbitrary JSON-shaped repair contract using canonical key ordering. */
function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Validate immutable external references before including them in a manifest. */
function validateReference(name: string, reference: SemanticRepairReference): void {
  if (!SHA256_PATTERN.test(reference.sha256)) {
    throw new Error(`semantic repair manifest: ${name}.sha256 must be a full SHA-256 hash`);
  }
  if (!reference.path && !reference.identity) {
    throw new Error(`semantic repair manifest: ${name} must include path or identity`);
  }
}

/** Derive the only action class that a finding may authorize. */
function actionForFinding(finding: SemanticRepairFinding): {
  disposition: SemanticRepairManifest['disposition'];
  action: SemanticRepairAction['kind'];
} {
  if (finding.kind === 'link_reference' && finding.status === 'missing') {
    return { disposition: 'repair', action: 'replace_reference' };
  }
  if (finding.kind === 'frontmatter') {
    return { disposition: 'repair', action: 'update_frontmatter' };
  }
  return { disposition: 'proposal', action: 'create_proposal' };
}

/** Compute the integrity hash over every manifest field except itself. */
export function computeSemanticRepairManifestHash(
  manifest: Omit<SemanticRepairManifest, 'manifest_hash'>,
): string {
  return sha256(manifest);
}

/**
 * Convert the structured graph audit into source-qualified semantic findings.
 *
 * Unresolved references and graph-parity failures stay visible. Parity
 * failures become proposals because the inverse view is not page content and
 * therefore cannot be repaired by authorizing an agent page rewrite.
 */
export function semanticFindingsFromBacklinks(
  result: BacklinksResult,
): SemanticRepairFinding[] {
  const references: SemanticRepairFinding[] = (result.reference_validation?.findings ?? [])
    .filter(finding => finding.status !== 'resolved')
    .map(finding => ({
      kind: 'link_reference',
      source_id: finding.source_id,
      page_slug: finding.source_slug,
      status: finding.status as 'missing' | 'ambiguous' | 'blocked',
      target: finding.target,
      ...(finding.candidates ? { candidates: [...finding.candidates].sort() } : {}),
      evidence: {
        diagnostic: `reference_${finding.status}`,
        ...(finding.target_source_id ? { target_source_id: finding.target_source_id } : {}),
      },
    }));
  const parity: SemanticRepairFinding[] = (result.graph_findings ?? []).map(finding => ({
    kind: 'graph_parity',
    source_id: finding.source_id,
    page_slug: finding.source_slug,
    status: finding.kind,
    target: finding.target_slug,
    evidence: { diagnostic: finding.kind },
  }));
  return [...references, ...parity];
}

/** Build a stable, bounded set of immutable manifests from deterministic findings. */
export async function buildSemanticRepairManifests(
  engine: BrainEngine,
  findings: SemanticRepairFinding[],
  context: SemanticRepairManifestContext,
  opts: BuildSemanticRepairManifestsOptions,
): Promise<SemanticRepairManifest[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) {
    throw new Error('semantic repair manifests: limit must be an integer from 1 to 100');
  }
  const unique = new Map<string, SemanticRepairFinding>();
  for (const finding of findings) {
    const key = canonicalJson(finding);
    if (!unique.has(key)) unique.set(key, finding);
  }
  const selected = [...unique.values()]
    .sort((a, b) =>
      `${a.source_id}\u0000${a.page_slug}\u0000${sha256(a)}`
        .localeCompare(`${b.source_id}\u0000${b.page_slug}\u0000${sha256(b)}`))
    .slice(0, opts.limit);
  const manifests: SemanticRepairManifest[] = [];
  for (const finding of selected) {
    manifests.push(await buildSemanticRepairManifest(engine, finding, context));
  }
  return manifests;
}

/**
 * Build one immutable, source-bound work order from a deterministic finding.
 *
 * Ambiguous and blocked links can only create proposals. Direct repair
 * actions are limited to the diagnosed page in its owning source.
 */
export async function buildSemanticRepairManifest(
  engine: BrainEngine,
  finding: SemanticRepairFinding,
  context: SemanticRepairManifestContext,
): Promise<SemanticRepairManifest> {
  assertValidSourceId(finding.source_id);
  validateReference('resolver', context.resolver);
  validateReference('schema', context.schema);
  if (!Number.isFinite(Date.parse(context.issued_at))) {
    throw new Error('semantic repair manifest: issued_at must be an ISO timestamp');
  }

  const page = await engine.getPage(finding.page_slug, { sourceId: finding.source_id });
  if (!page || page.source_id !== finding.source_id) {
    throw new Error(
      `semantic repair manifest: source page ${finding.source_id}:${finding.page_slug} not found`,
    );
  }

  const pageHash = semanticRepairPageHash(page);
  const findingHash = sha256(finding);
  const authorization = actionForFinding(finding);
  const manifestBase: Omit<SemanticRepairManifest, 'manifest_hash'> = {
    schema_version: '1',
    manifest_id: `semantic-repair:${finding.source_id}:${finding.page_slug}:${findingHash.slice(0, 12)}:${pageHash.slice(0, 12)}`,
    issued_at: new Date(context.issued_at).toISOString(),
    source_id: finding.source_id,
    page_slug: finding.page_slug,
    page_hash: pageHash,
    finding_hash: findingHash,
    finding,
    resolver: context.resolver,
    schema: context.schema,
    disposition: authorization.disposition,
    allowed_actions: [{
      kind: authorization.action,
      source_id: finding.source_id,
      page_slug: finding.page_slug,
    }],
    required_verification: [
      'source_scope',
      'page_hash_changed',
      ...(finding.kind === 'link_reference' ? ['reference_validation' as const] : []),
      'schema_validation',
    ],
  };
  return {
    ...manifestBase,
    manifest_hash: computeSemanticRepairManifestHash(manifestBase),
  };
}

/**
 * Revalidate an immutable manifest immediately before an agent acts on it.
 *
 * This rejects tampering, cross-source authorization, deleted pages, and any
 * page edit made after diagnosis. The returned page is the exact fresh input
 * the caller may pass to the repair agent.
 */
export async function assertFreshSemanticRepairManifest(
  engine: BrainEngine,
  manifest: SemanticRepairManifest,
): Promise<Page> {
  const { manifest_hash: claimedHash, ...manifestBase } = manifest;
  if (computeSemanticRepairManifestHash(manifestBase) !== claimedHash) {
    throw new Error('semantic repair manifest: integrity hash mismatch');
  }
  if (sha256(manifest.finding) !== manifest.finding_hash) {
    throw new Error('semantic repair manifest: finding hash mismatch');
  }
  if (
    manifest.finding.source_id !== manifest.source_id
    || manifest.finding.page_slug !== manifest.page_slug
    || manifest.allowed_actions.some(action =>
      action.source_id !== manifest.source_id || action.page_slug !== manifest.page_slug)
  ) {
    throw new Error('semantic repair manifest: cross-source or cross-page action rejected');
  }
  if (
    manifest.disposition === 'proposal'
    && manifest.allowed_actions.some(action => action.kind !== 'create_proposal')
  ) {
    throw new Error('semantic repair manifest: proposal cannot authorize a page write');
  }
  const expectedAuthorization = actionForFinding(manifest.finding);
  if (
    manifest.disposition !== expectedAuthorization.disposition
    || manifest.allowed_actions.length !== 1
    || manifest.allowed_actions[0]?.kind !== expectedAuthorization.action
  ) {
    throw new Error('semantic repair manifest: finding authorization mismatch');
  }

  const page = await engine.getPage(manifest.page_slug, { sourceId: manifest.source_id });
  if (!page || page.source_id !== manifest.source_id) {
    throw new Error('semantic repair manifest: source page no longer exists');
  }
  if (semanticRepairPageHash(page) !== manifest.page_hash) {
    throw new Error('semantic repair manifest: stale page hash');
  }
  return page;
}
