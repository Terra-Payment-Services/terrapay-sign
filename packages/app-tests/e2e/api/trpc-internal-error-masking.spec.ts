import { readFileSync } from 'node:fs';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const OWN_ORIGIN = new URL(WEBAPP_BASE_URL).origin;

// The server's log, as the other log-reading specs name it; the log half of C3 is skipped without it.
const SERVER_LOG_PATH = process.env.E2E_SERVER_LOG;

const MASKED_MESSAGE = 'Something went wrong';

/**
 * Text from the original error, the ORM, the operation or a stack frame that a
 * client must never receive in a 500 response.
 */
const FORBIDDEN_STRINGS = [
  'prisma',
  'invocation',
  'SQLSTATE',
  'invalid byte sequence',
  '0x00',
  'upsert',
  'update()',
  'create()',
  'findFirst',
  'node_modules',
  'at async',
  'at Object.',
  'ConnectorError',
  'PostgresError',
  '22021',
];

const NUL = String.fromCharCode(0);

/**
 * Trigger used for C1 to C3.
 *
 * The signature route (`profile.updateProfile`, `signature` field) and the
 * name fields (`ZNameSchema`, folder and team names) now refuse a NUL
 * character with a client error before persistence, so they do not reach
 * Postgres. Two free-text fields still pass NUL through to the database and
 * fail there with `invalid byte sequence for encoding "UTF8": 0x00`
 * (SQLSTATE 22021):
 *
 * - S1: `team.update` with NUL in `data.profileBio` (bare `z.string().max()`).
 * - S2: `POST /api/v2/envelope/update` with NUL in `data.title`.
 */
const trpcUrl = (procedure: string) => `${WEBAPP_BASE_URL}/api/trpc/${procedure}`;

const updateTeamBio = async (page: Page, teamId: number, profileBio: string) =>
  await page.context().request.post(trpcUrl('team.update'), {
    headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, 'x-team-id': String(teamId) },
    data: JSON.stringify({ json: { teamId, data: { profileBio } } }),
  });

const expectNoForbiddenText = (raw: string) => {
  const lower = raw.toLowerCase();

  for (const forbidden of FORBIDDEN_STRINGS) {
    expect(lower, `response must not contain "${forbidden}"`).not.toContain(forbidden.toLowerCase());
  }
};

const readLogLines = () => {
  try {
    return readFileSync(SERVER_LOG_PATH ?? '', 'utf8').split('\n');
  } catch {
    return [];
  }
};

const failV2Envelope = async (request: APIRequestContext, apiPrefix: string) => {
  const { user, team } = await seedUser();

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'masking-test',
    expiresIn: null,
  });

  await seedBlankDocument(user, team.id);

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const found = await request.get(`${WEBAPP_BASE_URL}/api/v2/document?perPage=1`, { headers });
  const envelopeId = (await found.json()).data[0].envelopeId;

  return await request.post(`${WEBAPP_BASE_URL}${apiPrefix}/envelope/update`, {
    headers,
    data: JSON.stringify({ envelopeId, data: { title: `title${NUL}nul` } }),
  });
};

