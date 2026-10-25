import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sValidator } from './s-validator';

/**
 * Issue #202, C2 revised and C6c: every issue's message is exactly "Invalid value", whatever the validator said. The schemas here transform or refine
 * the input, which the E2E suite cannot reach through the real routes.
 */

const submit = async (schema: z.ZodTypeAny, payload: unknown) => {
  const app = new Hono().post('/', sValidator('json', schema), (c) => c.text('ok'));

  const response = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  return { status: response.status, text, body: JSON.parse(text) };
};

const pathText = (path: unknown) =>
  (Array.isArray(path) ? path : [path])
    .map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment ? String(segment.key) : String(segment),
    )
    .join('.');

const expectInvalidValue = (
  result: Awaited<ReturnType<typeof submit>>,
  expected: { field: string }[],
  hidden: string[],
) => {
  expect(result.status).toBe(400);
  expect(result.body.success).toBe(false);
  expect(result.body).not.toHaveProperty('data');
  expect(Array.isArray(result.body.error)).toBe(true);
  expect(result.body.error.map((issue: { path: unknown }) => pathText(issue.path)).sort()).toEqual(
    expected.map((entry) => entry.field).sort(),
  );

  for (const issue of result.body.error) {
    expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
    expect(issue.message).toBe('Invalid value');
  }

  for (const value of hidden) {
    expect(result.text.toLowerCase()).not.toContain(value.toLowerCase());
  }
};

describe('sValidator answers "Invalid value" for every issue (#202 C2, C6c)', () => {
  it('answers "Invalid value" when the schema trims before an enum check', async () => {
    const schema = z.object({
      v: z
        .string()
        .trim()
        .pipe(z.enum(['alpha', 'beta'])),
    });

    const result = await submit(schema, { v: ' xy ' });

    expectInvalidValue(result, [{ field: 'v' }], [' xy ', "'xy'"]);
  });

  it('answers "Invalid value" when the schema upper-cases before an enum check', async () => {
    const schema = z.object({
      v: z
        .string()
        .toUpperCase()
        .pipe(z.enum(['ALPHA'])),
    });

    const result = await submit(schema, { v: 'xy' });

    expectInvalidValue(result, [{ field: 'v' }], ["'XY'", "'xy'"]);
  });

  it('answers "Invalid value" for a boolean refinement that quotes the value', async () => {
    const schema = z.object({ b: z.boolean().refine((x) => !x, { message: "Invalid value 'true'" }) });

    const result = await submit(schema, { b: true });

    expectInvalidValue(result, [{ field: 'b' }], ["'true'", 'true']);
  });

  it('answers "Invalid value" for a boolean refinement whose message holds the bare value', async () => {
    const schema = z.object({ b: z.boolean().refine((x) => !x, { message: 'The flag must not be true' }) });

    const result = await submit(schema, { b: true });

    expectInvalidValue(result, [{ field: 'b' }], ['true']);
  });

  it('answers "Invalid value" for a message that wraps the value in backticks', async () => {
    const schema = z.object({
      v: z.string().refine(
        () => false,
        (value) => ({ message: `bad value \`${value}\` here` }),
      ),
    });

    const result = await submit(schema, { v: 'xy' });

    expectInvalidValue(result, [{ field: 'v' }], ['`xy`']);
  });

  it('answers "Invalid value" for a message that holds the JSON-stringified value', async () => {
    const value = 'said "hello"\nback\\slash';
    const schema = z.object({
      v: z.string().refine(
        () => false,
        (input) => ({ message: `bad ${JSON.stringify(input)}` }),
      ),
    });

    const result = await submit(schema, { v: value });

    expectInvalidValue(result, [{ field: 'v' }], ['said', 'hello', 'back', 'slash', JSON.stringify(value)]);
  });

  it('answers "Invalid value" for two fields where one value is a substring of the other quoted value', async () => {
    const schema = z.object({
      a: z.string().refine(
        () => false,
        (value) => ({ message: `bad '${value}'` }),
      ),
      b: z.string().refine(
        () => false,
        (value) => ({ message: `bad '${value}'` }),
      ),
    });

    const result = await submit(schema, { a: 'xyz', b: 'xyzwvu' });

    expectInvalidValue(result, [{ field: 'a' }, { field: 'b' }], ['xyzwvu', 'xyz', 'wvu']);
  });

  it('answers "Invalid value" for a message that has no quote and no submitted value', async () => {
    const schema = z.object({ name: z.string().max(3) });

    const result = await submit(schema, { name: 'abcdefgh' });

    expectInvalidValue(result, [{ field: 'name' }], ['abcdefgh']);
  });

  it('answers "Invalid value" for an unquoted refinement message that holds the short value', async () => {
    const schema = z.object({
      v: z.string().refine(
        () => false,
        (value) => ({ message: `Rejected value: ${value}` }),
      ),
    });

    const result = await submit(schema, { v: 'xy' });

    expectInvalidValue(result, [{ field: 'v' }], ['Rejected value', 'xy']);
  });

  it('answers "Invalid value" for a message wrapped in Unicode quotes', async () => {
    const schema = z.object({
      v: z.string().refine(
        () => false,
        (value) => ({ message: `bad \u2018${value}\u2019` }),
      ),
    });

    const result = await submit(schema, { v: 'xy' });

    expectInvalidValue(result, [{ field: 'v' }], ['\u2018xy\u2019', 'xy']);
  });

  it('answers "Invalid value" when a trimming schema refinement emits the trimmed value', async () => {
    const schema = z.object({
      v: z
        .string()
        .trim()
        .refine(
          () => false,
          (value) => ({ message: `Rejected value: ${value}` }),
        ),
    });

    const result = await submit(schema, { v: '  xy  ' });

    expectInvalidValue(result, [{ field: 'v' }], ['Rejected value', 'xy']);
  });

  it('lets a valid body through', async () => {
    const schema = z.object({ name: z.string().max(3) });

    const app = new Hono().post('/', sValidator('json', schema), (c) => c.text('ok'));
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'abc' }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
