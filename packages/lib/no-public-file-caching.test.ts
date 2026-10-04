import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Upstream marked a completed document `public` for a year, so a CDN or proxy in front of the app
 * could hand a contract to the next request for the same URL without the access check running.
 * The API routes serve documents and nothing else, so none of them may mark a response public.
 * Static assets are cached publicly in server/main.js, which this does not walk.
 */

const API_ROOT = path.resolve(__dirname, '../../apps/remix/server/api');

const PUBLIC_CACHE = /Cache-Control['"],\s*['"`][^'"`]*\bpublic\b/;

const findPublicCaching = (directory: string): string[] => {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...findPublicCaching(fullPath));

      continue;
    }

    if (entry.isFile() && /\.(ts|tsx|js)$/.test(entry.name) && PUBLIC_CACHE.test(readFileSync(fullPath, 'utf-8'))) {
      found.push(path.relative(API_ROOT, fullPath));
    }
  }

  return found;
};

describe('document responses', () => {
  it('are never marked cacheable by a shared cache', () => {
    expect(findPublicCaching(API_ROOT)).toEqual([]);
  });

  it('would be caught if the upstream header came back', () => {
    expect(PUBLIC_CACHE.test(`c.header('Cache-Control', 'public, max-age=31536000');`)).toBe(true);
    expect(PUBLIC_CACHE.test(`c.header('Cache-Control', 'private, no-store');`)).toBe(false);
  });
});
