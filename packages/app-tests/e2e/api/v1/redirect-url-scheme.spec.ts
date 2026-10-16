/**
 * The v1 API accepts a post-signing redirect URL only when it is http or https.
 *
 * Written from the specification before the fix, without reading
 * the v1 request schemas. Every assertion is on the HTTP status and on the rows
 * the request did or did not create.
 *
 * | Test                                                          | Criterion |
 * | ------------------------------------------------------------- | --------- |
 * | C1 <endpoint> refuses <value> and creates no document [x15]    | C1        |
 * | C2 <endpoint> stores an https redirect URL [x3]                | C2        |
 * | C2 <endpoint> accepts an empty redirect URL [x3]               | C2        |
 * | C6 <endpoint> refuses <control-character URL> [x6]             | C6        |
 * | C7 <route> drops a stored javascript: URL from the copy [x3]   | C7        |
 * | C7 <route> carries a stored https URL over to the copy [x3]    | C7        |
 *
 * C6 covers documents and create-document. C7 covers v1 create-document and
 * generate-document from a template whose meta holds the URL (the request
 * sends no meta), and POST /api/v2-beta/envelope/duplicate, the route behind
 * the UI's duplicate dialog (trpc envelope.duplicate). The direct-template
 * half of C7 needs a browser and lives in e2e/recipient/redirect-url-after-signing.spec.ts.
 *
 * Endpoints: POST /api/v1/documents, POST /api/v1/templates/:id/create-document
 * and POST /api/v1/templates/:id/generate-document.
 *
 * POST /api/v1/documents answers 500 under any upload transport but S3, so its
 * cases skip unless NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3". Whether
 * generate-document takes `meta.redirectUrl` at all is settled at run time:
 * each of its tests first sends an https URL and reads the stored value back,
 * and skips with that reason if the endpoint drops it.
 *
 * generate-document already refused these values before the fix (red run of
 * 2026-10-15), so its C1 cases are a control: they pass before and after.
 *
 * A C1 refusal must name the redirect URL (the field or the http/https
 * message), so a 400 from some other validation failure cannot pass it.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToTemplateId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedTemplate } from '@documenso/prisma/seed/templates';
import { seedTestEmail } from '@documenso/prisma/seed/users';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { EnvelopeType, FieldType } from '@prisma/client';
import { nanoid } from 'nanoid';

import { type ApiSeedContext, apiCreateTestContext } from '../../fixtures/api-seeds';

test.describe.configure({ mode: 'parallel' });

const V1 = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1`;
const V2 = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;
const IS_S3 = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT === 's3';
const S3_SKIP_REASON = `POST /api/v1/documents exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT ?? null)}.`;

const REFUSED_VALUES = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,x',
  'vbscript:x',
  ' javascript:alert(1)',
];

/** C6: URLs whose control characters a lenient parser would strip into a valid https URL. */
const CONTROL_CHARACTER_VALUES = ['ht\ntps://example.com', 'https://example.com/\tx', 'https://exa\rmple.com'];

/** A refusal that names the redirect URL field or the http/https URL message. */
const REDIRECT_REFUSAL_PATTERN = /redirectUrl|valid URL|http:\/\/ or https:\/\//i;

type Endpoint = {
  name: string;
  needsS3: boolean;
  /** Whether C6's control-character cases apply to this endpoint. */
  controlCharacterCases: boolean;
  /** Sends one creation request with the given title and redirect URL. */
  send: (request: APIRequestContext, ctx: ApiSeedContext, title: string, redirectUrl: string) => Promise<APIResponse>;
};

/** The meta shape existing v1 specs send; only redirectUrl varies between cases. */
const metaWith = (redirectUrl: string) => ({
  subject: 'Redirect URL scheme',
  message: 'Redirect URL scheme',
  timezone: 'Etc/UTC',
  dateFormat: 'yyyy-MM-dd',
  redirectUrl,
});

const jsonBearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

