/**
 * Regression coverage for the compiled tree-sitter WASM smoke check.
 *
 * The real script is copied into a hermetic fixture repository. A stub Bun
 * compiler installs a fake executable whose valid markers occur before a
 * payload larger than a shell pipe buffer. This exercises the script's output
 * matching without paying the cost of a real cross-platform compilation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts/check-wasm-embedded.sh");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Creates a fixture repo whose compiled smoke binary emits early valid markers. */
function makeFixtureRepo(): { root: string; binDir: string; compiledBinary: string; treeSitterEntry: string } {
  const root = mkdtempSync(join(tmpdir(), "wasm-check-pipefail-"));
  tempDirs.push(root);

  const scriptsDir = join(root, "scripts");
  const binDir = join(root, "bin");
  const dependencyDir = join(root, "deps", "web-tree-sitter");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dependencyDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  copyFileSync(SCRIPT, join(scriptsDir, "check-wasm-embedded.sh"));
  writeFileSync(join(scriptsDir, "chunker-smoketest.ts"), "// fixture\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "bunfig.toml"), "\n");

  const compiledBinary = join(root, "fake-compiled-binary.sh");
  writeFileSync(
    compiledBinary,
    `#!/usr/bin/env bash
printf '%s\\n' '{' '  "has_symbol_names": true,' '  "has_typescript_header": true,' '  "symbol_names": ["calculateScore"],' '  "padding": "'
head -c 524288 /dev/zero | tr '\\0' x
printf '%s\\n' '"}'
`,
  );
  chmodSync(compiledBinary, 0o755);

  const fakeBun = join(binDir, "bun");
  writeFileSync(
    fakeBun,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-e" ]]; then
  printf '%s\\n' "$FAKE_TREE_SITTER_ENTRY"
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  out=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--outfile" ]]; then
      out="$2"
      break
    fi
    shift
  done
  cp "$FAKE_COMPILED_BINARY" "$out"
  chmod +x "$out"
  exit 0
fi
exit 2
`,
  );
  chmodSync(fakeBun, 0o755);

  return {
    root,
    binDir,
    compiledBinary,
    treeSitterEntry: join(dependencyDir, "index.js"),
  };
}

describe("check-wasm-embedded.sh", () => {
  it("accepts valid markers near the start of output larger than a pipe buffer", () => {
    const fixture = makeFixtureRepo();
    const result = spawnSync("bash", [join(fixture.root, "scripts/check-wasm-embedded.sh")], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        FAKE_COMPILED_BINARY: fixture.compiledBinary,
        FAKE_TREE_SITTER_ENTRY: fixture.treeSitterEntry,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("compiled binary produced real semantic chunks");
    expect(result.stderr).toBe("");
  });
});
