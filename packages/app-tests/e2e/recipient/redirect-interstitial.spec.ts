/**
 * Every redirect after signing goes through an interstitial on the app's own origin (#186).
 *
 * Written from the specification (campaign F186 spec.md) before the fix. The browser must end
 * on /sign/<token>/complete; that page names the destination and offers a Continue link to the
 * stored URL as the WHATWG parser resolves it with no base (`new URL(stored).href`, Amendment 1).
 * Nothing navigates automatically.
 *
 * | Test                                                                   | Criterion |
 * | ---------------------------------------------------------------------- | --------- |
 * | R1 K1 .. R1 K6 (one per navigation sink)                               | R1        |
 * | R2 <case> names the host the browser resolves [x6]                     | R2        |
 * | R2b <form> base-dependent form resolves to partner.example [x3]        | R2b       |
 * | R3 Continue navigates the top window to the stored URL, no token Referer | R3      |
 * | R4 unsigned / rejected / CC (seeded SIGNED) none; VIEWER / APPROVER block | R4      |
 * | R5 <value> stored shows no destination [x8], a %0d%0a URL shown, two signings | R5    |
 * | R6 <suffix> on the complete page changes nothing [x6]                  | R6        |
 * | R7 <path> with no redirect URL shows no Continue block [x6]            | R7        |
 * | R8 V2 embed posts document-completed and stays on /embed/sign          | R8        |
 * | R9 every interstitial message is a msgid in every supported catalog   | R9        |
 * | R11 soft-deleted document shows no destination                         | R11       |
 * | R12 expired SIGNED recipient on /complete shows no destination         | R12       |
 * | R13 same-origin destination: Continue sends no Referer with the token  | R13       |
 *
 * Sinks and the UI path that reaches each:
 *   K1 V1 document signed at /sign/<token>.
 *   K2 V2 envelope signed at /sign/<token> (handleOnCompleteClick).
 *   K3 V2 direct template signed at /d/<token> (handleDirectTemplateCompleteClick, not embedded).
 *   K4 V1 direct template signed at /d/<token> (direct-template-page).
 *   K5 V1 signing link reopened by a recipient who has signed (server loader).
 *   K6 V2 signing link reopened by a recipient who has signed (server loader).
 *
 * Destinations. Where a test must see whether the browser asked for the destination (R1, R3,
 * R8), the destination is a real HTTP server on 127.0.0.1 that records every request and its
 * Referer. Elsewhere every request to a host other than localhost or 127.0.0.1 is answered by a
 * context route with a stub page and recorded, so look-alike hosts never reach DNS.
 *
 * Locators the fix must provide are gathered in the block below.
 */
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { SUPPORTED_LANGUAGE_CODES } from '@documenso/lib/constants/locales';
import { isValidRedirectUrl } from '@documenso/lib/utils/is-valid-redirect-url';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Locator, type Page, type Response, test } from '@playwright/test';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { outsideSweepWindow } from '../fixtures/reject-seal';
import { signSignaturePad } from '../fixtures/signature';

test.describe.configure({ mode: 'parallel', timeout: 180_000 });

// ---------------------------------------------------------------------------
// What the interstitial must render. Align these with the fix, in one place.
// ---------------------------------------------------------------------------

/** The Continue control: an <a href="new URL(stored).href"> whose accessible name is exactly this. */
const CONTINUE_LINK_NAME = 'Continue';

/** A sentence the interstitial shows above the destination host. New message; R9 checks the catalogs. */
const INTERSTITIAL_NOTICE = 'The sender has linked a page for you to visit next.';

/** Visible English strings of the interstitial that must be msgids in every catalog (R9). */
const INTERSTITIAL_MESSAGES = [INTERSTITIAL_NOTICE, CONTINUE_LINK_NAME];

const continueLink = (page: Page) => page.getByRole('link', { name: CONTINUE_LINK_NAME, exact: true });

const interstitialNotice = (page: Page) => page.getByText(INTERSTITIAL_NOTICE, { exact: true });

/** The destination host, rendered as an element whose whole text is the host (with port, if any). */
const hostLabel = (page: Page, host: string) => page.getByText(host, { exact: true });

/** The full destination URL, rendered as an element whose whole text is the link's resolved href. */
const fullUrlLine = (page: Page, href: string) => page.getByText(href, { exact: true });

// ---------------------------------------------------------------------------

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();
const APP_ORIGIN = new URL(WEBAPP_URL).origin;
const PDF_PAGE_SELECTOR = 'img[data-page-number]';
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1'];

/** How long a landed page is watched for a late automatic redirect. */
const SETTLE_MS = 3_000;

const TRANSLATIONS_DIR = path.join(__dirname, '../../../lib/translations');

type TFieldBox = { id: number; positionX: unknown; positionY: unknown; width: unknown; height: unknown };

type TDestinationHit = { url: string; referer: string | undefined };

type TDestination = { origin: string; hits: TDestinationHit[] };

// ---------------------------------------------------------------------------
// Cleanup (#177, #193): every envelope a test seeds or creates is soft-deleted after it.
// ---------------------------------------------------------------------------

const seededEnvelopeIds: string[] = [];
const seededTeamIds: number[] = [];
const servers: Server[] = [];