/** One seeded template per context, reused across that test's requests. */
const templates = new WeakMap<ApiSeedContext, { templateId: number; recipientId: number }>();

const templateOf = async (ctx: ApiSeedContext) => {
  const known = templates.get(ctx);

  if (known) {
    return known;
  }

  const template = await seedTemplate({
    title: `Redirect template ${nanoid()}`,
    userId: ctx.user.id,
    teamId: ctx.team.id,
  });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: template.id } });
  const seeded = { templateId: mapSecondaryIdToTemplateId(template.secondaryId), recipientId: recipient.id };

  templates.set(ctx, seeded);

  return seeded;
};

const ENDPOINTS: Endpoint[] = [
  {
    name: 'POST /api/v1/documents',
    needsS3: true,
    controlCharacterCases: true,
    send: async (request, ctx, title, redirectUrl) =>
      await request.post(`${V1}/documents`, {
        headers: jsonBearer(ctx.token),
        data: {
          title,
          recipients: [{ name: 'Redirect Signer', email: seedTestEmail(), role: 'SIGNER' }],
          meta: metaWith(redirectUrl),
        },
      }),
  },
  {
    name: 'POST /api/v1/templates/:templateId/create-document',
    needsS3: false,
    controlCharacterCases: true,
    send: async (request, ctx, title, redirectUrl) => {
      const { templateId } = await templateOf(ctx);

      return await request.post(`${V1}/templates/${templateId}/create-document`, {
        headers: jsonBearer(ctx.token),
        data: {
          title,
          recipients: [{ name: 'Redirect Signer', email: seedTestEmail() }],
          meta: metaWith(redirectUrl),
        },
      });
    },
  },
  {
    name: 'POST /api/v1/templates/:templateId/generate-document',
    needsS3: false,
    controlCharacterCases: false,
    send: async (request, ctx, title, redirectUrl) => {
      const { templateId, recipientId } = await templateOf(ctx);

      return await request.post(`${V1}/templates/${templateId}/generate-document`, {
        headers: jsonBearer(ctx.token),
        data: {
          title,
          recipients: [{ id: recipientId, name: 'Redirect Signer', email: seedTestEmail() }],
          meta: metaWith(redirectUrl),
        },
      });
    },
  },
];

const countDocuments = async (teamId: number) =>
  await prisma.envelope.count({ where: { teamId, type: EnvelopeType.DOCUMENT } });

const findDocument = async (teamId: number, title: string) =>
  await prisma.envelope.findFirst({
    where: { teamId, title, type: EnvelopeType.DOCUMENT },
    include: { documentMeta: true },
  });

const expectStatus = async (res: APIResponse, expected: number, what: string) => {
  expect(res.status(), `${what}: ${res.status()} ${await res.text()}`).toBe(expected);
};

/**
 * Premise for generate-document: it stores an https redirect URL. If it answers
 * 200 and drops the value, the endpoint takes no redirect URL and the refusal
 * criterion does not apply to it.
 */
const skipUnlessEndpointStoresRedirect = async (
  request: APIRequestContext,
  endpoint: Endpoint,
  ctx: ApiSeedContext,
) => {
  if (!endpoint.name.endsWith('generate-document')) {
    return;
  }

  const title = `Redirect premise ${nanoid()}`;
  const httpsUrl = `https://example.com/premise-${nanoid()}`;
  const res = await endpoint.send(request, ctx, title, httpsUrl);

  await expectStatus(res, 200, `${endpoint.name} premise with an https redirect URL`);

  const stored = await findDocument(ctx.team.id, title);

  test.skip(
    stored?.documentMeta?.redirectUrl !== httpsUrl,
    `${endpoint.name} answered 200 but did not store meta.redirectUrl, so it takes no redirect URL.`,
  );
};

