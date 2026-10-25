/**
 * After signing, the browser follows a stored redirect URL only when it is http or https.
 *
 * Written from the specification before the fix, without reading
 * the signing pages' redirect code. The redirect URL is written straight into
 * the document's meta through prisma, as a value stored before the API fix
 * would be. Every assertion is on what the browser did: its URL, the frames it
 * navigated, the console messages and CSP violation events it raised, and a
 * marker the `javascript:` URL would set if it ran.
 *
 * | Test                                                                 | Criterion |
 * | -------------------------------------------------------------------- | --------- |
 * | C3 <page> does not follow a stored javascript: URL [x2]               | C3        |
 * | C3 <page> does not follow a stored data: URL [x2]                     | C3        |
 * | C4 <page> offers Continue to a stored app-origin URL [x2] (#186)      | C4        |
 * | C5 <document> reopened after signing never redirects to <scheme> [x4]| C5        |
 * | C5 <document> reopened after signing offers Continue to it [x2]      | C5        |
 * | C7 direct-template submission drops / keeps the template's URL [x2]  | C7        |
 *
 * C5 fetches /sign/<token> through a request context with maxRedirects: 0 and
 * reads the Location header of the loader's redirect. C7 here covers the
 * direct-template half of the criterion (the v1 and duplicate halves are in
 * e2e/api/v1/redirect-url-scheme.spec.ts) and asserts only on the stored row.
 *
 * Pages: the v1 signing page view (internalVersion 1) and the envelope signing
 * completion dialog (internalVersion 2), both reached at /sign/<token>.
 *
 * Detection of an attempt. Chromium neither navigates nor fires framenavigated
 * when a CSP blocks a `javascript:` URL or when it refuses a top-level `data:`
 * navigation; it logs a console message and, for the CSP, dispatches a
 * securitypolicyviolation event. Those, plus any framenavigated to a
 * javascript: or data: URL, count as an attempt. A CSP-blocked javascript:
 * URL reports `script-src-elem blocked inline` with an empty sample, so any
 * inline-script violation raised after the Sign click counts as well.
 *
 * Timing. The redirect fires some time after the recipient's row reads SIGNED;
 * a fixed three-second wait let one red run pass the v1 javascript: case with
 * no evidence, while a rerun of the same case caught it. Each C3 test now
 * watches for ten seconds after the row reads SIGNED and stops early at the
 * first sign of an attempt.
 *
 * C4 uses the app's own origin (http under the local server), so it does not
 * depend on an outside site. Since #186 no redirect is followed automatically:
 * C4 and the C5 control assert that the browser lands on /sign/<token>/complete
 * and that its Continue link carries the stored URL as `new URL(stored).href`.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';

import { outsideSweepWindow } from '../fixtures/reject-seal';
import { signSignaturePad } from '../fixtures/signature';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();
const APP_ORIGIN = new URL(WEBAPP_URL).origin;
const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/** Console text Chromium logs when it blocks a javascript: URL or a top-level data: navigation. */
const BLOCKED_ATTEMPT_PATTERN =
  /Running the JavaScript URL violates|Refused to run the JavaScript URL|Refused to execute.*javascript:|Not allowed to navigate top frame to data URL/i;

/** The CSP report a blocked javascript: navigation raises: an inline script-src violation. */
const INLINE_SCRIPT_VIOLATION_PATTERN = /^script-src(-elem)?\b.*blocked inline/i;

/** How long a C3 test watches for a redirect attempt after the recipient's row reads SIGNED. */
const ATTEMPT_WATCH_MS = 10_000;

/** A console line or CSP report that names the redirect URL itself. Unrelated CSP noise does not match. */
const NAMES_REDIRECT_PATTERN = /javascript:|data:text\/html|__redirected/i;

type TFieldBox = { id: number; positionX: unknown; positionY: unknown; width: unknown; height: unknown };

type Evidence = {
  navigations: string[];
  consoleMessages: string[];
  cspViolations: string[];
  pageErrors: string[];
};

type SigningPage = {
  name: string;
  internalVersion: 1 | 2;
  /** Inserts every field and confirms; returns once the final Sign click is made. */
  sign: (page: Page, fields: TFieldBox[]) => Promise<void>;
};

/** v1 renders each field as a DOM element and asks for confirmation on Complete. */
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

/** v2 paints fields on a Konva canvas; completion goes through the envelope signing dialog. */
const signV2 = async (page: Page, fields: TFieldBox[]) => {
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

  await page.getByRole('button', { name: 'Complete' }).first().click();
  await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
};