test.afterEach(async () => {
  const ids = seededEnvelopeIds.splice(0);
  const teamIds = seededTeamIds.splice(0);

  await prisma.envelope.updateMany({
    where: { deletedAt: null, OR: [{ id: { in: ids } }, { teamId: { in: teamIds }, type: 'DOCUMENT' }] },
    data: { deletedAt: new Date() },
  });

  await Promise.all(servers.splice(0).map(async (server) => new Promise((resolve) => server.close(resolve))));
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** A real HTTP server on 127.0.0.1 that records each request (favicon aside) and answers 200. */
const startDestination = async (): Promise<TDestination> => {
  const hits: TDestinationHit[] = [];

  const server = createServer((request, response) => {
    // Only requests for a test's own redirect URL count: each carries its n=<nanoid>, and anything else on the
    // machine that probes the port (a curl HEAD / was seen once) is not the signer's browser.
    if (request.url?.includes('n=')) {
      hits.push({ url: request.url ?? '', referer: request.headers.referer });
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Destination</title><h1>Destination reached</h1>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  servers.push(server);

  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
};

/**
 * Records every request the page makes to a non-local host (redirect hops included) and answers
 * the ones a route can intercept with a stub page, so look-alike hosts never reach DNS.
 */
const stubExternalHosts = async (page: Page) => {
  const external: string[] = [];

  page.on('request', (request) => {
    if (!LOCAL_HOSTNAMES.includes(new URL(request.url()).hostname)) {
      external.push(request.url());
    }
  });

  await page.context().route(
    (url) => !LOCAL_HOSTNAMES.includes(url.hostname),
    async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>External</h1>' });
    },
  );

  return external;
};

/**
 * Opens an app path. A server redirect to an unresolvable external host fails the navigation;
 * that failure is recorded rather than thrown, so the assertions that follow report where the
 * browser went.
 */
const visit = async (page: Page, appPath: string) =>
  await page.goto(appPath).catch((error: unknown) => {
    test.info().annotations.push({ type: 'navigation failed', description: String(error).split('\n')[0] });

    return null;
  });

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const setRedirectUrl = async (documentMetaId: string, redirectUrl: string | null) => {
  await prisma.documentMeta.update({ where: { id: documentMetaId }, data: { redirectUrl } });

  const stored = await prisma.documentMeta.findUniqueOrThrow({ where: { id: documentMetaId } });

  expect(stored.redirectUrl, 'premise: the redirect URL is stored as given').toBe(redirectUrl);
};

/** A pending single-signer document; the redirect URL, if any, is written through prisma. */
const seedSigner = async (internalVersion: 1 | 2, redirectUrl: string | null) => {
  const { user, team } = await seedUser();

  seededTeamIds.push(team.id);

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [seedTestEmail()],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion, title: `Redirect interstitial ${nanoid()}` },
  });

  seededEnvelopeIds.push(document.id);

  if (redirectUrl !== null) {
    await setRedirectUrl(document.documentMetaId, redirectUrl);
  }

  return { document, recipient: recipients[0] };
};

/** As seedSigner, with the recipient already SIGNED (signedAt kept outside the seal sweep window). */
const seedSignedSigner = async (internalVersion: 1 | 2, redirectUrl: string | null) => {
  const seeded = await seedSigner(internalVersion, redirectUrl);

  await prisma.recipient.update({
    where: { id: seeded.recipient.id },
    data: { signingStatus: SigningStatus.SIGNED, signedAt: outsideSweepWindow() },
  });

  return seeded;
};

/** A pending document created and sent through API v2 with meta.redirectUrl; skips if the API refuses it. */
const apiSeedSignerWithRedirect = async (request: APIRequestContext, redirectUrl: string) => {
  let seeded: Awaited<ReturnType<typeof apiSeedPendingDocument>>;

  try {
    seeded = await apiSeedPendingDocument(request, {
      title: `Redirect interstitial API ${nanoid()}`,
      recipients: [{ email: seedTestEmail(), name: 'Redirect Signer', role: 'SIGNER' }],
      meta: { redirectUrl },
    });
  } catch (error) {
    test.info().annotations.push({ type: 'api-refused', description: `${redirectUrl}: ${String(error)}` });
    test.skip(true, `API v2 refused meta.redirectUrl ${JSON.stringify(redirectUrl)}`);

    throw error;
  }

  seededEnvelopeIds.push(seeded.envelope.id);
  seededTeamIds.push(seeded.team.id);

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: seeded.envelope.id },
    include: { documentMeta: true, recipients: { include: { fields: true } } },
  });

  expect(envelope.documentMeta?.redirectUrl, 'premise: the API stored the redirect URL as given').toBe(redirectUrl);

  const recipient = envelope.recipients[0];

  return { recipient, internalVersion: envelope.internalVersion === 1 ? (1 as const) : (2 as const) };
};

/** A direct template whose meta carries the redirect URL, if any. */
const seedDirect = async (internalVersion: 1 | 2, redirectUrl: string | null) => {
  const { user, team } = await seedUser();

  seededTeamIds.push(team.id);

  const template = await seedDirectTemplate({
    title: `Redirect interstitial direct ${nanoid()}`,
    userId: user.id,
    teamId: team.id,
    internalVersion,
  });

  seededEnvelopeIds.push(template.id);

  if (redirectUrl !== null) {
    await setRedirectUrl(template.documentMetaId, redirectUrl);
  }

  return { team, template, signerEmail: seedTestEmail() };
};

