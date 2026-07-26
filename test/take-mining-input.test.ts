import { describe, expect, test } from 'bun:test';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';

describe('buildTakeMiningInput', () => {
  test('ignores Markdown link target-only repairs', () => {
    const before = buildTakeMiningInput(
      'Work with [Project Atlas](https://old.example/atlas) continues.',
    );
    const after = buildTakeMiningInput(
      'Work with [Project Atlas](https://new.example/projects/atlas) continues.',
    );

    expect(before.prose).toBe('Work with Project Atlas continues.');
    expect(after).toEqual(before);
  });

  test('ignores aliased wikilink target-only repairs', () => {
    const before = buildTakeMiningInput('Work with [[projects/atlas|Project Atlas]] continues.');
    const after = buildTakeMiningInput('Work with [[initiatives/atlas|Project Atlas]] continues.');

    expect(before.prose).toBe('Work with Project Atlas continues.');
    expect(after).toEqual(before);
  });

  test('keeps unaliased wikilink targets semantic', () => {
    const before = buildTakeMiningInput('Work with [[Project Atlas]] continues.');
    const after = buildTakeMiningInput('Work with [[Project Borealis]] continues.');

    expect(before.prose).toBe('Work with Project Atlas continues.');
    expect(after.prose).toBe('Work with Project Borealis continues.');
    expect(after.mining_input_hash).not.toBe(before.mining_input_hash);
  });

  test('removes complete takes, facts, suppression, and future managed regions', () => {
    const input = `# Company

Meaningful introduction.

## Takes

<!--- gbrain:takes:begin -->
| # | claim |
|---|-------|
| 1 | Generated take |
<!--- gbrain:takes:end -->

## Facts
<!-- gbrain:facts:begin -->
Generated fact
<!-- gbrain:facts:end -->

## Suppressed Claims
<!--- gbrain:suppressions:begin -->
Generated suppression
<!--- gbrain:suppressions:end -->

## Backlinks
<!-- gbrain:backlinks:begin -->
Generated backlink
<!-- gbrain:backlinks:end -->

## Conclusion

Meaningful conclusion.`;

    expect(buildTakeMiningInput(input).prose).toBe(
      '# Company\n\nMeaningful introduction.\n\n## Conclusion\n\nMeaningful conclusion.',
    );
  });

  test('preserves a managed section heading when user prose remains in that section', () => {
    const input = `## Takes

<!--- gbrain:takes:begin -->
Generated take
<!--- gbrain:takes:end -->

Editorial context about the takes.`;

    expect(buildTakeMiningInput(input).prose).toBe(
      '## Takes\n\nEditorial context about the takes.',
    );
  });

  test('fails open when a managed fence is incomplete', () => {
    const input = `Meaningful introduction.

## Takes

<!--- gbrain:takes:begin -->
User-authored content after a malformed marker.`;
    const result = buildTakeMiningInput(input);

    expect(result.prose).toContain('## Takes');
    expect(result.prose).toContain('<!--- gbrain:takes:begin -->');
    expect(result.prose).toContain('User-authored content after a malformed marker.');
  });

  test('normalizes blank space introduced by removing a managed region', () => {
    const plain = `Introduction.

## Conclusion

Conclusion.`;
    const managed = `Introduction.


## Takes

<!--- gbrain:takes:begin -->
Generated take
<!--- gbrain:takes:end -->



## Conclusion

Conclusion.`;

    expect(buildTakeMiningInput(managed)).toEqual(buildTakeMiningInput(plain));
  });

  test('produces a deterministic SHA-256 hash', () => {
    const first = buildTakeMiningInput('Stable prose.');
    const second = buildTakeMiningInput('Stable prose.');

    expect(first).toEqual(second);
    expect(first.mining_input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes the hash for genuine prose edits', () => {
    const before = buildTakeMiningInput('Atlas launches in September.');
    const after = buildTakeMiningInput('Atlas launches in October.');

    expect(after.mining_input_hash).not.toBe(before.mining_input_hash);
  });
});