test.describe('[TRPC]: internal error masking (#168)', () => {
  test('C1: tRPC masks a database failure with the fixed message', async ({ page }) => {
    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await updateTeamBio(page, team.id, `bio${NUL}nul`);

    const raw = await res.text();

    expect(res.status(), raw).toBe(500);
    expectNoForbiddenText(raw);

    const body = JSON.parse(raw);
    const error = Array.isArray(body) ? body[0].error : body.error;

    expect(error.json.message).toBe(MASKED_MESSAGE);
    expect(error.json.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.json.data.httpStatus).toBe(500);
    expect(error.json.data.stack).toBeUndefined();
  });

  test('C2: API v2 masks a database failure', async ({ request }) => {
    const res = await failV2Envelope(request, '/api/v2');

    const raw = await res.text();

    expect(res.status(), raw).toBe(500);
    expectNoForbiddenText(raw);

    const body = JSON.parse(raw);

    expect(body.message).toBe(MASKED_MESSAGE);
  });

  test('C3a: the masked response carries a request id', async ({ page }) => {
    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await updateTeamBio(page, team.id, `bio${NUL}id`);

    const raw = await res.text();

    expect(res.status(), raw).toBe(500);

    const error = JSON.parse(raw).error;
    const requestId = error.json.data.requestId;

    expect(typeof requestId, 'error data carries requestId').toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
  });

  test('C3b: the server log ties the request id to the original message', async ({ page }) => {
    test.skip(!SERVER_LOG_PATH, 'E2E_SERVER_LOG is not set, so the server log cannot be read');

    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await updateTeamBio(page, team.id, `bio${NUL}log`);

    const raw = await res.text();

    expect(res.status(), raw).toBe(500);

    const requestId = JSON.parse(raw).error.json.data.requestId;

    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);

    // The error is logged once the response is on its way, so allow it a moment.
    let matching: string[] = [];

    await expect
      .poll(
        () => {
          matching = readLogLines().filter((line) => line.includes(requestId));

          return matching.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const original = matching.find((line) => line.includes('invalid byte sequence'));

    expect(original, 'a log line with the request id also carries the original message').toBeDefined();
  });

  test('C4: AppError, Zod and deliberate TRPCError responses are unchanged', async ({ page }) => {
    const { user } = await seedUser();

    // Unauthenticated: a deliberately thrown UNAUTHORIZED keeps its message.
    const anonymous = await page
      .context()
      .request.get(
        `${trpcUrl('profile.findUserSecurityAuditLogs')}?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`,
      );
    const anonymousBody = JSON.parse(await anonymous.text());
    const anonymousError = Array.isArray(anonymousBody) ? anonymousBody[0].error : anonymousBody.error;

    expect(anonymous.status()).toBe(401);
    expect(anonymousError.json.data.code).toBe('UNAUTHORIZED');
    expect(anonymousError.json.message).toBe('Invalid session or API token.');

    await apiSignin({ page, email: user.email });

    // Zod input validation keeps BAD_REQUEST and the field issues.
    const invalid = await page.context().request.post(trpcUrl('profile.updateProfile'), {
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN },
      data: JSON.stringify({ json: { name: 'x', signature: '' } }),
    });
    const invalidBody = JSON.parse(await invalid.text());
    const invalidError = Array.isArray(invalidBody) ? invalidBody[0].error : invalidBody.error;

    expect(invalid.status()).toBe(400);
    expect(invalidError.json.data.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(invalidError.json)).toContain('Please enter a valid name.');
    expect(invalidError.json.message).not.toBe(MASKED_MESSAGE);

    // AppError: a missing envelope keeps its code and message.
    const missing = await page
      .context()
      .request.get(
        `${trpcUrl('envelope.get')}?input=${encodeURIComponent(JSON.stringify({ json: { envelopeId: 'envelope_doesnotexist' } }))}`,
      );
    const missingBody = JSON.parse(await missing.text());
    const missingError = Array.isArray(missingBody) ? missingBody[0].error : missingBody.error;

    expect(missing.status()).toBe(404);
    expect(missingError.json.data.code).toBe('NOT_FOUND');
    expect(missingError.json.message).toBe('Team not found');
    expect(missingError.json.data.appError).toEqual({ code: 'NOT_FOUND', message: 'Team not found' });
  });

  test('C7a: API v2-beta masks the same failure with a request id', async ({ request }) => {
    const res = await failV2Envelope(request, '/api/v2-beta');

    const raw = await res.text();

    expect(res.status(), raw).toBe(500);
    expectNoForbiddenText(raw);

    const body = JSON.parse(raw);

    expect(body.message).toBe(MASKED_MESSAGE);
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(typeof body.data.requestId, raw).toBe('string');
    expect(body.data.requestId.length).toBeGreaterThan(0);
  });

  // tRPC refuses to mix a query and a mutation in one batch, so the batch holds two mutations:
  // `team.update` with NUL fails at the database, `team.update` with plain text succeeds.
  test('C7b: a tRPC batch masks the failing entry and leaves the succeeding one untouched', async ({ page }) => {
    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email });

    const res = await page.context().request.post(trpcUrl('team.update,team.update?batch=1'), {
      headers: { 'content-type': 'application/json', origin: OWN_ORIGIN, 'x-team-id': String(team.id) },
      data: JSON.stringify({
        '0': { json: { teamId: team.id, data: { profileBio: `bio${NUL}batch` } } },
        '1': { json: { teamId: team.id, data: { profileBio: 'plain bio' } } },
      }),
    });

    const raw = await res.text();

    expect(res.status(), raw).toBe(207);
    expectNoForbiddenText(raw);

    const [failed, succeeded] = JSON.parse(raw);

    expect(failed.error.json.message).toBe(MASKED_MESSAGE);
    expect(failed.error.json.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(typeof failed.error.json.data.requestId).toBe('string');
    expect(failed.error.json.data.requestId.length).toBeGreaterThan(0);

    expect(succeeded.error).toBeUndefined();
    expect(succeeded.result.data.json).toBeNull();
  });
});
