import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TerraPay Sign signs in through Microsoft Entra only, so upstream's Google and generic OIDC
 * clients were deleted. This fails the pipeline if either comes back, for example through an
 * upstream merge, as client options or as an authorize or callback route.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');

// Built from parts so this file does not match its own search.
const PROVIDERS = ['goo' + 'gle', 'oi' + 'dc'];
const OPTION_NAMES = ['Goo' + 'gleAuthOptions', 'Oi' + 'dcAuthOptions'];

const REFERENCE = new RegExp(
  [
    `\\b(${OPTION_NAMES.join('|')})\\b`,
    `\\/(callback|authorize)\\/(${PROVIDERS.join('|')})\\b`,
    `\\.(get|post)\\(\\s*['"\`]\\/(${PROVIDERS.join('|')})['"\`]`,
  ].join('|'),
);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'dist', 'coverage', '.turbo', '.react-router', '.next']);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json)$/;

type WalkResult = { scanned: string[]; found: string[] };

const walk = (directory: string, result: WalkResult): WalkResult => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        walk(fullPath, result);
      }

      continue;
    }

    if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) {
      continue;
    }

    const relativePath = path.relative(REPO_ROOT, fullPath);

    result.scanned.push(relativePath);

    if (REFERENCE.test(readFileSync(fullPath, 'utf-8'))) {
      result.found.push(relativePath);
    }
  }

  return result;
};

// Walking apps/ and packages/ takes several seconds with a cold file cache, which is longer than
// the default five-second test timeout on a busy runner.
describe('OAuth providers other than Microsoft', () => {
  it('are not defined or routed anywhere in apps or packages', () => {
    const result: WalkResult = { scanned: [], found: [] };

    for (const root of ['apps', 'packages']) {
      walk(path.join(REPO_ROOT, root), result);
    }

    // Proves the walk reached the files a regression would touch, so an empty result means something.
    expect(result.scanned).toEqual(
      expect.arrayContaining([
        path.join('packages', 'auth', 'server', 'config.ts'),
        path.join('packages', 'auth', 'server', 'routes', 'callback.ts'),
        path.join('apps', 'remix', 'app', 'components', 'forms', 'signin.tsx'),
      ]),
    );

    expect(result.found).toEqual([]);
  }, 60_000);

  it('recognises each form a reintroduced provider would take', () => {
    const samples = [
      `export const ${OPTION_NAMES[0]}: OAuthClientOptions = {`,
      `import { ${OPTION_NAMES[1]} } from '../config';`,
      `redirectUrl: \`\${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/callback/${PROVIDERS[0]}\`,`,
      `.post('/authorize/${PROVIDERS[1]}', sValidator('json', schema), handler)`,
      `.get('/${PROVIDERS[1]}', async (c) => handleOAuthCallbackUrl({ c, clientOptions }))`,
    ];

    for (const sample of samples) {
      expect(REFERENCE.test(sample), sample).toBe(true);
    }

    expect(REFERENCE.test(`.get('/microsoft', async (c) => handler(c))`)).toBe(false);
    expect(REFERENCE.test(`extractEmailFromClaims(claims, '${PROVIDERS[1]}')`)).toBe(false);
  });
});
