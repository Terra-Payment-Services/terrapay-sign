import http from 'node:http';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';

/**
 * Issue #227: a bodied request with a content type the OpenAPI handler does not accept used to
 * reject an un-awaited promise and kill the server process. Criteria C1 to C5 from the spec.
 * C4 is covered only for the cases reachable from outside (malformed JSON). C6 (PDF browser close
 * failure) cannot be triggered end to end from an HTTP client, so it has no test here.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const V2_BASES = [`${WEBAPP_BASE_URL}/api/v2`, `${WEBAPP_BASE_URL}/api/v2-beta`];

const POST_ROUTES = [
  '/envelope/attachment/create',
  '/envelope/create',
  '/envelope/delete',
  '/envelope/update',
  '/envelope/distribute',
];

// Content types from C1 that Playwright can send as a normal header value.
const UNSUPPORTED_CONTENT_TYPES = [
  'text/plain',
  'application/xml',
  'application/octet-stream',
  'text/plain; charset=utf-8',
  'application/x-unknown',
  'garbage',
  '///',
  'application/',
  'application/json; charset',
];

const ATTACHMENT_ROUTE = '/envelope/attachment/create';

type RawResponse = { status: number; body: string };

/**
 * Send a POST with full control over the headers, including no Content-Type at all.
 * Playwright's request fixture adds a default content type when a body is present.
 */
const rawPost = async (url: string, headers: Record<string, string>, body: string): Promise<RawResponse> =>
  await new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(body).toString(), ...headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );

    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout after 10s for ${url}`)));
    req.write(body);
    req.end();
  });

/** Send a GET with full control over the headers and no body. */
const rawGet = async (url: string, headers: Record<string, string>): Promise<RawResponse> =>
  await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout after 10s for ${url}`)));
    req.end();
  });

