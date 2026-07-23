import { describe, expect, test } from 'bun:test';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import {
  parseSuppressedClaimsFence,
  preserveSuppressedClaimsFence,
  renderSuppressedClaimsFence,
  stripSuppressedClaimsFence,
  upsertSuppressedClaim,
} from '../src/core/suppressed-claims-fence.ts';

describe('suppressed claims fence', () => {
  test('round-trips escaped cells and inactive audit rows', () => {
    const fence = renderSuppressedClaimsFence([
      {
        rowNum: 1,
        claimText: 'Acme uses Windows C:\\Temp | always\nacross teams',
        reason: 'User refuted | source was stale\r\nand incomplete',
        suppressedAt: '2026-07-23',
        provenance: 'mcp:suppress_claim',
        active: true,
      },
      {
        rowNum: 2,
        claimText: 'An older correction',
        reason: '',
        suppressedAt: '2026-07-22',
        provenance: 'cli:suppress_claim',
        active: false,
      },
    ]);

    const parsed = parseSuppressedClaimsFence(fence);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.claims).toEqual([
      {
        rowNum: 1,
        claimText: 'Acme uses Windows C:\\Temp | always\nacross teams',
        reason: 'User refuted | source was stale\r\nand incomplete',
        suppressedAt: '2026-07-23',
        provenance: 'mcp:suppress_claim',
        active: true,
      },
      {
        rowNum: 2,
        claimText: 'An older correction',
        reason: '',
        suppressedAt: '2026-07-22',
        provenance: 'cli:suppress_claim',
        active: false,
      },
    ]);
  });

  test('appends a Suppressed Claims section with stable row numbers', () => {
    const first = upsertSuppressedClaim('# Page\n', {
      claimText: 'The launch is Friday.',
      reason: 'Moved to Monday',
      suppressedAt: '2026-07-23',
      provenance: 'cli:suppress_claim',
    });
    const second = upsertSuppressedClaim(first.body, {
      claimText: 'Revenue is $5M.',
      reason: '',
      suppressedAt: '2026-07-23',
      provenance: 'cli:suppress_claim',
    });

    expect(first.rowNum).toBe(1);
    expect(second.rowNum).toBe(2);
    expect(second.body).toContain('## Suppressed Claims');
    expect(parseSuppressedClaimsFence(second.body).claims.map((c) => c.rowNum)).toEqual([1, 2]);
  });

  test('preserves the canonical existing fence across put_page rewrites', () => {
    const existing = upsertSuppressedClaim('# Existing\n', {
      claimText: 'The launch is Friday.',
      reason: 'Moved',
      suppressedAt: '2026-07-23',
      provenance: 'mcp:suppress_claim',
    }).body;
    const candidate = '---\ntitle: Updated\n---\n\n# Updated prose\n\n<!-- timeline -->\n\n- 2026-07-23: edited';

    const merged = preserveSuppressedClaimsFence(existing, candidate);
    expect(merged).toContain('The launch is Friday.');
    expect(merged.indexOf('## Suppressed Claims')).toBeLessThan(merged.indexOf('<!-- timeline -->'));
  });

  test('does not accept a caller-injected fence when no canonical fence exists', () => {
    const injected = upsertSuppressedClaim('# Candidate\n', {
      claimText: 'Spoofed suppression',
      reason: 'spoofed',
      suppressedAt: '1999-01-01',
      provenance: 'trusted-admin',
    }).body;

    const merged = preserveSuppressedClaimsFence('# Existing without fence', injected);
    expect(parseSuppressedClaimsFence(merged).claims).toEqual([]);
    expect(merged).not.toContain('## Suppressed Claims');
  });

  test('strip removes the heading and fence from retrieval text', () => {
    const body = upsertSuppressedClaim('# Page\n\nSearchable prose.', {
      claimText: 'Do not index this false claim.',
      reason: '',
      suppressedAt: '2026-07-23',
      provenance: 'cli:suppress_claim',
    }).body;

    const stripped = stripSuppressedClaimsFence(body);
    expect(stripped).toContain('Searchable prose.');
    expect(stripped).not.toContain('Do not index this false claim.');
    expect(stripped).not.toContain('## Suppressed Claims');
  });

  test('the markdown chunker never indexes suppressed claim metadata', () => {
    const body = upsertSuppressedClaim('# Page\n\nSearchable corrected prose.', {
      claimText: 'Do not index this false claim.',
      reason: 'User refuted it',
      suppressedAt: '2026-07-23',
      provenance: 'cli:suppress_claim',
    }).body;

    const indexed = chunkText(body).map((chunk) => chunk.text).join('\n');
    expect(indexed).toContain('Searchable corrected prose.');
    expect(indexed).not.toContain('Do not index this false claim.');
    expect(indexed).not.toContain('User refuted it');
  });
});
