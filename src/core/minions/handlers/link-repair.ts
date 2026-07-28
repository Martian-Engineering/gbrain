import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { buildGazetteer, type Gazetteer } from '../../by-mention.ts';
import { extractNerLinks, type ExtractNerResult } from '../../extract-ner.ts';
import {
  extractTimelineFromMeetings,
  type ExtractTimelineFromMeetingsResult,
} from '../../extract-timeline-from-meetings.ts';
import { assertValidSourceId } from '../../source-id.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  type OpCheckpointKey,
} from '../../op-checkpoint.ts';
import {
  extractMentionsFromDb,
  type ExtractMentionsResult,
} from '../../../commands/extract.ts';
import {
  auditGraphBacklinks,
  type BacklinksResult,
} from '../../../commands/backlinks.ts';
import type { MinionHandler } from '../types.ts';

const STAGES = ['gazetteer', 'mentions', 'ner', 'timeline', 'backlinks'] as const;
type LinkRepairStage = typeof STAGES[number];

export interface LinkRepairInput {
  source_id: string;
  run_id: string;
  prefix?: string;
  types?: string[];
  dry_run: boolean;
}

export interface LinkRepairDependencies {
  loadCompleted(engine: BrainEngine, key: OpCheckpointKey): Promise<string[]>;
  recordCompleted(engine: BrainEngine, key: OpCheckpointKey, keys: string[]): Promise<boolean>;
  buildGazetteer(engine: BrainEngine, input: LinkRepairInput): Promise<Gazetteer>;
  extractMentions(
    engine: BrainEngine,
    input: LinkRepairInput,
    gazetteer: Gazetteer,
  ): Promise<ExtractMentionsResult>;
  extractNer(
    engine: BrainEngine,
    input: LinkRepairInput,
    gazetteer: Gazetteer,
  ): Promise<ExtractNerResult>;
  extractTimeline(
    engine: BrainEngine,
    input: LinkRepairInput,
    gazetteer: Gazetteer,
  ): Promise<ExtractTimelineFromMeetingsResult>;
  auditBacklinks(engine: BrainEngine, input: LinkRepairInput): Promise<BacklinksResult>;
}

export interface LinkRepairResult {
  source_id: string;
  run_id: string;
  dry_run: boolean;
  resumed: boolean;
  completed_stages: LinkRepairStage[];
  stages: Partial<Record<LinkRepairStage, unknown>>;
}

const FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Validate the persisted payload before the handler reads or mutates a source. */
export function parseLinkRepairInput(data: Record<string, unknown>): LinkRepairInput {
  if (typeof data.source_id !== 'string') throw new Error('link_repair: source_id is required');
  assertValidSourceId(data.source_id);
  if (typeof data.run_id !== 'string' || !RUN_ID_PATTERN.test(data.run_id)) {
    throw new Error('link_repair: run_id is required and must be a stable identifier');
  }
  if (data.prefix !== undefined && (
    typeof data.prefix !== 'string'
    || !FILTER_PATTERN.test(data.prefix)
    || data.prefix.includes('..')
  )) {
    throw new Error('link_repair: prefix must be a safe slug prefix');
  }
  if (data.types !== undefined && (
    !Array.isArray(data.types)
    || data.types.some(type => typeof type !== 'string' || !FILTER_PATTERN.test(type))
  )) {
    throw new Error('link_repair: types must be safe page-type names');
  }
  const types = data.types === undefined
    ? undefined
    : [...new Set(data.types as string[])].sort();
  return {
    source_id: data.source_id,
    run_id: data.run_id,
    ...(data.prefix === undefined ? {} : { prefix: data.prefix as string }),
    ...(types === undefined ? {} : { types }),
    dry_run: data.dry_run === true,
  };
}

/** Build a stable checkpoint identity for one exact source-scoped repair run. */
function checkpointKey(input: LinkRepairInput): OpCheckpointKey {
  const canonical = JSON.stringify({
    run_id: input.run_id,
    source_id: input.source_id,
    prefix: input.prefix ?? null,
    types: input.types ?? null,
    dry_run: input.dry_run,
  });
  return {
    op: 'link_repair',
    fingerprint: createHash('sha256').update(canonical).digest('hex').slice(0, 8),
  };
}

