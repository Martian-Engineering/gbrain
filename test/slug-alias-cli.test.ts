import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import { parseOpArgs } from '../src/cli.ts';

const repoRoot = new URL('..', import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('gbrain alias CLI', () => {
  test('top-level help lists nested add/remove commands', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alias add <old> <canonical>');
    expect(result.stdout).toContain('alias remove <old>');
  });

  test('alias help is available without opening a database', async () => {
    const result = await runCli(['alias', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gbrain alias add <old> <canonical>');
    expect(result.stdout).toContain('--soft-delete-old');
    expect(result.stdout).toContain('--remove-file');
    expect(result.stdout).toContain('--replace');
  });

  test('subcommand help renders shared-operation flags and positionals', async () => {
    const add = await runCli(['alias', 'add', '--help']);
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('Usage: gbrain alias add <alias_slug> <canonical_slug>');
    expect(add.stdout).toContain('--soft-delete-old');
    expect(add.stdout).toContain('--remove-file');
    expect(add.stdout).toContain('--replace');

    const remove = await runCli(['alias', 'remove', '--help']);
    expect(remove.exitCode).toBe(0);
    expect(remove.stdout).toContain('Usage: gbrain alias remove <alias_slug>');
  });

  test('argument parsing maps the requested CLI flags to operation params', () => {
    expect(parseOpArgs(operationsByName.add_slug_alias, [
      'old', 'canonical', '--soft-delete-old', '--remove-file', '--replace',
      '--source', 'source-a',
    ])).toEqual({
      alias_slug: 'old',
      canonical_slug: 'canonical',
      soft_delete_old: true,
      remove_file: true,
      replace: true,
      source: 'source-a',
    });
    expect(parseOpArgs(operationsByName.remove_slug_alias, ['old', '--source', 'source-a'])).toEqual({
      alias_slug: 'old',
      source: 'source-a',
    });
  });

  test('tools-json exposes authenticated MCP operations and no rename_page', async () => {
    const result = await runCli(['--tools-json']);
    expect(result.exitCode).toBe(0);
    const names = (JSON.parse(result.stdout) as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('add_slug_alias');
    expect(names).toContain('remove_slug_alias');
    expect(names).not.toContain('rename_page');
  });
});