/** The recipient the direct link created for the visitor; its envelope is tracked for cleanup. */
const findDirectSigner = async (teamId: number, email: string) => {
  const find = async () =>
    await prisma.recipient.findFirst({ where: { email, envelope: { teamId, type: 'DOCUMENT' } } });

  await expect.poll(async () => (await find())?.signingStatus, { timeout: 30_000 }).toBe(SigningStatus.SIGNED);

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: { email, envelope: { teamId, type: 'DOCUMENT' } },
  });

  seededEnvelopeIds.push(recipient.envelopeId);

  return recipient;
};

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** V1 renders each field as a DOM element and asks for confirmation on Complete. */
const signV1 = async (page: Page, fields: TFieldBox[]) => {
  await expect(page.getByRole('heading', { name: 'Sign Document' })).toBeVisible({ timeout: 30_000 });

  await signSignaturePad(page);

  for (const field of fields) {
    await page.locator(`#field-${field.id}`).getByRole('button').click();
    await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
};

/** V2 paints fields on a Konva canvas; aim at the middle of each field's stored box. */
const fillV2Fields = async (page: Page, fields: TFieldBox[]) => {
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

  const canvas = page.locator('.konva-container canvas').first();

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
  await page.getByRole('button', { name: 'Next' }).click();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  for (const field of fields) {
    const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
    const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

    await canvas.click({ position: { x, y } });
    await page.waitForTimeout(500);
  }

  await expect(page.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });
};

/** Complete, fill the visitor email when a direct link asks for it, then confirm with Sign. */
const confirmV2 = async (page: Page, directEmail?: string) => {
  await page.getByRole('button', { name: 'Complete' }).first().click();
  await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();

  if (directEmail) {
    await page.getByRole('textbox', { name: 'Your Email' }).fill(directEmail);
  }

  await page.getByRole('button', { name: 'Sign', exact: true }).click();
};

const signV2 = async (page: Page, fields: TFieldBox[]) => {
  await fillV2Fields(page, fields);
  await confirmV2(page);
};

const signAt = async (page: Page, internalVersion: 1 | 2, token: string, fields: TFieldBox[]) => {
  await page.goto(`/sign/${token}`);

  if (internalVersion === 1) {
    await signV1(page, fields);
  } else {
    await signV2(page, fields);
  }
};

/** K4: a V1 direct template, as e2e/recipient/redirect-url-after-signing.spec.ts submits it. */
const submitDirectV1 = async (page: Page, directToken: string, signerEmail: string, fields: TFieldBox[]) => {
  const signatureField = fields[0];

  if (!signatureField) {
    throw new Error('Expected the seeded direct template to have a signature field');
  }

  await page.goto(formatDirectTemplatePath(directToken));
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible({ timeout: 30_000 });

  await page.waitForTimeout(100);
  await page.getByPlaceholder('name@example.com').fill(signerEmail);
  await page.getByRole('button', { name: 'Continue' }).click();

  await signSignaturePad(page);
  await page.locator(`#field-${signatureField.id}`).getByRole('button').click();
  await expect(page.locator(`#field-${signatureField.id}`)).toHaveAttribute('data-inserted', 'true');

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();
};

/** K3: a V2 direct template outside an embed. */
const submitDirectV2 = async (page: Page, directToken: string, signerEmail: string, fields: TFieldBox[]) => {
  await page.goto(formatDirectTemplatePath(directToken));
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('textbox', { name: 'Full Name' }).fill('Direct Signer');

  await fillV2Fields(page, fields);
  await confirmV2(page, signerEmail);
};

const submitDirect = async (
  page: Page,
  internalVersion: 1 | 2,
  directToken: string,
  signerEmail: string,
  fields: TFieldBox[],
) => {
  if (internalVersion === 1) {
    await submitDirectV1(page, directToken, signerEmail, fields);
  } else {
    await submitDirectV2(page, directToken, signerEmail, fields);
  }
};

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

const COMPLETE_PATH = /^\/sign\/[^/]+\/complete$/;

/**
 * Waits until the browser is on a signing complete page or has left the app's origin, then
 * watches for SETTLE_MS more so a late automatic redirect is caught.
 */
const waitForLanding = async (page: Page) => {
  await page.waitForURL((url) => url.origin !== APP_ORIGIN || COMPLETE_PATH.test(url.pathname), {
    timeout: 60_000,
  });

  await page.waitForTimeout(SETTLE_MS);
};

const expectOnCompletePage = (page: Page, token: string, evidence: string) => {
  const landed = new URL(page.url());

  expect(landed.origin, `the browser stays on the app's origin; it is on ${page.url()}\n${evidence}`).toBe(APP_ORIGIN);
  expect(landed.pathname, `the browser is on the signing complete page; it is on ${page.url()}`).toBe(
    `/sign/${token}/complete`,
  );
};

const describeHits = (destination: TDestination) => `destination hits: ${JSON.stringify(destination.hits)}`;

/** R1 core: on the complete page, no request reached the destination, and Continue carries the URL. */
const expectInterstitialBeforeClick = async (
  page: Page,
  token: string,
  destination: TDestination,
  redirectUrl: string,
) => {
  expectOnCompletePage(page, token, describeHits(destination));

  expect(destination.hits, 'no request reached the destination before the signer clicked').toEqual([]);

  await expect(continueLink(page), 'the complete page offers Continue to the stored URL').toHaveAttribute(
    'href',
    new URL(redirectUrl).href,
  );
};

/** R7 core: the complete page has no Continue block. */
const expectNoInterstitial = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible({ timeout: 30_000 });
  await expect(continueLink(page)).toHaveCount(0);
  await expect(interstitialNotice(page)).toHaveCount(0);
};