const SIGNING_PAGES: SigningPage[] = [
  { name: 'v1 signing page view', internalVersion: 1, sign: signV1 },
  { name: 'envelope signing completion dialog', internalVersion: 2, sign: signV2 },
];

/** Documents the running test seeded; any its signing leaves PENDING are deleted after it (#177). */
const seededByTest: string[] = [];

test.afterEach(async () => {
  await prisma.envelope.updateMany({
    where: { id: { in: seededByTest.splice(0) }, status: DocumentStatus.PENDING },
    data: { deletedAt: new Date() },
  });
});

/** A pending single-signer document whose meta carries the given redirect URL. */
const seedSignerWithRedirect = async (internalVersion: 1 | 2, redirectUrl: string) => {
  const { user, team } = await seedUser();

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: [seedTestEmail()],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion, title: `Redirect after signing ${nanoid()}` },
  });

  seededByTest.push(document.id);

  await prisma.documentMeta.update({ where: { id: document.documentMetaId }, data: { redirectUrl } });

  const stored = await prisma.documentMeta.findUniqueOrThrow({ where: { id: document.documentMetaId } });

  expect(stored.redirectUrl, 'premise: the redirect URL is stored on the document').toBe(redirectUrl);

  return { recipient: recipients[0] };
};

/** Starts recording navigations, console messages, page errors and CSP violation events. */
const recordEvidence = async (page: Page): Promise<Evidence> => {
  const evidence: Evidence = { navigations: [], consoleMessages: [], cspViolations: [], pageErrors: [] };

  await page.exposeFunction('__reportCspViolation', (description: string) => {
    evidence.cspViolations.push(description);
  });

  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __reportCspViolation: (d: string) => void }).__reportCspViolation;

      void report(`${event.violatedDirective} blocked ${event.blockedURI} (sample: ${event.sample})`);
    });
  });

  page.on('framenavigated', (frame) => {
    evidence.navigations.push(frame.url());
  });

  page.on('console', (message) => {
    evidence.consoleMessages.push(`[${message.type()}] ${message.text()}`);
  });

  page.on('pageerror', (error) => {
    evidence.pageErrors.push(error.message);
  });

  return evidence;
};

const waitForRecipientSigned = async (recipientId: number) => {
  await expect
    .poll(async () => (await prisma.recipient.findUniqueOrThrow({ where: { id: recipientId } })).signingStatus, {
      timeout: 30_000,
    })
    .toBe(SigningStatus.SIGNED);
};

const describeEvidence = (evidence: Evidence) => JSON.stringify(evidence, null, 2);

/** Everything in the evidence that counts as a redirect attempt, given where the Sign click began. */
const attemptsIn = (evidence: Evidence, cspFrom: number) => ({
  navigations: evidence.navigations.filter((url) => /^\s*(javascript|data):/i.test(url)),
  cspViolations: evidence.cspViolations
    .slice(cspFrom)
    .filter((violation) => NAMES_REDIRECT_PATTERN.test(violation) || INLINE_SCRIPT_VIOLATION_PATTERN.test(violation)),
  consoleMessages: evidence.consoleMessages.filter(
    (message) => BLOCKED_ATTEMPT_PATTERN.test(message) || NAMES_REDIRECT_PATTERN.test(message),
  ),
});

const hasAttempt = (evidence: Evidence, cspFrom: number) =>
  Object.values(attemptsIn(evidence, cspFrom)).some((found) => found.length > 0);

/** Watches for up to ATTEMPT_WATCH_MS, returning as soon as an attempt shows up. */
const watchForAttempt = async (page: Page, evidence: Evidence, cspFrom: number) => {
  const deadline = Date.now() + ATTEMPT_WATCH_MS;

  while (Date.now() < deadline && !hasAttempt(evidence, cspFrom)) {
    await page.waitForTimeout(250);
  }
};

