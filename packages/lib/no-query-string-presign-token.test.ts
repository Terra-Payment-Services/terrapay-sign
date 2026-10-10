import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A token read from the query string is written to the load balancer's access logs and the
 * browser's history. The file routes once took a presign token there; presign tokens are removed,
 * and the recipient-token routes carry their token in the path, so no file route reads the query.
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
    expect(QUERY_READ.test(`const session = await getOptionalSession(c);`)).toBe(false);
  });
});
