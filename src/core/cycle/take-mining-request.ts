import type { ChatMessage } from '../ai/gateway.ts';

/** Complete result bound for one independently retryable page extraction. */
export const TAKE_MINING_MAX_PROPOSALS_PER_PAGE = 10;

/** Output ceiling passed to the production gateway request. */
export const TAKE_MINING_MAX_OUTPUT_TOKENS = 2048;

/** Identity of the prompt and bounded extraction contract. */
export const PROPOSE_TAKES_PROMPT_VERSION =
  'v0.36.2.0-holder-asserter';

/**
 * Bump the caller's prompt version whenever this template or its output
 * contract changes so successful scans remain semantically idempotent.
 */
export const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page

For each gradeable claim, output a JSON object with:
- claim_text   (string, <=200 chars, paraphrase or near-verbatim from prose)
- kind         ('prediction' | 'judgment' | 'bet')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain')
               The holder is who HOLDS the belief — the person who said or
               clearly implied it — NOT who the claim is about. When the page's
               author or a named speaker asserts the claim, holder is that
               person's people/<slug>. Use 'world' for consensus facts,
               'companies/<slug>' for institutional assertions with no
               individual claimant, and 'brain' ONLY for your own analytic
               inference or when the asserter is genuinely ambiguous.
- weight       (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')

Return at most ${TAKE_MINING_MAX_PROPOSALS_PER_PAGE} claims, ordered strongest
and most gradeable first. This is the complete result for this page: omit weaker
claims beyond that bound rather than continuing them in a later response.

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

EXISTING FENCE ROWS (already captured — do NOT propose duplicates):
{EXISTING_TAKES_JSON}

PAGE PROSE:
{PAGE_BODY}
`;

/** Exact semantic inputs supplied to the take-mining extractor. */
export interface TakeMiningExtractorInput {
  pagePath: string;
  pageBody: string;
  existingTakes: Array<{
    claim: string;
    kind: string;
    holder: string;
    weight: number;
  }>;
  modelHint?: string;
}

/** Gateway request plus the conservative input bound used for pricing. */
export interface RenderedTakeMiningRequest {
  messages: ChatMessage[];
  maxTokens: number;
  estimatedInputTokens: number;
}

/**
 * Parse active fence rows into the exact deduplication context rendered for
 * the extractor. Malformed fences remain the fence parser's responsibility.
 */
export function extractExistingTakesForDedup(pageBody: string): Array<{
  claim: string;
  kind: string;
  holder: string;
  weight: number;
}> {
  const fence = pageBody.match(
    /<!---?\s*gbrain:takes:begin\s*-->([\s\S]*?)<!---?\s*gbrain:takes:end\s*-->/,
  );
  if (!fence) return [];
  const rows: Array<{
    claim: string;
    kind: string;
    holder: string;
    weight: number;
  }> = [];
  for (const line of (fence[1] ?? '').split('\n')) {
    const cells = line
      .split('|')
      .map(cell => cell.trim())
      .filter((_, index, all) => index > 0 && index < all.length - 1);
    const claim = cells[1] ?? '';
    if (
      cells.length < 4
      || cells[0] === '#'
      || cells[0]?.match(/^-+$/)
      || !claim
      || claim.startsWith('~~')
    ) {
      continue;
    }
    const parsedWeight = Number.parseFloat(cells[4] ?? '0.5');
    rows.push({
      claim: claim.replace(/^~~|~~$/g, ''),
      kind: cells[2] ?? 'take',
      holder: cells[3] ?? 'brain',
      weight: Number.isFinite(parsedWeight) ? parsedWeight : 0.5,
    });
  }
  return rows;
}

/**
 * Render the one production extractor request used by both gateway submission
 * and spend reservation.
 *
 * UTF-8 bytes are a conservative token upper bound and include the serialized
 * message envelope as well as the complete prompt. This deliberately
 * overestimates relative to provider tokenization instead of guessing a
 * language-dependent characters-per-token ratio.
 */
export function renderTakeMiningRequest(
  input: TakeMiningExtractorInput,
): RenderedTakeMiningRequest {
  const prompt = EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', JSON.stringify(input.existingTakes, null, 2))
    .replace('{PAGE_BODY}', input.pageBody);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  return {
    messages,
    maxTokens: TAKE_MINING_MAX_OUTPUT_TOKENS,
    estimatedInputTokens: Buffer.byteLength(JSON.stringify(messages), 'utf8'),
  };
}