for (const signingPage of SIGNING_PAGES) {
  test.describe(signingPage.name, () => {
    for (const scheme of ['javascript', 'data'] as const) {
      /**
       * Guards C3: a stored redirect URL that is not http or https is never
       * handed to the browser after signing. The page stays on the app's
       * origin, the javascript: URL's marker is never set, and the browser
       * records no navigation, console refusal or CSP violation for it (an
       * attempt the CSP blocked still counts).
       */
      test(`C3 does not follow a stored ${scheme}: redirect URL after signing`, async ({ page }) => {
        const redirectUrl = scheme === 'javascript' ? 'javascript:window.__redirected=1' : 'data:text/html,x';
        const { recipient } = await seedSignerWithRedirect(signingPage.internalVersion, redirectUrl);
        const evidence = await recordEvidence(page);

        await page.goto(`/sign/${recipient.token}`);

        // Inline-script CSP violations count only from the signing step on.
        const cspFrom = evidence.cspViolations.length;

        await signingPage.sign(page, recipient.fields);

        await waitForRecipientSigned(recipient.id);
        await watchForAttempt(page, evidence, cspFrom);

        const details = describeEvidence(evidence);
        const attempts = attemptsIn(evidence, cspFrom);

        expect(new URL(page.url()).origin, `the page stays on the app's origin\n${details}`).toBe(APP_ORIGIN);

        expect(
          await page.evaluate(() => (window as unknown as { __redirected?: unknown }).__redirected),
          `the javascript: URL never ran\n${details}`,
        ).toBeUndefined();

        expect(attempts.navigations, `no frame navigated to a javascript: or data: URL\n${details}`).toEqual([]);
        expect(attempts.cspViolations, `no CSP violation was raised by a redirect attempt\n${details}`).toEqual([]);
        expect(attempts.consoleMessages, `the browser logged no blocked redirect attempt\n${details}`).toEqual([]);
      });
    }

    /**
     * Guards C4: the fix keeps legitimate redirects working. Since #186 a stored
     * app-origin redirect URL is offered on the complete page as a Continue link
     * rather than followed automatically.
     */
    test('C4 offers Continue to a stored app-origin redirect URL after signing', async ({ page }) => {
      const marker = `redirect-69-${nanoid()}`;
      const redirectUrl = `${APP_ORIGIN}/signin?r=${marker}`;
      const { recipient } = await seedSignerWithRedirect(signingPage.internalVersion, redirectUrl);
      const evidence = await recordEvidence(page);

      await page.goto(`/sign/${recipient.token}`);
      await signingPage.sign(page, recipient.fields);

      await page
        .waitForURL((url) => url.pathname === `/sign/${recipient.token}/complete` || url.searchParams.has('r'), {
          timeout: 30_000,
        })
        .catch((error: unknown) => {
          throw new Error(
            `the browser did not land on the complete page; it is on ${page.url()}\n${describeEvidence(evidence)}\n${String(error)}`,
          );
        });

      // A late automatic redirect would show here.
      await page.waitForTimeout(3_000);

      const landed = new URL(page.url());

      expect(landed.origin, `it is on ${page.url()}`).toBe(APP_ORIGIN);
      expect(landed.pathname, `it is on ${page.url()}`).toBe(`/sign/${recipient.token}/complete`);
      await expect(page.getByRole('link', { name: 'Continue', exact: true })).toHaveAttribute(
        'href',
        new URL(redirectUrl).href,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// C5: reopening a signed document never redirects to a stored non-http(s) URL
// ---------------------------------------------------------------------------

/** GET /sign/<token> without following redirects; returns the status and the resolved Location. */
const fetchSignRedirect = async (page: Page, token: string) => {
  const res = await page.request.get(`${WEBAPP_URL}/sign/${token}`, { maxRedirects: 0 });
  const location = res.headers().location;

  return { status: res.status(), location, resolved: location ? new URL(location, WEBAPP_URL) : null };
};

/** A recipient who has already signed a document whose meta holds the given redirect URL. */
const seedSignedRecipientWithRedirect = async (internalVersion: 1 | 2, redirectUrl: string) => {
  const { recipient } = await seedSignerWithRedirect(internalVersion, redirectUrl);

  await prisma.recipient.update({
    where: { id: recipient.id },
    data: { signingStatus: SigningStatus.SIGNED, signedAt: outsideSweepWindow() },
  });

  return recipient;
};

for (const signingPage of SIGNING_PAGES) {
  const documentKind = signingPage.internalVersion === 1 ? 'v1 document' : 'envelope (internalVersion 2)';

  test.describe(`C5 ${documentKind}`, () => {
    for (const redirectUrl of ['javascript:window.__redirected=1', 'data:text/html,x']) {
      /**
       * Guards C5: the signing page's loader, reopened by a recipient who has
       * signed, sends them to the completion page and never to a stored
       * javascript: or data: URL.
       */
      test(`C5 reopened after signing never redirects to ${redirectUrl.split(':')[0]}:`, async ({ page }) => {
        const recipient = await seedSignedRecipientWithRedirect(signingPage.internalVersion, redirectUrl);

        const { status, location, resolved } = await fetchSignRedirect(page, recipient.token);
        const details = `status ${status}, Location ${JSON.stringify(location)}`;

        expect(status, `the loader redirects: ${details}`).toBeGreaterThanOrEqual(300);
        expect(status, `the loader redirects: ${details}`).toBeLessThan(400);
        expect(location?.trim().toLowerCase().startsWith(redirectUrl.split(':')[0]), details).toBe(false);
        expect(resolved?.origin, details).toBe(APP_ORIGIN);
        expect(resolved?.pathname, details).toBe(`/sign/${recipient.token}/complete`);
      });
    }

    /**
     * Guards C5's control: since #186 the reopened signing page sends the
     * recipient to the complete page, which offers the stored app-origin URL
     * as a Continue link.
     */
    test('C5 reopened after signing offers Continue to a stored app-origin URL', async ({ page }) => {
      const redirectUrl = `${APP_ORIGIN}/signin?r=redirect-69-${nanoid()}`;
      const recipient = await seedSignedRecipientWithRedirect(signingPage.internalVersion, redirectUrl);

      const { status, location, resolved } = await fetchSignRedirect(page, recipient.token);
      const details = `status ${status}, Location ${JSON.stringify(location)}`;

      expect(status, `the loader redirects: ${details}`).toBeGreaterThanOrEqual(300);
      expect(status, `the loader redirects: ${details}`).toBeLessThan(400);
      expect(resolved?.origin, details).toBe(APP_ORIGIN);
      expect(resolved?.pathname, details).toBe(`/sign/${recipient.token}/complete`);

      await page.goto(`/sign/${recipient.token}/complete`);
      await expect(page.getByRole('link', { name: 'Continue', exact: true })).toHaveAttribute(
        'href',
        new URL(redirectUrl).href,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// C7: a direct-template submission drops a stored non-http(s) redirect URL
// ---------------------------------------------------------------------------

/** Submits a v1 direct template as a new signer and returns the created document's stored redirect URL. */
const submitDirectTemplate = async (page: Page, templateRedirectUrl: string) => {
  const { user, team } = await seedUser();

  const template = await seedDirectTemplate({
    title: `Redirect direct template ${nanoid()}`,
    userId: user.id,
    teamId: team.id,
  });

  await prisma.documentMeta.update({
    where: { id: template.documentMetaId },
    data: { redirectUrl: templateRedirectUrl },
  });

  const signatureField = template.fields[0];

  if (!signatureField) {
    throw new Error('Expected the seeded direct template to have a signature field');
  }

  const signerEmail = seedTestEmail();

  await page.goto(formatDirectTemplatePath(template.directLink?.token ?? ''));
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();

  await page.waitForTimeout(100);
  await page.getByPlaceholder('name@example.com').fill(signerEmail);
  await page.getByRole('button', { name: 'Continue' }).click();

  await signSignaturePad(page);
  await page.locator(`#field-${signatureField.id}`).getByRole('button').click();
  await expect(page.locator(`#field-${signatureField.id}`)).toHaveAttribute('data-inserted', 'true');

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.getByRole('button', { name: 'Sign' }).click();

  // The page may then try the redirect; only the stored row matters here.
  const findCreated = async () =>
    await prisma.envelope.findFirst({
      where: { teamId: team.id, type: 'DOCUMENT', recipients: { some: { email: signerEmail } } },
      include: { documentMeta: true },
    });

  await expect.poll(async () => Boolean(await findCreated()), { timeout: 30_000 }).toBe(true);

  return (await findCreated())?.documentMeta?.redirectUrl;
};

test.describe('C7 direct-template submission', () => {
  /**
   * Guards C7: a javascript: redirect URL stored on a template before the fix
   * is not copied into the document a direct-link signer creates.
   */
  test('C7 direct-template submission drops a stored javascript: redirect URL', async ({ page }) => {
    const stored = await submitDirectTemplate(page, 'javascript:alert(1)');

    expect(stored ?? '', 'the created document stores no redirect URL').toBe('');
  });

  /**
   * Guards C7's control: an https redirect URL on the template is carried over.
   */
  test('C7 direct-template submission carries a stored https redirect URL over', async ({ page }) => {
    const httpsUrl = `https://example.com/direct-${nanoid()}`;

    expect(await submitDirectTemplate(page, httpsUrl)).toBe(httpsUrl);
  });
});
