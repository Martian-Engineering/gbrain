import type { SemanticRepairManifest } from './semantic-repair-manifest.ts';

export const AUTONOMOUS_REPAIR_CONFIDENCE = 0.9;

const MAX_CANDIDATES = 10;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_OPERATIONS = 20;
const MAX_QUESTIONS = 10;
const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 4_000;

const DECISIONS = [
  'replace_reference',
  'recover_source',
  'leave_unresolved',
  'update_frontmatter',
] as const;
const OPERATIONS = new Set([
  'get_page',
  'search',
  'query',
  'resolve_slugs',
  'validate_links',
  'get_active_schema_pack',
  'put_page',
]);

export interface NightlyRepairCandidate {
  slug: string;
  title: string;
  evidence: string[];
  confidence: number;
}

export interface NightlyRepairDecisionBase {
  source_id: string;
  page_slug: string;
  manifest_hash: string;
  broken_reference: string | null;
  occurrence_context: string;
  candidates: NightlyRepairCandidate[];
  exact_edit_description: string;
  rationale: string;
  confidence: number;
  unresolved_questions: string[];
  operations: string[];
  verification: {
    page_reread: boolean;
    links_validated: boolean;
  };
}

export type NightlyRepairDecision =
  | (NightlyRepairDecisionBase & {
      status: 'applied';
      decision: 'replace_reference';
      proposed_replacement: string;
    })
  | (NightlyRepairDecisionBase & {
      status: 'applied';
      decision: 'update_frontmatter';
      proposed_replacement: null;
    })
  | (NightlyRepairDecisionBase & {
      status: 'deferred';
      decision: 'recover_source' | 'leave_unresolved';
      proposed_replacement: null;
    })
  | (NightlyRepairDecisionBase & {
      status: 'failed';
      decision: 'leave_unresolved';
      proposed_replacement: null;
    });

/** Require a plain JSON object at a decision-contract boundary. */
function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`nightly-repair-agent: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Read a bounded non-empty string from untrusted model output. */
function stringValue(
  value: unknown,
  field: string,
  maximum = MAX_SHORT_TEXT,
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(
      `nightly-repair-agent: ${field} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

/** Read a bounded list of bounded strings from untrusted model output. */
function stringList(
  value: unknown,
  field: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`nightly-repair-agent: ${field} must contain at most ${maximum} items`);
  }
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

/** Require a finite confidence score in the closed unit interval. */
function confidenceValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`nightly-repair-agent: ${field} must be between 0 and 1`);
  }
  return value;
}

/** Normalize bounded candidate evidence without trusting model object shapes. */
function candidateList(value: unknown): NightlyRepairCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) {
    throw new Error(
      `nightly-repair-agent: candidates must contain at most ${MAX_CANDIDATES} items`,
    );
  }
  return value.map((candidate, index) => {
    const object = objectValue(candidate, `candidates[${index}]`);
    return {
      slug: stringValue(object.slug, `candidates[${index}].slug`),
      title: stringValue(object.title, `candidates[${index}].title`),
      evidence: stringList(
        object.evidence,
        'candidate evidence',
        MAX_EVIDENCE_ITEMS,
      ),
      confidence: confidenceValue(
        object.confidence,
        `candidates[${index}].confidence`,
      ),
    };
  });
}

/**
 * Parse and bind one model decision to its immutable semantic-repair manifest.
 *
 * The returned discriminated union contains only combinations the server can
 * safely verify: high-confidence applied writes, no-write semantic deferrals,
 * or an explicit execution failure.
 */