/** Sends one bad redirect URL; requires a 400 that names the redirect URL and no new document. */
const expectRefusedAndNothingCreated = async (request: APIRequestContext, endpoint: Endpoint, value: string) => {
  const ctx = await apiCreateTestContext(`redirect-refused-${nanoid()}`);

  await skipUnlessEndpointStoresRedirect(request, endpoint, ctx);

  const title = `Redirect refused ${nanoid()}`;
  const before = await countDocuments(ctx.team.id);

  const res = await endpoint.send(request, ctx, title, value);

  await expectStatus(res, 400, `${endpoint.name} with redirectUrl ${JSON.stringify(value)}`);

  const refusal = await res.text();

  expect(refusal, 'the 400 is about the redirect URL, not another field').toMatch(REDIRECT_REFUSAL_PATTERN);

  expect(await findDocument(ctx.team.id, title), 'no document carries the refused request title').toBeNull();
  expect(await countDocuments(ctx.team.id), 'the team has no more documents than before').toBe(before);
};

for (const endpoint of ENDPOINTS) {
  const describeName = endpoint.name.endsWith('generate-document')
    ? `${endpoint.name} (control: refused before the fix too)`
    : endpoint.name;

  test.describe(describeName, () => {
    test.skip(endpoint.needsS3 && !IS_S3, S3_SKIP_REASON);

    for (const value of REFUSED_VALUES) {
      /**
       * Guards C1: a redirect URL whose scheme is not http or https is refused
       * with 400 and leaves no document behind, so it can never reach a
       * recipient's browser after signing.
       */
      test(`C1 refuses ${JSON.stringify(value)} and creates no document`, async ({ request }) => {
        await expectRefusedAndNothingCreated(request, endpoint, value);
      });
    }

    for (const value of endpoint.controlCharacterCases ? CONTROL_CHARACTER_VALUES : []) {
      /**
       * Guards C6: a URL carrying a newline, tab or carriage return is refused
       * as C1 refuses a bad scheme, even though a WHATWG parser would strip the
       * character and read a valid https URL.
       */
      test(`C6 refuses ${JSON.stringify(value)} and creates no document`, async ({ request }) => {
        await expectRefusedAndNothingCreated(request, endpoint, value);
      });
    }

    /**
     * Guards C2: the refusal does not reach legitimate input. An https redirect
     * URL is accepted and stored exactly as given.
     */
    test('C2 stores an https redirect URL', async ({ request }) => {
      const ctx = await apiCreateTestContext(`redirect-c2-${nanoid()}`);

      await skipUnlessEndpointStoresRedirect(request, endpoint, ctx);

      const title = `Redirect https ${nanoid()}`;
      const httpsUrl = `https://example.com/after-signing-${nanoid()}`;

      const res = await endpoint.send(request, ctx, title, httpsUrl);

      await expectStatus(res, 200, `${endpoint.name} with an https redirect URL`);

      const stored = await findDocument(ctx.team.id, title);

      expect(stored, 'the document was created').not.toBeNull();
      expect(stored?.documentMeta?.redirectUrl).toBe(httpsUrl);
    });

    /**
     * Guards C2: an empty redirect URL, meaning "no redirect", is still accepted.
     */
    test('C2 accepts an empty redirect URL', async ({ request }) => {
      const ctx = await apiCreateTestContext(`redirect-c2-empty-${nanoid()}`);

      await skipUnlessEndpointStoresRedirect(request, endpoint, ctx);

      const title = `Redirect empty ${nanoid()}`;

      const res = await endpoint.send(request, ctx, title, '');

      await expectStatus(res, 200, `${endpoint.name} with an empty redirect URL`);

      expect(await findDocument(ctx.team.id, title), 'the document was created').not.toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// C7: copies drop a stored non-http(s) redirect URL
// ---------------------------------------------------------------------------

type CopyRoute = {
  name: string;
  /** Seeds an original whose meta holds redirectUrl, copies it, and returns the copy's stored redirect URL. */
  copy: (request: APIRequestContext, ctx: ApiSeedContext, redirectUrl: string) => Promise<string | null | undefined>;
};

/** A template whose meta holds the given redirect URL, written through prisma as a pre-fix value would be. */
const seedTemplateWithRedirect = async (ctx: ApiSeedContext, redirectUrl: string) => {
  const template = await seedTemplate({
    title: `Redirect copy template ${nanoid()}`,
    userId: ctx.user.id,
    teamId: ctx.team.id,
  });

  await prisma.documentMeta.update({ where: { id: template.documentMetaId }, data: { redirectUrl } });

  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: template.id } });

  return { templateId: mapSecondaryIdToTemplateId(template.secondaryId), recipientId: recipient.id };
};

const COPY_ROUTES: CopyRoute[] = [
  {
    name: 'v1 create-document from a template',
    copy: async (request, ctx, redirectUrl) => {
      const { templateId } = await seedTemplateWithRedirect(ctx, redirectUrl);
      const title = `Redirect copy ${nanoid()}`;

      const res = await request.post(`${V1}/templates/${templateId}/create-document`, {
        headers: jsonBearer(ctx.token),
        data: { title, recipients: [{ name: 'Redirect Signer', email: seedTestEmail() }] },
      });

      await expectStatus(res, 200, 'create-document without a redirect URL in the request');

      return (await findDocument(ctx.team.id, title))?.documentMeta?.redirectUrl;
    },
  },
  {
    name: 'v1 generate-document from a template',
    copy: async (request, ctx, redirectUrl) => {
      const { templateId, recipientId } = await seedTemplateWithRedirect(ctx, redirectUrl);
      const title = `Redirect copy ${nanoid()}`;

      const res = await request.post(`${V1}/templates/${templateId}/generate-document`, {
        headers: jsonBearer(ctx.token),
        data: { title, recipients: [{ id: recipientId, name: 'Redirect Signer', email: seedTestEmail() }] },
      });

      await expectStatus(res, 200, 'generate-document without a redirect URL in the request');

      return (await findDocument(ctx.team.id, title))?.documentMeta?.redirectUrl;
    },
  },
  {
    name: 'envelope duplicate (the UI duplicate dialog route)',
    copy: async (request, ctx, redirectUrl) => {
      const { document } = await seedPendingDocumentWithFullFields({
        owner: ctx.user,
        teamId: ctx.team.id,
        recipients: [seedTestEmail()],
        fields: [FieldType.SIGNATURE],
      });

      await prisma.documentMeta.update({ where: { id: document.documentMetaId }, data: { redirectUrl } });

      const res = await request.post(`${V2}/envelope/duplicate`, {
        headers: jsonBearer(ctx.token),
        data: { envelopeId: document.id },
      });

      await expectStatus(res, 200, 'envelope/duplicate');

      const copies = await prisma.envelope.findMany({
        where: { teamId: ctx.team.id, type: EnvelopeType.DOCUMENT, id: { not: document.id } },
        include: { documentMeta: true },
      });

      expect(copies, 'exactly one copy was made').toHaveLength(1);

      return copies[0].documentMeta?.redirectUrl;
    },
  },
];

test.describe('C7 copies', () => {
  for (const route of COPY_ROUTES) {
    /**
     * Guards C7: a javascript: redirect URL stored before the fix does not
     * survive into a copy, so copying cannot launder it past the API check.
     */
    test(`C7 ${route.name} drops a stored javascript: redirect URL`, async ({ request }) => {
      const ctx = await apiCreateTestContext(`redirect-c7-${nanoid()}`);

      const copied = await route.copy(request, ctx, 'javascript:alert(1)');

      expect(copied ?? '', 'the copy stores no redirect URL').toBe('');
    });

    /**
     * Guards C7's control: a legitimate https redirect URL is still carried over.
     */
    test(`C7 ${route.name} carries a stored https redirect URL over`, async ({ request }) => {
      const ctx = await apiCreateTestContext(`redirect-c7-https-${nanoid()}`);
      const httpsUrl = `https://example.com/copied-${nanoid()}`;

      expect(await route.copy(request, ctx, httpsUrl)).toBe(httpsUrl);
    });
  }
});