/** Run a page-type-partitioned extraction without scanning unselected types. */
async function forTypes<T extends { created: number; pages: number }>(
  types: string[] | undefined,
  run: (type: string | undefined) => Promise<T>,
): Promise<T> {
  if (!types || types.length === 0) return run(undefined);
  const results = [];
  for (const type of types) results.push(await run(type));
  return results.reduce<T>((total, result) => ({
    ...total,
    created: total.created + result.created,
    pages: total.pages + result.pages,
  }), { created: 0, pages: 0 } as T);
}

const DEFAULT_DEPENDENCIES: LinkRepairDependencies = {
  loadCompleted: loadOpCheckpoint,
  recordCompleted,
  async buildGazetteer(engine, input) {
    return buildGazetteer(engine, { sourceId: input.source_id });
  },
  async extractMentions(engine, input, gazetteer) {
    return forTypes(input.types, typeFilter =>
      extractMentionsFromDb(engine, {
        dryRun: input.dry_run,
        sourceIdFilter: input.source_id,
        prefixFilter: input.prefix,
        typeFilter,
        gazetteer,
      }));
  },
  async extractNer(engine, input, gazetteer) {
    const types = input.types && input.types.length > 0 ? input.types : [undefined];
    const total: ExtractNerResult = { created: 0, pages: 0, pack_unavailable: true };
    for (const typeFilter of types) {
      const result = await extractNerLinks(engine, {
        dryRun: input.dry_run,
        sourceIdFilter: input.source_id,
        prefixFilter: input.prefix,
        typeFilter,
        gazetteer,
      });
      total.created += result.created;
      total.pages += result.pages;
      total.pack_unavailable &&= result.pack_unavailable;
    }
    return total;
  },
  async extractTimeline(engine, input, gazetteer) {
    return extractTimelineFromMeetings(engine, {
      dryRun: input.dry_run,
      sourceIdFilter: input.source_id,
      prefixFilter: input.prefix,
      typeFilters: input.types,
      gazetteer,
      materializeBacklinks: false,
    });
  },
  async auditBacklinks(engine, input) {
    return auditGraphBacklinks(engine, {
      sourceId: input.source_id,
      prefix: input.prefix,
      types: input.types,
    });
  },
};

/**
 * Build the protected deterministic repair handler.
 *
 * Each successful stage is durably checkpointed after its writes finish. A
 * retry skips completed stages, while dry-run deliberately leaves no durable
 * completion state. The handler never invokes the legacy reciprocal-Markdown
 * backlink fixer.
 */
export function makeLinkRepairHandler(
  engine: BrainEngine,
  dependencies: LinkRepairDependencies = DEFAULT_DEPENDENCIES,
): MinionHandler {
  return async job => {
    const input = parseLinkRepairInput(job.data);
    const key = checkpointKey(input);
    const completed = input.dry_run
      ? new Set<string>()
      : new Set(await dependencies.loadCompleted(engine, key));
    const resumed = completed.size > 0;
    const results: Partial<Record<LinkRepairStage, unknown>> = {};
    let gazetteer: Gazetteer | undefined;

    for (const [index, stage] of STAGES.entries()) {
      if (completed.has(stage)) continue;
      await job.updateProgress({
        phase: stage,
        done: index,
        total: STAGES.length,
        source_id: input.source_id,
      });
      if (stage === 'gazetteer') {
        gazetteer = await dependencies.buildGazetteer(engine, input);
        results.gazetteer = { entries: gazetteer.size };
      } else {
        gazetteer ??= await dependencies.buildGazetteer(engine, input);
        if (stage === 'mentions') {
          results.mentions = await dependencies.extractMentions(engine, input, gazetteer);
        } else if (stage === 'ner') {
          results.ner = await dependencies.extractNer(engine, input, gazetteer);
        } else if (stage === 'timeline') {
          results.timeline = await dependencies.extractTimeline(engine, input, gazetteer);
        } else {
          results.backlinks = await dependencies.auditBacklinks(engine, input);
        }
      }
      completed.add(stage);
      if (!input.dry_run) {
        const persisted = await dependencies.recordCompleted(engine, key, [...completed]);
        if (!persisted) throw new Error(`link_repair: failed to checkpoint stage ${stage}`);
      }
    }

    await job.updateProgress({
      phase: 'completed',
      done: STAGES.length,
      total: STAGES.length,
      source_id: input.source_id,
    });
    return {
      source_id: input.source_id,
      run_id: input.run_id,
      dry_run: input.dry_run,
      resumed,
      completed_stages: STAGES.filter(stage => completed.has(stage)),
      stages: results,
    } satisfies LinkRepairResult;
  };
}
