import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Documenso Enterprise Edition directory is under a commercial licence this deployment does
 * not hold, so it was deleted. This fails the pipeline if the directory comes back, for example
 * through an upstream merge, or if anything under apps/ or packages/ refers to the package again.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');

// Built from parts so this file does not match its own search.
const PACKAGE_NAME = ['@documenso', 'ee'].join('/');

// The name followed by a quote or a slash, so `@documenso/email` does not match.
const REFERENCE = new RegExp(`${PACKAGE_NAME.replace('/', '\\/')}['"/]`);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'dist', 'coverage', '.turbo', '.react-router', '.next']);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json)$/;

const findReferences = (directory: string): string[] => {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...findReferences(fullPath));
      }

      continue;
    }

    if (entry.isFile() && SOURCE_FILE.test(entry.name) && REFERENCE.test(readFileSync(fullPath, 'utf-8'))) {
      found.push(path.relative(REPO_ROOT, fullPath));
    }
  }

  return found;
};

// Walking apps/ and packages/ takes about a second with a warm file cache and several seconds with a
// cold one, which is longer than the default five-second test timeout on a busy runner.
describe('enterprise edition code', () => {
  it('is not present in the repository', () => {
    expect(existsSync(path.join(REPO_ROOT, 'packages', 'ee'))).toBe(false);
  });

  it('is not referenced from apps or packages', () => {
    const references = ['apps', 'packages'].flatMap((root) => findReferences(path.join(REPO_ROOT, root)));

    expect(references).toEqual([]);
  }, 60_000);
});
