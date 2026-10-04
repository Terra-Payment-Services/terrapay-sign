import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A presign token is a bearer credential. Read from the query string it is written to the load
 * balancer's access logs and the browser's history, so the file routes take it from the
 * `Authorization` header only.
 * The recipient-token routes carry their token in the path and read no query either.
 */

const FILES_ROOT = path.resolve(__dirname, '../../apps/remix/server/api/files');

const QUERY_READ = /\.req\.query\(|\.req\.queries\(|sValidator\(\s*['"]query['"]/;

const findQueryReads = (directory: string): string[] => {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...findQueryReads(fullPath));

      continue;
    }

    if (entry.isFile() && /\.(ts|tsx|js)$/.test(entry.name) && QUERY_READ.test(readFileSync(fullPath, 'utf-8'))) {
      found.push(path.relative(FILES_ROOT, fullPath));
    }
  }

  return found;
};

describe('file routes', () => {
  it('read nothing from the query string', () => {
    expect(findQueryReads(FILES_ROOT)).toEqual([]);
  });

  it('would be caught if a query-string token came back', () => {
    expect(QUERY_READ.test(`const { token } = c.req.query();`)).toBe(true);
    expect(QUERY_READ.test(`const queryToken = c.req.query('token');`)).toBe(true);
    expect(QUERY_READ.test(`sValidator('query', ZGetEnvelopeItemPdfRequestQuerySchema),`)).toBe(true);
    expect(QUERY_READ.test(`const token = getPresignBearerToken(c);`)).toBe(false);
  });
});
