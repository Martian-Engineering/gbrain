/** Durable storage and expiry lifecycle for finalized ingestion proposals. */

import type { BrainEngine } from '../engine.ts';

/** Fixed lifetime for finalized proposal authority and its private baselines. */
export const PROPOSAL_AUTHORITY_RETENTION_DAYS = 90;

/** Exact finalized page data retained independently of the origin minion job. */
export interface IngestionProposalAuthorityPage {
  sequence: number;
  total_pages: number;
  owner_client_id: string;
  source_id: string;
  artifact_id: string;
  admission_scope: string;
  page: unknown;
  page_digest: string;
  baseline_title: string | null;
  baseline_markdown: string | null;
  baseline_content_hash: string | null;
}

/** Exact values promoted at successful proposal finalization. */
export interface IngestionProposalAuthorityPromotion {
  proposalId: number;
  ownerClientId: string;
  sourceId: string;
  artifactId: string;
  admissionScope: string;
  capturePageSlug: string;
  totalPages: number;
  pageDigestsJson: string;
  planJson: string;
  proposalDigest: string;
  manifestJson: string;
}

/** Return whether one stable proposal ID has already been finalized. */
export async function finalizedIngestionProposalExists(
  engine: BrainEngine,
  proposalId: number,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ proposal_id: number }>(
    `SELECT proposal_id
       FROM ingestion_proposal_authorities
      WHERE proposal_id = $1`,
    [proposalId],
  );
  return rows.length > 0;
}

/** Atomically copy finalized job evidence into the independent authority ledger. */
export async function promoteIngestionProposalAuthority<TManifest>(
  engine: BrainEngine,
  input: IngestionProposalAuthorityPromotion,
): Promise<{
  proposalDigest: string;
  manifest: TManifest;
  pages: IngestionProposalAuthorityPage[];
} | null> {
  await engine.executeRaw(
    `INSERT INTO ingestion_proposal_authorities
       (proposal_id, origin_job_id, owner_client_id, source_id, artifact_id,
        admission_scope, capture_page_slug, total_pages, page_digests, plan,
        proposal_digest, manifest, expires_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8::text::jsonb,
             $9::text::jsonb, $10, $11::text::jsonb,
             now() + interval '${PROPOSAL_AUTHORITY_RETENTION_DAYS} days')
     ON CONFLICT (proposal_id) DO NOTHING`,
    [
      input.proposalId, input.ownerClientId, input.sourceId, input.artifactId,
      input.admissionScope, input.capturePageSlug, input.totalPages,
      input.pageDigestsJson, input.planJson, input.proposalDigest, input.manifestJson,
    ],
  );
  await engine.executeRaw(
    `INSERT INTO ingestion_proposal_authority_pages
       (proposal_id, sequence, total_pages, page, page_digest,
        baseline_title, baseline_markdown, baseline_content_hash,
        applied_previous_content_hash, applied_content_hash, applied_rebased,
        applied_at, created_at)
     SELECT job_id, sequence, total_pages, page, page_digest,
            baseline_title, baseline_markdown, baseline_content_hash,
            applied_previous_content_hash, applied_content_hash,
            applied_rebased, applied_at, created_at
       FROM agent_job_proposal_fragments
      WHERE job_id = $1
     ON CONFLICT (proposal_id, sequence) DO NOTHING`,
    [input.proposalId],
  );
  const stored = await engine.executeRaw<{
    proposal_digest: string;
    manifest: TManifest;
  }>(
    `SELECT proposal_digest, manifest
       FROM ingestion_proposal_authorities
      WHERE proposal_id = $1`,
    [input.proposalId],
  );
  if (!stored[0]) return null;
  return {
    proposalDigest: stored[0].proposal_digest,
    manifest: stored[0].manifest,
    pages: await readIngestionProposalAuthorityPages(engine, input.proposalId),
  };
}

/** Read an unparsed authority row under its exact owner and digest fence. */
export async function readOwnedIngestionProposalAuthority<TPlan, TPageDigests>(
  engine: BrainEngine,
  proposalId: number,
  ownerClientId: string,
  proposalDigest: string,
): Promise<{
  proposalDigest: string;
  pageDigests: TPageDigests;
  plan: TPlan;
  expired: boolean;
} | null> {
  const rows = await engine.executeRaw<{
    proposal_digest: string;
    page_digests: TPageDigests;
    plan: TPlan;
    expired: boolean;
  }>(
    `SELECT proposal_digest, page_digests, plan,
            expires_at <= now() AS expired
       FROM ingestion_proposal_authorities
      WHERE proposal_id = $1 AND owner_client_id = $2 AND proposal_digest = $3`,
    [proposalId, ownerClientId, proposalDigest],
  );
  if (!rows[0]) return null;
  return {
    proposalDigest: rows[0].proposal_digest,
    pageDigests: rows[0].page_digests,
    plan: rows[0].plan,
    expired: rows[0].expired,
  };
}

/** Read exact finalized pages without consulting disposable job evidence. */
export async function readIngestionProposalAuthorityPages(
  engine: BrainEngine,
  proposalId: number,
): Promise<IngestionProposalAuthorityPage[]> {
  return engine.executeRaw<IngestionProposalAuthorityPage>(
    `SELECT f.sequence, f.total_pages, p.owner_client_id, p.source_id,
            p.artifact_id, p.admission_scope, f.page, f.page_digest,
            f.baseline_title, f.baseline_markdown, f.baseline_content_hash
       FROM ingestion_proposal_authority_pages f
       JOIN ingestion_proposal_authorities p ON p.proposal_id = f.proposal_id
      WHERE f.proposal_id = $1
      ORDER BY f.sequence`,
    [proposalId],
  );
}

/** Delete expired authority plus durable and job-owned private evidence. */
export async function cleanupExpiredIngestionProposalAuthorities(
  engine: BrainEngine,
  now = new Date(),
): Promise<number> {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('Proposal authority cleanup time must be a valid Date.');
  }
  const rows = await engine.executeRaw<{ count: string }>(
    `WITH expired AS (
       DELETE FROM ingestion_proposal_authorities
        WHERE expires_at <= $1
        RETURNING proposal_id
     ), discarded_job_proposals AS (
       DELETE FROM agent_job_proposals p
        USING expired e
        WHERE p.job_id = e.proposal_id
     ), discarded_job_fragments AS (
       DELETE FROM agent_job_proposal_fragments f
        USING expired e
        WHERE f.job_id = e.proposal_id
     )
     SELECT count(*)::text AS count FROM expired`,
    [now.toISOString()],
  );
  return Number(rows[0]?.count ?? 0);
}