export function parseNightlyRepairDecision(
  output: string,
  stopReason: string,
  manifest: SemanticRepairManifest,
): NightlyRepairDecision {
  if (stopReason !== 'end_turn') {
    throw new Error(`nightly-repair-agent: terminal stop reason ${stopReason}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = objectValue(JSON.parse(output), 'final response');
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('nightly-repair-agent: final response was not one JSON object');
    }
    throw error;
  }

  if (
    raw.source_id !== manifest.source_id
    || raw.page_slug !== manifest.page_slug
    || raw.manifest_hash !== manifest.manifest_hash
  ) {
    throw new Error('nightly-repair-agent: decision identity does not match the manifest');
  }

  const status = String(raw.status);
  const decision = String(raw.decision);
  if (!['applied', 'deferred', 'failed'].includes(status) || !DECISIONS.includes(
    decision as typeof DECISIONS[number],
  )) {
    throw new Error('nightly-repair-agent: unsupported status or decision');
  }

  const expectedReference = manifest.finding.kind === 'link_reference'
    ? manifest.finding.target
    : null;
  if (raw.broken_reference !== expectedReference) {
    throw new Error('nightly-repair-agent: broken_reference does not match the manifest');
  }

  const candidates = candidateList(raw.candidates);
  const confidence = confidenceValue(raw.confidence, 'confidence');
  const operations = stringList(raw.operations, 'operations', MAX_OPERATIONS)
    .map(operation => operation.startsWith('brain_') ? operation.slice(6) : operation);
  if (operations.some(operation => !OPERATIONS.has(operation))) {
    throw new Error('nightly-repair-agent: operations contains an unauthorized operation');
  }
  const verification = objectValue(raw.verification, 'verification');
  if (
    typeof verification.page_reread !== 'boolean'
    || typeof verification.links_validated !== 'boolean'
  ) {
    throw new Error('nightly-repair-agent: verification flags must be booleans');
  }

  const base: NightlyRepairDecisionBase = {
    source_id: manifest.source_id,
    page_slug: manifest.page_slug,
    manifest_hash: manifest.manifest_hash,
    broken_reference: expectedReference,
    occurrence_context: stringValue(
      raw.occurrence_context,
      'occurrence_context',
      MAX_LONG_TEXT,
    ),
    candidates,
    exact_edit_description: stringValue(
      raw.exact_edit_description,
      'exact_edit_description',
      MAX_LONG_TEXT,
    ),
    rationale: stringValue(raw.rationale, 'rationale', MAX_LONG_TEXT),
    confidence,
    unresolved_questions: stringList(
      raw.unresolved_questions,
      'unresolved_questions',
      MAX_QUESTIONS,
    ),
    operations,
    verification: {
      page_reread: verification.page_reread,
      links_validated: verification.links_validated,
    },
  };

  if (status === 'applied') {
    if (decision !== 'replace_reference' && decision !== 'update_frontmatter') {
      throw new Error('nightly-repair-agent: applied status requires a write decision');
    }
    if (confidence < AUTONOMOUS_REPAIR_CONFIDENCE) {
      throw new Error(
        `nightly-repair-agent: applied decision confidence is below ${AUTONOMOUS_REPAIR_CONFIDENCE}`,
      );
    }
    if (!operations.includes('put_page') || !base.verification.page_reread) {
      throw new Error('nightly-repair-agent: applied decision lacks write verification');
    }
    if (decision === 'replace_reference') {
      const replacement = stringValue(raw.proposed_replacement, 'proposed_replacement');
      const candidate = candidates.find(item => item.slug === replacement);
      if (!candidate) {
        throw new Error(
          'nightly-repair-agent: proposed_replacement must match a candidate slug',
        );
      }
      if (candidate.evidence.length === 0) {
        throw new Error('nightly-repair-agent: replacement candidate must include evidence');
      }
      if (candidate.confidence < AUTONOMOUS_REPAIR_CONFIDENCE) {
        throw new Error(
          `nightly-repair-agent: replacement candidate confidence is below ${AUTONOMOUS_REPAIR_CONFIDENCE}`,
        );
      }
      if (!base.verification.links_validated) {
        throw new Error('nightly-repair-agent: applied link replacement was not validated');
      }
      return {
        ...base,
        status,
        decision,
        proposed_replacement: replacement,
      };
    }
    if (raw.proposed_replacement !== null) {
      throw new Error(
        'nightly-repair-agent: proposed_replacement is only valid for replace_reference',
      );
    }
    return { ...base, status, decision, proposed_replacement: null };
  }

  if (status === 'deferred') {
    if (decision !== 'recover_source' && decision !== 'leave_unresolved') {
      throw new Error('nightly-repair-agent: deferred status requires a no-write decision');
    }
    if (raw.proposed_replacement !== null || operations.includes('put_page')) {
      throw new Error('nightly-repair-agent: deferred decisions must not write');
    }
    return { ...base, status, decision, proposed_replacement: null };
  }

  if (
    decision !== 'leave_unresolved'
    || raw.proposed_replacement !== null
    || operations.includes('put_page')
  ) {
    throw new Error('nightly-repair-agent: failed status must be a no-write outcome');
  }
  return {
    ...base,
    status: 'failed',
    decision: 'leave_unresolved',
    proposed_replacement: null,
  };
}