/** GET /sign/<token> without following redirects: a redirect must resolve to the complete page. */
const expectLoaderDoesNotRedirectOut = async (page: Page, token: string) => {
  const res = await page.request.get(`${WEBAPP_URL}/sign/${token}`, { maxRedirects: 0 });
  const location = res.headers().location;
  const details = `status ${res.status()}, Location ${JSON.stringify(location)}`;

  if (res.status() >= 300 && res.status() < 400) {
    const resolved = new URL(location ?? '', WEBAPP_URL);

    expect(resolved.origin, `the loader redirects on the app's origin: ${details}`).toBe(APP_ORIGIN);
    expect(resolved.pathname, `the loader redirects to the complete page: ${details}`).toBe(`/sign/${token}/complete`);
  } else {
    expect(res.status(), `the loader renders the page itself: ${details}`).toBe(200);
  }
};

// ---------------------------------------------------------------------------
// R1: no automatic navigation, one test per sink
// ---------------------------------------------------------------------------

test.describe('R1 no automatic navigation', () => {
  for (const [sink, internalVersion] of [
    ['K1', 1],
    ['K2', 2],
  ] as const) {
    test(`R1 ${sink} V${internalVersion} signing lands on the complete page and asks nothing of the destination`, async ({
      page,
    }) => {
      const destination = await startDestination();
      const redirectUrl = `${destination.origin}/thanks?x=1&n=${nanoid()}`;
      const { recipient } = await seedSigner(internalVersion, redirectUrl);

      await signAt(page, internalVersion, recipient.token, recipient.fields);
      await waitForLanding(page);

      await expectInterstitialBeforeClick(page, recipient.token, destination, redirectUrl);
    });
  }

  for (const [sink, internalVersion] of [
    ['K3', 2],
    ['K4', 1],
  ] as const) {
    test(`R1 ${sink} V${internalVersion} direct-template submission lands on the complete page`, async ({ page }) => {
      const destination = await startDestination();
      const redirectUrl = `${destination.origin}/thanks?x=1&n=${nanoid()}`;
      const { team, template, signerEmail } = await seedDirect(internalVersion, redirectUrl);

      await submitDirect(page, internalVersion, template.directLink?.token ?? '', signerEmail, template.fields);
      await waitForLanding(page);

      const signer = await findDirectSigner(team.id, signerEmail);

      await expectInterstitialBeforeClick(page, signer.token, destination, redirectUrl);
    });
  }

  for (const [sink, internalVersion] of [
    ['K5', 1],
    ['K6', 2],
  ] as const) {
    test(`R1 ${sink} V${internalVersion} reopening the signing link after signing lands on the complete page`, async ({
      page,
    }) => {
      const destination = await startDestination();
      const redirectUrl = `${destination.origin}/thanks?x=1&n=${nanoid()}`;
      const { recipient } = await seedSignedSigner(internalVersion, redirectUrl);

      await expectLoaderDoesNotRedirectOut(page, recipient.token);

      await visit(page, `/sign/${recipient.token}`);
      await waitForLanding(page);

      await expectInterstitialBeforeClick(page, recipient.token, destination, redirectUrl);
    });
  }
});

// ---------------------------------------------------------------------------
// R2: the page names the destination host the browser resolves
// ---------------------------------------------------------------------------

type THostCase = {
  name: string;
  redirectUrl: string;
  expectedHost: string;
  /** An element whose whole text is this must not exist. */
  forbiddenExactText?: string;
  /** No visible text may contain this. */
  forbiddenText?: string;
};

const HOST_CASES: THostCase[] = [
  { name: 'plain https', redirectUrl: 'https://partner.example/thanks?x=1', expectedHost: 'partner.example' },
  {
    name: 'userinfo',
    redirectUrl: 'https://sign.example.com@evil.example/',
    expectedHost: 'evil.example',
    forbiddenExactText: 'sign.example.com',
  },
  {
    name: 'IDN look-alike',
    redirectUrl: 'https://tеrrapay.com/',
    expectedHost: new URL('https://tеrrapay.com/').host,
    forbiddenText: 'tеrrapay.com',
  },
  {
    name: 'backslash',
    redirectUrl: 'https://evil.example\\@sign.example.com/',
    expectedHost: new URL('https://evil.example\\@sign.example.com/').host,
    forbiddenExactText: 'sign.example.com',
  },
  {
    name: 'uppercase scheme and host with port',
    redirectUrl: 'HTTPS://Partner.Example:8443/',
    expectedHost: 'partner.example:8443',
  },
  { name: 'http', redirectUrl: 'http://partner.example/thanks?x=1', expectedHost: 'partner.example' },
];

