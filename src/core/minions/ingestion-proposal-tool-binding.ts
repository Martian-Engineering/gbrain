import type { BrainEngine } from '../engine.ts';

/** Immutable proposal identity owned by the submitted agent job. */
export interface IngestionProposalToolBinding {
  artifactId: string;
  sourceId: string;
  admissionScope?: string;
}

interface ProposalToolBindingJobData {
  proposal_artifact_id?: unknown;
  source_id?: unknown;
  proposal_admission_scope?: unknown;
}

const PROPOSAL_IDENTITY_TOOL_NAMES = new Set([
  'stage_ingestion_proposal_page',
  'finalize_ingestion_proposal',
]);

const PROPOSAL_IDENTITY_FIELDS = [
  ['artifact_id', 'artifactId'],
  ['source_id', 'sourceId'],
  ['admission_scope', 'admissionScope'],
] as const;

function shortToolName(name: string): string {
  return name.replace(/^brain_/, '');
}

/** Read the available proposal binding from trusted subagent job data. */
export function proposalToolBindingFromJobData(
  data: ProposalToolBindingJobData,
): IngestionProposalToolBinding | undefined {
  if (
    typeof data.proposal_artifact_id !== 'string'
    || typeof data.source_id !== 'string'
  ) {
    return undefined;
  }
  return {
    artifactId: data.proposal_artifact_id,
    sourceId: data.source_id,
    ...(typeof data.proposal_admission_scope === 'string'
      ? { admissionScope: data.proposal_admission_scope }
      : {}),
  };
}

/** Refresh proposal identity from the durable job before one proposal tool call. */
export async function refreshProposalToolBindingForJob(
  engine: BrainEngine,
  jobId: number,
  toolName: string,
  initialBinding: IngestionProposalToolBinding | undefined,
): Promise<IngestionProposalToolBinding | undefined> {
  if (
    !initialBinding
    || !PROPOSAL_IDENTITY_TOOL_NAMES.has(shortToolName(toolName))
  ) {
    return initialBinding;
  }
  // The first staged page may freeze a scope after the tool registry was
  // constructed, so the job row—not the registry snapshot—is authoritative.
  const rows = await engine.executeRaw<ProposalToolBindingJobData>(
    `SELECT data->>'proposal_artifact_id' AS proposal_artifact_id,
            data->>'source_id' AS source_id,
            data->>'proposal_admission_scope' AS proposal_admission_scope
       FROM minion_jobs
      WHERE id = $1`,
    [jobId],
  );
  const durableBinding = rows[0]
    ? proposalToolBindingFromJobData(rows[0])
    : undefined;
  // Artifact and source can never move. A scope present at claim time is
  // equally immutable; only an initially-absent scope may appear later.
  if (
    !durableBinding
    || durableBinding.artifactId !== initialBinding.artifactId
    || durableBinding.sourceId !== initialBinding.sourceId
    || (
      initialBinding.admissionScope !== undefined
      && durableBinding.admissionScope !== initialBinding.admissionScope
    )
  ) {
    throw new Error('Durable proposal tool identity does not match the claimed agent job.');
  }
  return durableBinding;
}

/** Remove server-bound identity fields from a proposal tool's model schema. */
export function omitProposalBindingFromSchema(
  toolName: string,
  schema: Record<string, unknown>,
  binding: IngestionProposalToolBinding | undefined,
): Record<string, unknown> {
  if (!binding || !PROPOSAL_IDENTITY_TOOL_NAMES.has(shortToolName(toolName))) {
    return schema;
  }
  const properties = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  for (const [inputField, bindingField] of PROPOSAL_IDENTITY_FIELDS) {
    if (binding[bindingField] !== undefined) delete properties[inputField];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(value => (
      typeof value !== 'string'
      || !PROPOSAL_IDENTITY_FIELDS.some(([inputField, bindingField]) => (
        inputField === value && binding[bindingField] !== undefined
      ))
    ))
    : schema.required;
  return { ...schema, properties, required };
}

/** Replace model-supplied proposal identity with the immutable job binding. */
export function bindProposalToolInput(
  toolName: string,
  input: unknown,
  binding: IngestionProposalToolBinding | undefined,
): unknown {
  if (!binding || !PROPOSAL_IDENTITY_TOOL_NAMES.has(shortToolName(toolName))) {
    return input;
  }
  const params = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const bound = { ...params };
  for (const [inputField, bindingField] of PROPOSAL_IDENTITY_FIELDS) {
    if (binding[bindingField] === undefined) continue;
    bound[inputField] = binding[bindingField];
  }
  return bound;
}
