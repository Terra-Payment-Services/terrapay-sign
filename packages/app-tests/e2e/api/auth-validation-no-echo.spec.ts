import { randomBytes, randomInt } from 'node:crypto';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, request, test } from '@playwright/test';

/**
 * Issue #202: a validation failure answers 400 with the shape `{ success: false, error: [{ path, message }] }` and
 * carries none of the submitted values. Every case sends distinctive marker values and asserts three things about the
 * raw response text: the status is 400, the body still names the invalid field (so a body that is simply empty or
 * generic cannot pass), and no marker appears anywhere in it.
 *
 * C1 and C2: JSON bodies to every validated auth route.
 * C3: valid requests still work.
 * C5: odd shapes, an object or array holding the secret, and a form upload.
 * C6: param and query validators on the download and file routes.
 * C4 needs a browser and is in e2e/user/signup-validation-error.spec.ts.
 */

test.describe.configure({ mode: 'parallel', timeout: 90000 });

const AUTH = '/api/auth';
const EMAIL_PASSWORD = `${AUTH}/email-password`;

const marker = (label: string) => `Echo-Marker-${label}-${randomBytes(6).toString('hex')}`;

const randomIp = () => `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

const newClient = async () => {
  return await request.newContext({
    baseURL: NEXT_PUBLIC_WEBAPP_URL(),
    extraHTTPHeaders: { 'x-forwarded-for': randomIp() },
  });
};

/**
 * Names the invalid field of an issue whatever the path is made of: a list of keys, a list of `{ key }` segments, or a
 * dotted string. The spec says only that each issue carries "the field path and a message".
 */
const pathOf = (issue: { path?: unknown }) => {
  const { path } = issue;

  if (Array.isArray(path)) {
    return path
      .map((segment) =>
        typeof segment === 'object' && segment !== null && 'key' in segment ? String(segment.key) : String(segment),
      )
      .join('.');
  }

  return String(path ?? '');
};

/**
 * The shared assertions: 400, `success: false`, an issue whose path starts with `field` and has a message, and no
 * marker anywhere in the raw text.
 */
const expectRefusedWithoutEcho = async (response: APIResponse, field: string, markers: string[]) => {
  const text = await response.text();

  expect(response.status(), 'status').toBe(400);

  const body = JSON.parse(text);

  expect(body.success, 'success flag').toBe(false);
  expect(Array.isArray(body.error), 'error is a list of issues').toBe(true);
  expect(body.error.length, 'at least one issue').toBeGreaterThan(0);

  const paths = body.error.map(pathOf);

  expect(
    paths.some((path: string) => path === field || path.startsWith(`${field}.`)),
    `an issue names "${field}", got ${JSON.stringify(paths)}`,
  ).toBe(true);

  for (const issue of body.error) {
    expect(issue.message, 'issue message is exactly "Invalid value"').toBe('Invalid value');
  }

  for (const value of markers) {
    expect(text, `response carries the submitted value ${value}`).not.toContain(value);
  }

  expect(body, 'no data key').not.toHaveProperty('data');
};

type JsonCase = {
  name: string;
  path: string;
  field: string;
  build: () => { data: Record<string, unknown>; markers: string[] };
};

// Lowercase letters only and 20 characters at most: the schema waives its character-class rules above 25 characters,
// so a longer marker would be a valid password.
const WEAK_PASSWORD = () =>
  `weak${Array.from(randomBytes(12), (byte) => String.fromCharCode(97 + (byte % 26))).join('')}`;

const JSON_CASES: JsonCase[] = [
  {
    name: 'signup with an invalid email',
    path: `${EMAIL_PASSWORD}/signup`,
    field: 'email',
    build: () => {
      const password = marker('password');
      const name = marker('name');
      const email = marker('bad-email');

      return { data: { name, email, password }, markers: [password, name, email] };
    },
  },
  {
    name: 'signup with a weak password',
    path: `${EMAIL_PASSWORD}/signup`,
    field: 'password',
    build: () => {
      const password = WEAK_PASSWORD();
      const name = marker('name');
      const email = seedTestEmail();

      return { data: { name, email, password }, markers: [password, name, email] };
    },
  },
  {
    name: 'authorize with an invalid email',
    path: `${EMAIL_PASSWORD}/authorize`,
    field: 'email',
    build: () => {
      const password = marker('password');
      const csrfToken = marker('csrf');
      const email = marker('bad-email');

      return { data: { email, password, csrfToken }, markers: [password, csrfToken, email] };
    },
  },
  {
    name: 'update-password with a weak new password',
    path: `${EMAIL_PASSWORD}/update-password`,
    field: 'password',
    build: () => {
      const currentPassword = marker('current-password');
      const password = WEAK_PASSWORD();
      const totpCode = marker('totp');

      return { data: { currentPassword, password, totpCode }, markers: [currentPassword, password, totpCode] };
    },
  },
  {
    name: 'reset-password with a weak password',
    path: `${EMAIL_PASSWORD}/reset-password`,
    field: 'password',
    build: () => {
      const password = WEAK_PASSWORD();
      const token = marker('token');

      return { data: { password, token }, markers: [password, token] };
    },
  },
  {
    name: 'forgot-password with an invalid email and an extra password field',
    path: `${EMAIL_PASSWORD}/forgot-password`,
    field: 'email',
    build: () => {
      const email = marker('bad-email');
      const password = marker('password');

      return { data: { email, password }, markers: [email, password] };
    },
  },
  {
    name: 'verify-email with a non-string token',
    path: `${EMAIL_PASSWORD}/verify-email`,
    field: 'token',
    build: () => {
      const token = marker('token');
      const password = marker('password');

      return { data: { token: { nested: token }, password }, markers: [token, password] };
    },
  },
  {
    name: 'resend-verify-email with an invalid email',
    path: `${EMAIL_PASSWORD}/resend-verify-email`,
    field: 'email',
    build: () => {
      const email = marker('bad-email');
      const password = marker('password');

      return { data: { email, password }, markers: [email, password] };
    },
  },
  {
    name: 'email-password 2fa/enable with a non-string code',
    path: `${EMAIL_PASSWORD}/2fa/enable`,
    field: 'code',
    build: () => {
      const code = marker('code');
      const password = marker('password');

      return { data: { code: { nested: code }, password }, markers: [code, password] };
    },
  },
  {
    name: 'email-password 2fa/disable with a non-string totpCode',
    path: `${EMAIL_PASSWORD}/2fa/disable`,
    field: 'totpCode',
    build: () => {
      const totpCode = marker('totp');
      const backupCode = marker('backup');

      return { data: { totpCode: { nested: totpCode }, backupCode }, markers: [totpCode, backupCode] };
    },
  },
  {
    name: 'email-password 2fa/view-recovery-codes with a non-string token',
    path: `${EMAIL_PASSWORD}/2fa/view-recovery-codes`,
    field: 'token',
    build: () => {
      const token = marker('token');
      const password = marker('password');

      return { data: { token: { nested: token }, password }, markers: [token, password] };
    },
  },
  {
    name: 'two-factor enable with an over-long code',
    path: `${AUTH}/two-factor/enable`,
    field: 'code',
    build: () => {
      const code = marker('code');
      const password = marker('password');

      return { data: { code, password }, markers: [code, password] };
    },
  },
  {
    name: 'two-factor disable with a non-string backupCode',
    path: `${AUTH}/two-factor/disable`,
    field: 'backupCode',
    build: () => {
      const backupCode = marker('backup');
      const totpCode = marker('totp');

      return { data: { backupCode: { nested: backupCode }, totpCode }, markers: [backupCode, totpCode] };
    },
  },
  {
    name: 'two-factor view-recovery-codes with an empty token',
    path: `${AUTH}/two-factor/view-recovery-codes`,
    field: 'token',
    build: () => {
      const password = marker('password');

      return { data: { token: '', password }, markers: [password] };
    },
  },
  {
    name: 'passkey authorize with an empty csrfToken',
    path: `${AUTH}/passkey/authorize`,
    field: 'csrfToken',
    build: () => {
      const credential = marker('credential');
      const password = marker('password');

      return { data: { csrfToken: '', credential, password }, markers: [credential, password] };
    },
  },
  {
    name: 'oauth authorize/microsoft with a non-string redirectPath',
    path: `${AUTH}/oauth/authorize/microsoft`,
    field: 'redirectPath',
    build: () => {
      const redirectPath = marker('redirect');
      const password = marker('password');

      return { data: { redirectPath: { nested: redirectPath }, password }, markers: [redirectPath, password] };
    },
  },
  {
    name: 'signout-session with an empty sessionId',
    path: `${AUTH}/signout-session`,
    field: 'sessionId',
    build: () => {
      const password = marker('password');

      return { data: { sessionId: '   ', password }, markers: [password] };
    },
  },
];

test.describe('[API] auth validation failures echo nothing (#202)', () => {
  for (const testCase of JSON_CASES) {
    test(`[C1][C2] ${testCase.name}: 400 names the field and carries no submitted value`, async () => {
      const client = await newClient();
      const { data, markers } = testCase.build();

      const response = await client.post(testCase.path, { data });

      await expectRefusedWithoutEcho(response, testCase.field, markers);
    });
  }

  test('[C5] signup with the password inside an object in an invalid field echoes nothing', async () => {
    const client = await newClient();
    const password = marker('password');
    const name = marker('name');

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      data: { name, email: { credentials: { password, name } }, password },
    });

    await expectRefusedWithoutEcho(response, 'email', [password, name]);
  });

  test('[C5] signup with the password inside an array in an invalid field echoes nothing', async () => {
    const client = await newClient();
    const password = marker('password');
    const email = seedTestEmail();

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      data: { name: [password, [password]], email, password: [password, { deep: [password] }] },
    });

    await expectRefusedWithoutEcho(response, 'name', [password, email]);
  });

  test('[C5] authorize with the password inside an array in an invalid field echoes nothing', async () => {
    const client = await newClient();
    const password = marker('password');
    const csrfToken = marker('csrf');

    const response = await client.post(`${EMAIL_PASSWORD}/authorize`, {
      data: { email: [password, { password }], password: [password], csrfToken },
    });

    await expectRefusedWithoutEcho(response, 'email', [password, csrfToken]);
  });

  test('[C5] reset-password with a JSON array body echoes nothing', async () => {
    const client = await newClient();
    const password = marker('password');
    const token = marker('token');

    const response = await client.post(`${EMAIL_PASSWORD}/reset-password`, { data: [{ password, token }] });

    const text = await response.text();

    expect(response.status()).toBe(400);
    expect(JSON.parse(text).success).toBe(false);

    for (const issue of JSON.parse(text).error) {
      expect(issue.message).toBe('Invalid value');
    }

    expect(text).not.toContain(password);
    expect(text).not.toContain(token);
  });

  test('[C5] a urlencoded form body to a JSON route echoes nothing', async () => {
    const client = await newClient();
    const password = marker('password');
    const email = marker('bad-email');

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      form: { name: marker('name'), email, password },
    });

    const text = await response.text();

    // Whatever status the JSON validator gives a non-JSON body, nothing submitted may come back.
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    expect(text).not.toContain(password);
    expect(text).not.toContain(email);
  });

  test('[C5] a multipart upload with an invalid file field and an extra password field echoes nothing', async () => {
    const { user } = await seedUser({ password: 'password' });
    const client = await newClient();

    const csrf = await client.get(`${AUTH}/csrf`);
    const { csrfToken } = await csrf.json();

    const signIn = await client.post(`${EMAIL_PASSWORD}/authorize`, {
      data: { email: user.email, password: 'password', csrfToken },
    });

    expect(signIn.status(), await signIn.text()).toBe(201);

    const password = marker('password');
    const fileValue = marker('not-a-file');

    const response = await client.post('/api/files/upload-pdf', {
      multipart: { file: fileValue, password },
    });

    const text = await response.text();

    expect(response.status(), text).toBe(400);
    expect(JSON.parse(text).success).toBe(false);

    for (const issue of JSON.parse(text).error) {
      expect(issue.message).toBe('Invalid value');
    }

    expect(text).not.toContain(password);
    expect(text).not.toContain(fileValue);
  });
});

test.describe('[API] valid auth requests behave as before (#202)', () => {
  test('[C3] signup with valid fields succeeds and creates the user', async () => {
    const client = await newClient();
    const email = seedTestEmail();

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      data: { name: 'Echo Test', email, password: 'Password123#' },
    });

    expect(response.ok(), await response.text()).toBe(true);
    expect(await prisma.user.findFirst({ where: { email } })).not.toBeNull();
  });

  test('[C3] sign-in with valid credentials succeeds', async () => {
    const { user } = await seedUser({ password: 'password' });
    const client: APIRequestContext = await newClient();

    const csrf = await client.get(`${AUTH}/csrf`);
    const { csrfToken } = await csrf.json();

    const response = await client.post(`${EMAIL_PASSWORD}/authorize`, {
      data: { email: user.email, password: 'password', csrfToken },
    });

    expect(response.status(), await response.text()).toBe(201);
  });
});

test.describe('[API] param and query validation failures echo nothing (#202)', () => {
  for (const prefix of ['/api/v2', '/api/v2-beta']) {
    test(`[C6] ${prefix} document download with a non-numeric documentId`, async () => {
      const client = await newClient();
      const documentId = marker('document');

      const response = await client.get(`${prefix}/document/${documentId}/download`);

      await expectRefusedWithoutEcho(response, 'documentId', [documentId]);
    });

    test(`[C6] ${prefix} envelope item download with an invalid version query`, async () => {
      const client = await newClient();
      const version = marker('version');

      const response = await client.get(`${prefix}/envelope/item/item-1/download?version=${version}`);

      await expectRefusedWithoutEcho(response, 'version', [version]);
    });
  }

  test('[C6] file download with an invalid version param', async () => {
    const client = await newClient();
    const version = marker('version');

    const response = await client.get(`/api/files/envelope/env-1/envelopeItem/item-1/download/${version}`);

    await expectRefusedWithoutEcho(response, 'version', [version]);
  });

  test('[C6] token file download with an invalid version param does not echo the token either', async () => {
    const client = await newClient();
    const version = marker('version');
    const token = marker('token');

    const response = await client.get(`/api/files/token/${token}/envelopeItem/item-1/download/${version}`);

    await expectRefusedWithoutEcho(response, 'version', [version, token]);
  });

  test('[C6] envelope item pdf with an invalid version param does not echo the envelope id', async () => {
    const client = await newClient();
    const version = marker('version');
    const envelopeId = marker('envelope');

    const response = await client.get(
      `/api/files/envelope/${envelopeId}/envelopeItem/item-1/dataId/data-1/${version}/item.pdf`,
    );

    await expectRefusedWithoutEcho(response, 'version', [version, envelopeId]);
  });

  test('[C6] token envelope item pdf with an invalid version param does not echo the token', async () => {
    const client = await newClient();
    const version = marker('version');
    const token = marker('token');

    const response = await client.get(
      `/api/files/token/${token}/envelope/env-1/envelopeItem/item-1/dataId/data-1/${version}/item.pdf`,
    );

    await expectRefusedWithoutEcho(response, 'version', [version, token]);
  });
});

/**
 * Amendment 3 (C2 revised, C6c): every issue's message is exactly "Invalid value", whatever the validator said. Nothing
 * carries the `***` mask of C6a.
 */
const INVALID_VALUE = 'Invalid value';

const issuesOf = async (response: APIResponse, field: string) => {
  const text = await response.text();

  expect(response.status(), text).toBe(400);

  const body = JSON.parse(text);

  expect(body.success, 'success flag').toBe(false);
  expect(body, 'no data key').not.toHaveProperty('data');
  expect(text, 'no mask').not.toContain('***');

  const issues: { path?: unknown; message: string }[] = body.error;
  const named = issues.filter((issue) => pathOf(issue) === field || pathOf(issue).startsWith(`${field}.`));

  expect(named.length, `an issue names "${field}", got ${text}`).toBeGreaterThan(0);

  for (const issue of issues) {
    expect(issue.message, 'every issue message is exactly "Invalid value"').toBe(INVALID_VALUE);
  }

  return { text, issues, named };
};

const expectInvalidValue = async (response: APIResponse, field: string) => {
  const { text, issues, named } = await issuesOf(response, field);

  for (const issue of named) {
    expect(issue.message, 'message is exactly "Invalid value"').toBe(INVALID_VALUE);
  }

  return { text, issues };
};

const expectInvalidValueWithoutEcho = async (response: APIResponse, field: string, markers: string[]) => {
  const { text } = await expectInvalidValue(response, field);

  for (const value of markers) {
    expect(text, `response carries ${value}`).not.toContain(value);
  }
};

test.describe('[API] short submitted values answer "Invalid value" (#202 A1, C6b)', () => {
  for (const prefix of ['/api/v2', '/api/v2-beta']) {
    for (const version of ['xy', 'x', 'e']) {
      test(`[A1][C6b] ${prefix} envelope item download with version=${version} answers "Invalid value"`, async () => {
        const client = await newClient();

        const response = await client.get(`${prefix}/envelope/item/item-1/download?version=${version}`);

        await expectInvalidValue(response, 'version');
      });
    }
  }

  for (const version of ['xy', 'x']) {
    test(`[A1][C6b] file download with version param ${version} answers "Invalid value"`, async () => {
      const client = await newClient();

      const response = await client.get(`/api/files/envelope/env-1/envelopeItem/item-1/download/${version}`);

      await expectInvalidValue(response, 'version');
    });

    test(`[A1][C6b] token file download with version param ${version} answers "Invalid value"`, async () => {
      const client = await newClient();

      const response = await client.get(`/api/files/token/tok-1/envelopeItem/item-1/download/${version}`);

      await expectInvalidValue(response, 'version');
    });

    test(`[A1][C6b] envelope item pdf with version param ${version} answers "Invalid value"`, async () => {
      const client = await newClient();

      const response = await client.get(
        `/api/files/envelope/env-1/envelopeItem/item-1/dataId/data-1/${version}/item.pdf`,
      );

      await expectInvalidValue(response, 'version');
    });
  }

  test('[A1][C6b] an auth body with a two-character invalid code answers "Invalid value" and echoes nothing', async () => {
    const client = await newClient();

    const response = await client.post(`${AUTH}/two-factor/enable`, {
      data: { code: 'xy', password: marker('password') },
    });

    const { text } = await expectInvalidValue(response, 'code');

    expect(text).not.toContain('xy');
  });
});

/**
 * C6b: values holding a newline, a double quote and a backslash, on the download and file routes.
 */
const AWKWARD = 'qzline\n"quotemark\\slashend';

test.describe('[API] awkward submitted values answer "Invalid value" (#202 A2, C6b)', () => {
  const encoded = encodeURIComponent(AWKWARD);

  const expectNoPieces = (text: string) => {
    for (const piece of ['qzline', 'quotemark', 'slashend']) {
      expect(text, `response carries ${piece}`).not.toContain(piece);
    }
  };

  for (const prefix of ['/api/v2', '/api/v2-beta']) {
    test(`[A2][C6b] ${prefix} envelope item download with a newline, quote and backslash in version`, async () => {
      const client = await newClient();

      const response = await client.get(`${prefix}/envelope/item/item-1/download?version=${encoded}`);

      const { text } = await expectInvalidValue(response, 'version');

      expectNoPieces(text);
    });
  }

  test('[A2][C6b] file download with a newline, quote and backslash in the version param', async () => {
    const client = await newClient();

    const response = await client.get(`/api/files/envelope/env-1/envelopeItem/item-1/download/${encoded}`);

    const { text } = await expectInvalidValue(response, 'version');

    expectNoPieces(text);
  });

  test('[A2][C6b] token file download with a newline, quote and backslash in the version param', async () => {
    const client = await newClient();

    const response = await client.get(`/api/files/token/tok-1/envelopeItem/item-1/download/${encoded}`);

    const { text } = await expectInvalidValue(response, 'version');

    expectNoPieces(text);
  });

  test('[A2][C6b] envelope item pdf with a newline, quote and backslash in the version param', async () => {
    const client = await newClient();

    const response = await client.get(
      `/api/files/envelope/env-1/envelopeItem/item-1/dataId/data-1/${encoded}/item.pdf`,
    );

    const { text } = await expectInvalidValue(response, 'version');

    expectNoPieces(text);
  });
});

test.describe('[API] messages the validator would have kept now answer "Invalid value" (#202 A3, C6c)', () => {
  test('[A3][C6c] signup with an over-long name answers "Invalid value" on name', async () => {
    const client = await newClient();
    const name = `${marker('longname')}-${'x'.repeat(101)}`;
    const email = seedTestEmail();

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      data: { name, email, password: 'Password123#' },
    });

    await expectInvalidValueWithoutEcho(response, 'name', [name, email]);
  });

  test('[A3][C6c] signup with a weak password answers "Invalid value" on password', async () => {
    const client = await newClient();
    const password = WEAK_PASSWORD();

    const response = await client.post(`${EMAIL_PASSWORD}/signup`, {
      data: { name: 'Echo Test', email: seedTestEmail(), password },
    });

    await expectInvalidValueWithoutEcho(response, 'password', [password]);
  });
});