/** Assert /api/health answers 200, retrying for at most 3 s so a dead server fails clearly. */
const expectServerAlive = async (request: APIRequestContext, context: string) => {
  const deadline = Date.now() + 3000;
  let lastError = 'no attempt made';
  let lastStatus = 0;

  while (Date.now() < deadline) {
    try {
      const res = await request.get(`${WEBAPP_BASE_URL}/api/health`, { timeout: 2000 });

      lastStatus = res.status();

      if (lastStatus === 200) {
        return;
      }

      lastError = `status ${lastStatus}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Server is not answering /api/health after ${context}: ${lastError}`);
};

/** A normal authenticated v2 request: list envelopes. */
const expectNormalAuthedRequestWorks = async (request: APIRequestContext, token: string) => {
  const res = await request.get(`${WEBAPP_BASE_URL}/api/v2-beta/envelope`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(res.status(), 'authenticated GET /envelope after crafted requests').toBe(200);
};

const expectClientError = (status: number, context: string) => {
  expect(status, `${context}: expected 415 or another 4xx`).toBeGreaterThanOrEqual(400);
  expect(status, `${context}: expected 415 or another 4xx`).toBeLessThan(500);
};

const expectNoInternalDetail = (body: string, context: string) => {
  expect(body, `${context}: body must not leak a stack trace`).not.toMatch(/\n\s+at\s|node_modules|\.ts:\d+/);
};

test.describe('API v2 unsupported content type does not crash the server (#227)', () => {
  let token: string;

  test.beforeAll(async () => {
    const { user, team } = await seedUser();

    ({ token } = await createApiToken({
      userId: user.id,
      teamId: team.id,
      tokenName: 'unsupported-content-type',
      expiresIn: null,
    }));
  });

  // Placed first so the crash is isolated from every other test on the unfixed code.
  test('C1 isolated: one unauthenticated text/plain POST leaves the server up', async ({ request }) => {
    await expectServerAlive(request, 'baseline');

    const res = await request.post(`${WEBAPP_BASE_URL}/api/v2/envelope/attachment/create`, {
      headers: { 'Content-Type': 'text/plain' },
      data: 'hello',
    });

    expectClientError(res.status(), 'text/plain unauthenticated');
    await expectServerAlive(request, 'one text/plain POST');
  });

  for (const base of V2_BASES) {
    for (const route of POST_ROUTES) {
      test(`C1/C2 unauthenticated text/plain to ${base.split('/api')[1]}${route}`, async ({ request }) => {
        const res = await request.post(`${base}${route}`, {
          headers: { 'Content-Type': 'text/plain' },
          data: 'not json',
        });

        expectClientError(res.status(), `${base}${route}`);
        expectNoInternalDetail(await res.text(), `${base}${route}`);
        await expectServerAlive(request, `${base}${route} text/plain`);
      });

      test(`C1/C2 authenticated text/plain to ${base.split('/api')[1]}${route}`, async ({ request }) => {
        const res = await request.post(`${base}${route}`, {
          headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
          data: 'not json',
        });

        expectClientError(res.status(), `${base}${route} authenticated`);
        expectNoInternalDetail(await res.text(), `${base}${route} authenticated`);
        await expectServerAlive(request, `${base}${route} authenticated text/plain`);
      });
    }
  }

  for (const contentType of UNSUPPORTED_CONTENT_TYPES) {
    for (const authenticated of [false, true]) {
      test(`C1/C2 content type "${contentType}" ${authenticated ? 'authenticated' : 'unauthenticated'}`, async ({
        request,
      }) => {
        const headers: Record<string, string> = { 'Content-Type': contentType };

        if (authenticated) {
          headers.Authorization = `Bearer ${token}`;
        }

        let status: number;
        let text: string;

        try {
          const res = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
            headers,
            data: '<a>b</a>',
          });

          status = res.status();
          text = await res.text();
        } catch {
          // Playwright refused to send a header value it considers invalid; fall back to raw HTTP.
          const raw = await rawPost(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, headers, '<a>b</a>');

          status = raw.status;
          text = raw.body;
        }

        expectClientError(status, `content type "${contentType}"`);
        expectNoInternalDetail(text, `content type "${contentType}"`);
        await expectServerAlive(request, `content type "${contentType}"`);
      });
    }
  }

  for (const authenticated of [false, true]) {
    for (const base of V2_BASES) {
      test(`C1/C2 missing Content-Type header ${authenticated ? 'authenticated' : 'unauthenticated'} on ${base.split('/api')[1]}`, async ({
        request,
      }) => {
        const headers: Record<string, string> = authenticated ? { Authorization: `Bearer ${token}` } : {};

        const res = await rawPost(`${base}${ATTACHMENT_ROUTE}`, headers, 'some body');

        expectClientError(res.status, 'missing content type');
        expectNoInternalDetail(res.body, 'missing content type');
        await expectServerAlive(request, 'missing content type');
      });
    }
  }

  test('C1 the unsupported media type answer is 415 with a generic body', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
      data: 'hello',
    });

    expect(res.status()).toBe(415);

    const json = await res.json();

    expect(json.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(typeof json.message).toBe('string');
    expectNoInternalDetail(JSON.stringify(json), '415 body');
    await expectServerAlive(request, '415 check');
  });

  test('C3 twenty sequential unsupported requests leave the server up', async ({ request }) => {
    for (let i = 0; i < 20; i += 1) {
      const res = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
        headers: {
          'Content-Type': i % 2 === 0 ? 'text/plain' : 'application/xml',
          ...(i % 3 === 0 ? { Authorization: `Bearer ${token}` } : {}),
        },
        data: `request ${i}`,
      });

      expectClientError(res.status(), `sequential request ${i}`);
      await expectServerAlive(request, `sequential request ${i}`);
    }
  });

  test('C3 ten concurrent unsupported requests leave the server up', async ({ request }) => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, async (_, i) => {
        const res = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta${ATTACHMENT_ROUTE}`, {
          headers: {
            'Content-Type': i % 2 === 0 ? 'text/plain' : 'application/octet-stream',
            ...(i % 2 === 0 ? { Authorization: `Bearer ${token}` } : {}),
          },
          data: `concurrent ${i}`,
        });

        return res.status();
      }),
    );

    for (const [i, result] of results.entries()) {
      expect(result.status, `concurrent request ${i} must get a response`).toBe('fulfilled');

      if (result.status === 'fulfilled') {
        expectClientError(result.value, `concurrent request ${i}`);
      }
    }

    await expectServerAlive(request, 'ten concurrent requests');
  });

  test('C4 malformed JSON answers a client error or a generic 500 and leaves the server up', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: '{"broken": ',
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expectNoInternalDetail(await res.text(), 'malformed JSON');
    await expectServerAlive(request, 'malformed JSON');
  });

  test('C5 JSON control: unauthenticated is 401, authenticated invalid body is 400', async ({ request }) => {
    const unauth = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });

    expect(unauth.status()).toBe(401);

    const invalid = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { not: 'valid' },
    });

    expect(invalid.status()).toBe(400);
    await expectServerAlive(request, 'JSON controls');
  });

  test('C5 JSON control: authenticated valid envelope create succeeds', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/create`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        payload: JSON.stringify({ type: 'DOCUMENT', title: 'Content type control' }),
        files: {
          name: 'control.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n'),
        },
      },
    });

    // The body is not a real PDF, so creation may be refused, but never as a server error.
    expect(res.status()).toBeLessThan(500);
    await expectServerAlive(request, 'multipart control');
  });

  test('C5 urlencoded control: handled as before, no server error, server up', async ({ request }) => {
    const unauth = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'a=1&b=2',
    });

    expect(unauth.status()).toBeLessThan(500);

    const authed = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      data: 'a=1&b=2',
    });

    expect(authed.status()).toBeLessThan(500);
    await expectServerAlive(request, 'urlencoded control');
  });

  test('C5 multipart control: handled as before, no server error, server up', async ({ request }) => {
    const unauth = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      multipart: { a: '1' },
    });

    expect(unauth.status()).toBe(401);

    const authed = await request.post(`${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { a: '1' },
    });

    expect(authed.status()).toBeLessThan(500);
    await expectServerAlive(request, 'multipart control');
  });

  // A1: content types that name JSON, multipart or urlencoded with different case, whitespace or parameters.
  const JSON_VARIANTS = [
    'Application/JSON',
    'APPLICATION/JSON; charset=utf-8',
    'application/JSON',
    ' application/json',
  ];
  const OTHER_VARIANTS = ['Multipart/Form-Data', 'Application/X-WWW-Form-Urlencoded'];

  for (const variant of JSON_VARIANTS) {
    test(`A1 unauthenticated "${variant}" gets the same 401 as lowercase JSON`, async ({ request }) => {
      const control = await rawPost(
        `${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`,
        { 'Content-Type': 'application/json' },
        JSON.stringify({}),
      );

      expect(control.status).toBe(401);

      const res = await rawPost(
        `${WEBAPP_BASE_URL}/api/v2${ATTACHMENT_ROUTE}`,
        { 'Content-Type': variant },
        JSON.stringify({}),
      );

      expect(res.status, `content type "${variant}"`).toBe(401);
      expectNoInternalDetail(res.body, `content type "${variant}"`);
      await expectServerAlive(request, `unauthenticated "${variant}"`);
    });

    test(`A1 authenticated "${variant}" valid envelope create behaves like lowercase JSON`, async ({ request }) => {
      const body = JSON.stringify({ type: 'DOCUMENT', title: 'Content type case control' });

      for (const base of V2_BASES) {
        const control = await rawPost(
          `${base}/envelope/create`,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body,
        );

        const res = await rawPost(
          `${base}/envelope/create`,
          { 'Content-Type': variant, Authorization: `Bearer ${token}` },
          body,
        );

        expect(res.status, `${base} content type "${variant}"`).toBeLessThan(500);
        expect(res.status, `${base} content type "${variant}" must match lowercase JSON`).toBe(control.status);
        expectNoInternalDetail(res.body, `${base} content type "${variant}"`);
        await expectServerAlive(request, `authenticated "${variant}" on ${base}`);
      }
    });
  }

  for (const variant of OTHER_VARIANTS) {
    for (const authenticated of [false, true]) {
      test(`A1 "${variant}" ${authenticated ? 'authenticated' : 'unauthenticated'} gives no 5xx and leaves the server up`, async ({
        request,
      }) => {
        const headers: Record<string, string> = { 'Content-Type': variant };

        if (authenticated) {
          headers.Authorization = `Bearer ${token}`;
        }

        for (const base of V2_BASES) {
          const res = await rawPost(`${base}${ATTACHMENT_ROUTE}`, headers, 'a=1&b=2');

          expect(res.status, `${base} content type "${variant}"`).toBeLessThan(500);
          expectNoInternalDetail(res.body, `${base} content type "${variant}"`);
          await expectServerAlive(request, `"${variant}" on ${base}`);
        }
      });
    }
  }

  // A2: a GET that carries a Content-Type header but no body behaves like the same GET without one.
  const GET_CONTENT_TYPES = [
    'application/octet-stream',
    'application/octet-stream; x=1',
    'Application/Octet-Stream',
    'multipart/form-data',
    'text/plain',
  ];
  const GET_ROUTES = ['/envelope', '/envelope/attachment/create', '/does-not-exist'];

  for (const contentType of GET_CONTENT_TYPES) {
    test(`A2 unauthenticated GET with "${contentType}" matches the GET without a content type`, async ({ request }) => {
      for (const base of V2_BASES) {
        for (const route of GET_ROUTES) {
          const control = await rawGet(`${base}${route}`, {});
          const res = await rawGet(`${base}${route}`, { 'Content-Type': contentType });

          expect(res.status, `${base}${route} content type "${contentType}" must match the control`).toBe(
            control.status,
          );
          expect(res.status).toBeLessThan(500);
          expectNoInternalDetail(res.body, `${base}${route} content type "${contentType}"`);
          await expectServerAlive(request, `unauthenticated GET ${base}${route} "${contentType}"`);
        }
      }
    });

    test(`A2 authenticated GET with "${contentType}" matches the GET without a content type`, async ({ request }) => {
      for (const base of V2_BASES) {
        const auth = { Authorization: `Bearer ${token}` };
        const control = await rawGet(`${base}/envelope`, auth);
        const res = await rawGet(`${base}/envelope`, { ...auth, 'Content-Type': contentType });

        expect(control.status, `${base} authenticated control`).toBe(200);
        expect(res.status, `${base}/envelope content type "${contentType}" must match the control`).toBe(
          control.status,
        );
        expectNoInternalDetail(res.body, `${base}/envelope content type "${contentType}"`);
        await expectServerAlive(request, `authenticated GET ${base} "${contentType}"`);
      }
    });
  }

  // A3: a connectionParams query parameter does not change the answer.
  const CONNECTION_PARAMS = ['bad', '[]', '{"a":1}', 'null', '{"a":"b"}'];

  for (const value of CONNECTION_PARAMS) {
    const query = `?connectionParams=${encodeURIComponent(value)}`;

    for (const authenticated of [false, true]) {
      const label = authenticated ? 'authenticated' : 'unauthenticated';

      test(`A3 ${label} GET with connectionParams=${value} matches the GET without it`, async ({ request }) => {
        const headers: Record<string, string> = authenticated ? { Authorization: `Bearer ${token}` } : {};

        for (const base of V2_BASES) {
          const control = await rawGet(`${base}/envelope`, headers);
          const res = await rawGet(`${base}/envelope${query}`, headers);

          expect(control.status, `${base}/envelope control`).toBe(authenticated ? 200 : 401);
          expect(res.status, `${base}/envelope connectionParams=${value} must match the control`).toBe(control.status);
          expectNoInternalDetail(res.body, `${base}/envelope connectionParams=${value}`);
          await expectServerAlive(request, `${label} GET ${base} connectionParams=${value}`);
        }
      });

      test(`A3 ${label} JSON POST with connectionParams=${value} matches the POST without it`, async ({ request }) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (authenticated) {
          headers.Authorization = `Bearer ${token}`;
        }

        for (const base of V2_BASES) {
          const url = `${base}${ATTACHMENT_ROUTE}`;
          const control = await rawPost(url, headers, JSON.stringify({}));
          const res = await rawPost(`${url}${query}`, headers, JSON.stringify({}));

          expect(control.status, `${url} control`).toBe(authenticated ? 400 : 401);
          expect(res.status, `${url} connectionParams=${value} must match the control`).toBe(control.status);
          expectNoInternalDetail(res.body, `${url} connectionParams=${value}`);
          await expectServerAlive(request, `${label} POST ${base} connectionParams=${value}`);
        }
      });
    }
  }

  // A4: ?batch=1 or ?batch=true on a path-parameter route whose value names other procedures behaves
  // exactly like the same request without batch.
  const BATCH_PATHS = [
    { label: 'plain commas', path: '/envelope/x,envelope.get,envelope.create' },
    { label: 'encoded commas', path: '/envelope/x%2Cenvelope.get%2Cenvelope.create' },
  ];
  const BATCH_VALUES = ['1', 'true'];

  for (const { label: pathLabel, path } of BATCH_PATHS) {
    for (const batch of BATCH_VALUES) {
      for (const authenticated of [false, true]) {
        const authLabel = authenticated ? 'authenticated' : 'unauthenticated';

        test(`A4 ${authLabel} GET ${pathLabel} with batch=${batch} matches the GET without batch`, async ({
          request,
        }) => {
          const headers: Record<string, string> = authenticated ? { Authorization: `Bearer ${token}` } : {};

          for (const base of V2_BASES) {
            const control = await rawGet(`${base}${path}`, headers);
            const res = await rawGet(`${base}${path}?batch=${batch}`, headers);

            expect(control.status, `${base}${path} control must not be a server error`).toBeLessThan(500);
            expect(res.status, `${base}${path}?batch=${batch} must match the control`).toBe(control.status);
            expectNoInternalDetail(res.body, `${base}${path}?batch=${batch}`);
            await expectServerAlive(request, `${authLabel} GET ${base}${path}?batch=${batch}`);
          }
        });
      }
    }
  }

  // Last: the server must still serve a normal authenticated v2 request.
  test('C1 final: a normal authenticated v2 request still succeeds', async ({ request }) => {
    await expectServerAlive(request, 'whole run');
    await expectNormalAuthedRequestWorks(request, token);
  });
});