test.describe('R2 the page names the destination', () => {
  for (const hostCase of HOST_CASES) {
    test(`R2 ${hostCase.name}: the visible host equals the Continue link's anchor.host`, async ({ page, request }) => {
      const external = await stubExternalHosts(page);
      const { recipient, internalVersion } = await apiSeedSignerWithRedirect(request, hostCase.redirectUrl);

      await signAt(page, internalVersion, recipient.token, recipient.fields);
      await waitForLanding(page);

      expectOnCompletePage(page, recipient.token, `external requests: ${JSON.stringify(external)}`);
      expect(external, 'no request reached the destination before the signer clicked').toEqual([]);

      const link = continueLink(page);

      await expect(link).toBeVisible();
      await expect(interstitialNotice(page)).toBeVisible();

      const anchor = await link.evaluate((element) => {
        const a = element as HTMLAnchorElement;

        return { host: a.host, href: a.href };
      });

      expect(anchor.host, 'premise: the browser resolves the host the WHATWG parser does').toBe(hostCase.expectedHost);

      await expect(hostLabel(page, anchor.host), `the host ${anchor.host} is visible`).toBeVisible();
      await expect(fullUrlLine(page, anchor.href), `the full URL ${anchor.href} is visible`).toBeVisible();

      if (hostCase.forbiddenExactText) {
        await expect(page.getByText(hostCase.forbiddenExactText, { exact: true })).toHaveCount(0);
      }

      if (hostCase.forbiddenText) {
        await expect(page.getByText(hostCase.forbiddenText)).toHaveCount(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// R2b: base-dependent forms resolve with no base, never against the app page
// ---------------------------------------------------------------------------

/** http equivalents, since the local app runs on http and the scheme must match the page's to be base-dependent. */
const BASE_DEPENDENT_VALUES = ['http:partner.example/x', 'http:/partner.example/y', 'HTTP:partner.example'];

test.describe('R2b base-dependent forms', () => {
  for (const value of BASE_DEPENDENT_VALUES) {
    test(`R2b stored ${JSON.stringify(value)}: Continue is absolute and goes to partner.example`, async ({ page }) => {
      expect(isValidRedirectUrl(value), 'premise: the validator accepts the value').toBe(true);

      const expected = new URL(value);

      expect(expected.host, 'premise: with no base the WHATWG parser resolves partner.example').toBe('partner.example');

      const external = await stubExternalHosts(page);
      const { recipient } = await seedSignedSigner(2, value);

      await page.goto(`/sign/${recipient.token}/complete`);
      await page.waitForTimeout(SETTLE_MS);

      expectOnCompletePage(page, recipient.token, `external requests: ${JSON.stringify(external)}`);
      expect(external, 'no request reached the destination before the signer clicked').toEqual([]);

      const link = continueLink(page);

      await expect(link, 'the Continue href is the absolute URL').toHaveAttribute('href', expected.href);

      const anchor = await link.evaluate((element) => (element as HTMLAnchorElement).host);

      expect(anchor, 'the browser resolves the link to partner.example').toBe('partner.example');
      await expect(hostLabel(page, anchor), 'the visible host equals anchor.host').toBeVisible();

      await link.click();
      await page.waitForURL((url) => url.hostname === 'partner.example', { timeout: 30_000 });

      expect(page.url(), 'Continue went to partner.example, not to a path on the app').toBe(expected.href);
    });
  }
});

// ---------------------------------------------------------------------------
// R3: Continue goes exactly there
// ---------------------------------------------------------------------------

test.describe('R3 Continue goes exactly there', () => {
  test('R3 Continue navigates the top window to the stored URL with no token in the Referer', async ({
    page,
    request,
  }) => {
    const destination = await startDestination();
    const redirectUrl = `${destination.origin}/After/Signing?x=1&q=a%20b&n=${nanoid()}#done`;
    const { recipient, internalVersion } = await apiSeedSignerWithRedirect(request, redirectUrl);

    await signAt(page, internalVersion, recipient.token, recipient.fields);
    await waitForLanding(page);

    await expectInterstitialBeforeClick(page, recipient.token, destination, redirectUrl);

    const popups: string[] = [];

    page.context().on('page', (opened) => {
      popups.push(opened.url());
    });

    const expected = new URL(redirectUrl);

    await continueLink(page).click();
    await page.waitForURL((url) => url.origin === destination.origin, { timeout: 30_000 });

    expect(page.url(), 'the top window is on the stored URL').toBe(expected.href);
    expect(popups, 'Continue opened no other window').toEqual([]);

    await expect.poll(() => destination.hits.length, { timeout: 10_000 }).toBeGreaterThan(0);

    const [hit] = destination.hits;

    expect(hit.url, 'the destination received the stored path and query').toBe(
      `${expected.pathname}${expected.search}`,
    );
    expect(hit.referer ?? '', `the Referer carries no signing token: ${JSON.stringify(hit.referer)}`).not.toContain(
      recipient.token,
    );
  });
});

// ---------------------------------------------------------------------------
// R4: only after signing
// ---------------------------------------------------------------------------

const R4_URL = 'https://partner.example/r4-thanks';

const documentTitle = (page: Page, title: string) => page.getByText(title).first();

const rejectedHeading = (page: Page) => page.getByRole('heading', { name: 'Document Rejected' });

/**
 * Absence of the block proves nothing on an error page, so the navigation must have answered 200 and the
 * page must show a stable element (the document title, or the rejected page's heading) before the absence
 * checks run.
 */
const expectNoDestinationShown = async (
  page: Page,
  external: string[],
  response: Response | null,
  rendered: Locator,
) => {
  expect(response?.status(), `the navigation to ${page.url()} answered 200`).toBe(200);
  await expect(rendered, 'the page rendered its stable element').toBeVisible({
    timeout: 30_000,
  });

  test.info().annotations.push({
    type: 'headings',
    description: JSON.stringify(await page.getByRole('heading').allInnerTexts()),
  });

  expect(
    new URL(page.url()).origin,
    `the browser stays on the app's origin; it is on ${page.url()}; external requests ${JSON.stringify(external)}`,
  ).toBe(APP_ORIGIN);
  expect(external, 'no request went to the destination').toEqual([]);

  await expect(continueLink(page)).toHaveCount(0);
  await expect(interstitialNotice(page)).toHaveCount(0);
  await expect(page.getByText('partner.example')).toHaveCount(0);
};

/**
 * A completed document whose signer and second recipient (of the given role) are both SIGNED, with R4_URL
 * stored. Production creates CC recipients already SIGNED; a VIEWER or APPROVER is SIGNED once they act.
 */
const seedCompletedWithRole = async (internalVersion: 1 | 2, role: RecipientRole) => {
  const { user, team } = await seedUser();

  seededTeamIds.push(team.id);

  const signerEmail = seedTestEmail();
  const otherEmail = seedTestEmail();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [signerEmail, otherEmail],
    recipientsCreateOptions: [{}, { role }],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion, title: `Redirect interstitial ${role} ${nanoid()}` },
  });

  seededEnvelopeIds.push(document.id);

  await setRedirectUrl(document.documentMetaId, R4_URL);

  // The seed does not promise the order it returns recipients in, so find each by email.
  const signer = recipients.find((recipient) => recipient.email === signerEmail);
  const other = recipients.find((recipient) => recipient.email === otherEmail);

  if (!signer || !other) {
    throw new Error('premise: the seed returned both recipients');
  }

  expect(other.role, 'premise: the second recipient has the role under test').toBe(role);

  await prisma.recipient.updateMany({
    where: { id: { in: [signer.id, other.id] } },
    data: { signingStatus: SigningStatus.SIGNED, signedAt: outsideSweepWindow() },
  });
  await prisma.envelope.update({
    where: { id: document.id },
    data: { status: DocumentStatus.COMPLETED, completedAt: new Date() },
  });

  return { document, signer, other };
};

test.describe('R4 only after signing', () => {
  test('R4 an unsigned recipient on /sign/<token>/complete sees no destination', async ({ page }) => {
    const external = await stubExternalHosts(page);
    const { document, recipient } = await seedSigner(2, R4_URL);

    const response = await page.goto(`/sign/${recipient.token}/complete`);
    await page.waitForTimeout(SETTLE_MS);

    await expectNoDestinationShown(page, external, response, documentTitle(page, document.title));
  });

  test('R4 a rejected recipient sees no destination on the rejected page', async ({ page }) => {
    const external = await stubExternalHosts(page);
    const { recipient } = await seedSigner(2, R4_URL);

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { signingStatus: SigningStatus.REJECTED, signedAt: outsideSweepWindow(), rejectionReason: 'R4' },
    });

    const viaLink = await visit(page, `/sign/${recipient.token}`);
    await page.waitForTimeout(SETTLE_MS);

    expect(new URL(page.url()).pathname).toBe(`/sign/${recipient.token}/rejected`);
    await expectNoDestinationShown(page, external, viaLink, rejectedHeading(page));

    const direct = await page.goto(`/sign/${recipient.token}/rejected`);
    await page.waitForTimeout(SETTLE_MS);

    await expectNoDestinationShown(page, external, direct, rejectedHeading(page));
  });

  for (const internalVersion of [1, 2] as const) {
    test(`R4 a CC recipient of a V${internalVersion} document, seeded SIGNED, sees no destination`, async ({
      page,
    }) => {
      const external = await stubExternalHosts(page);
      const { document, other } = await seedCompletedWithRole(internalVersion, RecipientRole.CC);

      const viaLink = await visit(page, `/sign/${other.token}`);
      await page.waitForTimeout(SETTLE_MS);

      test.info().annotations.push({ type: 'R4 CC lands on', description: page.url() });
      await expectNoDestinationShown(page, external, viaLink, documentTitle(page, document.title));

      const direct = await page.goto(`/sign/${other.token}/complete`);
      await page.waitForTimeout(SETTLE_MS);

      await expectNoDestinationShown(page, external, direct, documentTitle(page, document.title));
    });
  }

  for (const role of [RecipientRole.VIEWER, RecipientRole.APPROVER] as const) {
    test(`R4 a ${role} recipient who completed their action gets the Continue block`, async ({ page }) => {
      const external = await stubExternalHosts(page);
      const { other } = await seedCompletedWithRole(2, role);

      await page.goto(`/sign/${other.token}/complete`);
      await page.waitForTimeout(SETTLE_MS);

      expect(new URL(page.url()).origin, `it is on ${page.url()}`).toBe(APP_ORIGIN);
      expect(external, 'no request went to the destination before a click').toEqual([]);

      await expect(continueLink(page)).toHaveAttribute('href', new URL(R4_URL).href);
      await expect(interstitialNotice(page)).toBeVisible();
      await expect(hostLabel(page, new URL(R4_URL).host)).toBeVisible();
    });
  }
});

// ---------------------------------------------------------------------------
// R5: invalid stored values show nothing
// ---------------------------------------------------------------------------

const INVALID_VALUES = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,x',
  'https://a.example/\tx',
  'https://a.example/\nx',
  '//evil.example',
  '',
];

test.describe('R5 invalid stored values show nothing', () => {
  for (const value of INVALID_VALUES) {
    test(`R5 stored ${JSON.stringify(value)} shows no destination and never navigates away`, async ({ page }) => {
      const external = await stubExternalHosts(page);
      const { recipient } = await seedSignedSigner(2, value);

      const response = await visit(page, `/sign/${recipient.token}`);
      await waitForLanding(page);

      expectOnCompletePage(page, recipient.token, `external requests: ${JSON.stringify(external)}`);
      expect(external, 'no request left the app').toEqual([]);

      expect(response?.url() ? new URL(response.url()).pathname : null, 'the navigation ended on /complete').toBe(
        `/sign/${recipient.token}/complete`,
      );
      expect(response?.status(), 'the /complete navigation answered 200').toBe(200);
      await expectNoInterstitial(page);
      await expect(continueLink(page)).toHaveCount(0);
      await expect(interstitialNotice(page)).toHaveCount(0);
      await expect(page.getByText(/a\.example|evil\.example/)).toHaveCount(0);
    });
  }

  test('R5 a percent-encoded CRLF is a normal URL: shown with its host, href normalised', async ({ page }) => {
    const value = 'https://a.example/%0d%0aSet-Cookie:x';
    const expected = new URL(value);
    const external = await stubExternalHosts(page);
    const { recipient } = await seedSignedSigner(2, value);

    await visit(page, `/sign/${recipient.token}`);
    await waitForLanding(page);

    expectOnCompletePage(page, recipient.token, `external requests: ${JSON.stringify(external)}`);
    expect(external, 'no automatic navigation: no request left the app').toEqual([]);

    await expect(continueLink(page)).toBeVisible();
    await expect(continueLink(page)).toHaveAttribute('href', expected.href);
    await expect(interstitialNotice(page)).toBeVisible();
    await expect(hostLabel(page, expected.host)).toBeVisible();
    await expect(fullUrlLine(page, expected.href)).toBeVisible();
  });

  for (const [internalVersion, value] of [
    [1, 'JaVaScRiPt:alert(1)'],
    [2, ' javascript:alert(1)'],
  ] as const) {
    test(`R5 V${internalVersion} real signing with stored ${JSON.stringify(value)} stays and shows nothing`, async ({
      page,
    }) => {
      const external = await stubExternalHosts(page);
      const { recipient } = await seedSigner(internalVersion, value);

      await signAt(page, internalVersion, recipient.token, recipient.fields);
      await waitForLanding(page);

      expectOnCompletePage(page, recipient.token, `external requests: ${JSON.stringify(external)}`);
      await expectNoInterstitial(page);
    });
  }
});

// ---------------------------------------------------------------------------
// R6: no request-borne destination
// ---------------------------------------------------------------------------

const R6_STORED = 'https://partner.example/thanks?x=1';

const R6_SUFFIXES = [
  '?redirectUrl=https://evil.example/',
  '?to=https://evil.example/',
  '?returnTo=https://evil.example/',
  '?next=https://evil.example/',
  '#https://evil.example',
];

const expectNoEvilDestination = async (page: Page, external: string[]) => {
  expect(
    new URL(page.url()).origin,
    `the browser stays on the app's origin; it is on ${page.url()}; external requests ${JSON.stringify(external)}`,
  ).toBe(APP_ORIGIN);
  expect(external.filter((url) => url.includes('evil.example'))).toEqual([]);

  await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
  await expect(page.getByText('evil.example')).toHaveCount(0);
};

test.describe('R6 no request-borne destination', () => {
  for (const suffix of R6_SUFFIXES) {
    test(`R6 ${suffix} on the complete page shows the stored destination, never the request's`, async ({ page }) => {
      const external = await stubExternalHosts(page);
      const { recipient } = await seedSignedSigner(2, R6_STORED);

      await page.goto(`/sign/${recipient.token}/complete${suffix}`);
      await page.waitForTimeout(SETTLE_MS);

      await expectNoEvilDestination(page, external);

      const expected = new URL(R6_STORED);

      await expect(continueLink(page)).toBeVisible();
      await expect(continueLink(page)).toHaveAttribute('href', expected.href);
      await expect(interstitialNotice(page)).toBeVisible();
      await expect(hostLabel(page, expected.host)).toBeVisible();
      await expect(fullUrlLine(page, expected.href)).toBeVisible();
    });
  }

  test('R6 ?redirectUrl= with nothing stored shows no destination', async ({ page }) => {
    const external = await stubExternalHosts(page);
    const { recipient } = await seedSignedSigner(2, null);

    const response = await page.goto(`/sign/${recipient.token}/complete?redirectUrl=https://evil.example/`);
    await page.waitForTimeout(SETTLE_MS);

    expect(response?.status(), 'the complete page answered 200').toBe(200);
    await expectNoEvilDestination(page, external);
    await expectNoInterstitial(page);
  });
});

// ---------------------------------------------------------------------------
// R7: no redirect URL, no change
// ---------------------------------------------------------------------------

test.describe('R7 no redirect URL, no change', () => {
  for (const internalVersion of [1, 2] as const) {
    test(`R7 V${internalVersion} signing with no redirect URL shows no Continue block`, async ({ page }) => {
      const { recipient } = await seedSigner(internalVersion, null);

      await signAt(page, internalVersion, recipient.token, recipient.fields);
      await waitForLanding(page);

      expectOnCompletePage(page, recipient.token, '');
      await expectNoInterstitial(page);
    });

    test(`R7 V${internalVersion} direct template with no redirect URL shows no Continue block`, async ({ page }) => {
      const { team, template, signerEmail } = await seedDirect(internalVersion, null);

      await submitDirect(page, internalVersion, template.directLink?.token ?? '', signerEmail, template.fields);
      await waitForLanding(page);

      const signer = await findDirectSigner(team.id, signerEmail);

      expectOnCompletePage(page, signer.token, '');
      await expectNoInterstitial(page);
    });

    test(`R7 V${internalVersion} reopened signing link with no redirect URL shows no Continue block`, async ({
      page,
    }) => {
      const { recipient } = await seedSignedSigner(internalVersion, null);

      await visit(page, `/sign/${recipient.token}`);
      await waitForLanding(page);

      expectOnCompletePage(page, recipient.token, '');
      await expectNoInterstitial(page);
    });
  }
});

// ---------------------------------------------------------------------------
// R8: embed unchanged
// ---------------------------------------------------------------------------

test.describe('R8 embed unchanged', () => {
  test('R8 V2 embed posts document-completed and stays on /embed/sign with a redirect URL stored', async ({ page }) => {
    const destination = await startDestination();
    const redirectUrl = `${destination.origin}/thanks?n=${nanoid()}`;
    const { recipient } = await seedSigner(2, redirectUrl);
    const embedPath = `/embed/sign/${recipient.token}`;

    const html = `<!doctype html><html><body style="margin:0">
<iframe id="embed" src="${WEBAPP_URL}${embedPath}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
  window.__messages = [];
  window.addEventListener('message', (event) => {
    window.__messages.push(JSON.parse(JSON.stringify(event.data)));
  });
</script></body></html>`;

    const host = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });

    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));

    servers.push(host);

    const hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`;

    await page.goto(hostUrl);

    const frame = page.frameLocator('#embed');

    await expect(frame.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

    const canvas = frame.locator('.konva-container canvas').first();

    await expect(canvas).toBeVisible({ timeout: 30_000 });

    await page.waitForTimeout(200);
    await frame.getByTestId('signature-pad-dialog-button').click();
    await frame.getByRole('tab', { name: 'Type' }).click();
    await frame.getByTestId('signature-pad-type-input').fill('Signature');
    await frame.getByRole('button', { name: 'Next' }).click();

    const box = await canvas.boundingBox();

    if (!box) {
      throw new Error('The embedded signing canvas has no bounding box');
    }

    for (const field of recipient.fields) {
      const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
      const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

      await canvas.click({ position: { x, y } });
      await page.waitForTimeout(500);
    }

    await expect(frame.getByText('0 Fields Remaining').first()).toBeVisible({ timeout: 10_000 });
    await frame.getByRole('button', { name: 'Complete' }).first().click();
    await expect(frame.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await frame.getByRole('button', { name: 'Sign', exact: true }).click();

    const completions = async () =>
      (await page.evaluate(() => (window as unknown as { __messages: { action?: string }[] }).__messages)).filter(
        (message) => message?.action === 'document-completed',
      );

    await expect.poll(async () => (await completions()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(SETTLE_MS);

    const embedFrame = page.frames().find((candidate) => candidate !== page.mainFrame());

    expect(page.url(), 'the host page is still the top window').toBe(hostUrl);
    expect(new URL(embedFrame?.url() ?? 'about:blank').pathname, 'the embed stays on /embed/sign').toBe(embedPath);
    expect(destination.hits, 'no request reached the destination').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R9: translations
// ---------------------------------------------------------------------------

/** The msgids of a gettext catalog, joining continued string lines. */
const readMsgids = (file: string) => {
  const ids = new Set<string>();
  let current: string | null = null;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('msgid ')) {
      current = JSON.parse(line.slice('msgid '.length)) as string;
      continue;
    }

    if (current !== null && line.startsWith('"')) {
      current += JSON.parse(line) as string;
      continue;
    }

    if (current !== null && current !== '') {
      ids.add(current);
    }

    current = null;
  }

  if (current) {
    ids.add(current);
  }

  return ids;
};

/** The supported locales' web.po catalogs (sq is an unsupported partial catalog; see translations-complete.test.ts). */
const catalogs = () =>
  SUPPORTED_LANGUAGE_CODES.map((locale) => ({
    locale,
    msgids: readMsgids(path.join(TRANSLATIONS_DIR, locale, 'web.po')),
  }));

test.describe('R9 translations', () => {
  test('R9 every interstitial message is a msgid in every supported catalog', () => {
    const missing = catalogs().flatMap(({ locale, msgids }) =>
      INTERSTITIAL_MESSAGES.filter((message) => !msgids.has(message)).map((message) => `${locale}: ${message}`),
    );

    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R11, R12: deleted documents and expired recipients show nothing
// ---------------------------------------------------------------------------

test.describe('R11 R12 no destination for deleted documents or expired recipients', () => {
  test('R11 a signed recipient of a soft-deleted document sees no destination on /complete', async ({ page }) => {
    const external = await stubExternalHosts(page);
    const { document, recipient } = await seedSignedSigner(2, R4_URL);

    expect(isValidRedirectUrl(R4_URL), 'premise: the stored URL is valid').toBe(true);

    await prisma.envelope.update({ where: { id: document.id }, data: { deletedAt: new Date() } });

    const response = await visit(page, `/sign/${recipient.token}/complete`);
    await page.waitForTimeout(SETTLE_MS);

    await expectNoDestinationShown(page, external, response, documentTitle(page, document.title));
  });

  test('R12 an expired SIGNED recipient opened at /complete sees no destination', async ({ page }) => {
    const external = await stubExternalHosts(page);
    const { document, recipient } = await seedSignedSigner(2, R4_URL);

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const response = await visit(page, `/sign/${recipient.token}/complete`);
    await page.waitForTimeout(SETTLE_MS);

    await expectNoDestinationShown(page, external, response, documentTitle(page, document.title));
  });
});

// ---------------------------------------------------------------------------
// R13: same-origin destination sends no Referer with the token
// ---------------------------------------------------------------------------

test.describe('R13 same-origin Referer', () => {
  test('R13 Continue to a same-origin URL sends no Referer containing the signing token', async ({ page }) => {
    const marker = nanoid();
    const redirectUrl = `${APP_ORIGIN}/robots.txt?n=${marker}`;
    const { recipient } = await seedSignedSigner(2, redirectUrl);

    await page.goto(`/sign/${recipient.token}/complete`);

    const link = continueLink(page);

    await expect(link).toHaveAttribute('href', new URL(redirectUrl).href);

    const [request] = await Promise.all([
      page.waitForRequest((candidate) => candidate.url().includes(`robots.txt?n=${marker}`), { timeout: 30_000 }),
      link.click(),
    ]);

    const referer = (await request.headerValue('referer')) ?? '';

    expect(request.isNavigationRequest(), 'Continue navigated the top window').toBe(true);
    expect(referer.includes(recipient.token), 'the Referer carries no signing token').toBe(false);
  });
});
