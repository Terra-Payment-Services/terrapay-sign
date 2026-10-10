import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The document lifecycle, exercised against a deployed instance through the
 * public API.
 *
 * The other remote specs assert that the instance is up and that its public
 * surface is shut. None of them creates a document, so the thing the product
 * exists to do reaches production covered only by specs that seed the database
 * directly and cannot be pointed at a URL.
 *
 * This one uploads a PDF, puts a signature field on it for a recipient, sends
 * it, and checks the recipient's signing page actually renders for the token
 * the API handed back. It cleans up after itself, because it runs against a
 * real instance.
 *
 * What it deliberately stops short of: performing the signing ceremony and
 * asserting the sealed PDF carries a CMS signature. That is the assertion worth
 * having, and it needs the V2 signing interaction, which drives fields through
 * dialogs rather than by clicking the field on the page the way the V1 specs do.
 * Working that out is the next step, not something to leave here half-written.
 *
 * Needs an API token for the target instance in E2E_REMOTE_API_TOKEN. That is a
 * credential, so it belongs in AWS Secrets Manager and is read into the job's
 * environment, never into a GitLab CI/CD variable.
 */

const API = '/api/v2';

const SAMPLE_PDF = path.join(__dirname, '../../../../assets/a4-size.pdf');

/** How long to wait for the PDF page to render before aiming at a field on it. */
const PDF_RENDER_TIMEOUT_MS = 30_000;

/** Konva paints the fields a moment after the page element appears. */
const FIELD_PAINT_SETTLE_MS = 2_500;

/** How long the signing ceremony has to land on the completion page. */
const COMPLETION_TIMEOUT_MS = 30_000;

/** How long to wait for sealing. On a deployed instance it is a background job. */
const SEALING_TIMEOUT_MS = 90_000;

const authHeaders = () => ({ authorization: `Bearer ${process.env.E2E_REMOTE_API_TOKEN}` });

const createEnvelope = async (request: APIRequestContext, recipientEmail: string): Promise<{ id: string }> => {
  const payload = {
    title: `[E2E] Remote lifecycle ${Date.now()}`,
    type: 'DOCUMENT',
    recipients: [
      {
        email: recipientEmail,
        name: 'Remote Signer',
        role: 'SIGNER',
        fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 10, width: 25, height: 10 }],
      },
    ],
  };

  const response = await request.post(`${API}/envelope/create`, {
    headers: authHeaders(),
    multipart: {
      payload: JSON.stringify(payload),
      files: { name: 'a4-size.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(SAMPLE_PDF) },
    },
  });

  expect(response.status(), await response.text()).toBe(200);

  return await response.json();
};

test('[REMOTE] a document is created, signed and comes back sealed', async ({ page, request }, testInfo) => {
  testInfo.skip(
    !process.env.E2E_BASE_URL || !process.env.E2E_REMOTE_API_TOKEN,
    'needs a deployed instance and an API token for it',
  );

  testInfo.setTimeout(300_000);

  // A real send goes to this address from the live service, so it wants to be
  // a mailbox somebody owns. The default is a unique address on our own domain,
  // which does not exist and will bounce to the sending mailbox. Set
  // E2E_REMOTE_RECIPIENT to a mailbox you can read if you want to see what the
  // counterparty actually receives.
  const recipientEmail = process.env.E2E_REMOTE_RECIPIENT || `e2e-lifecycle-${Date.now()}@terrapay.com`;

  let envelopeId: string | undefined;

  try {
    const created = await createEnvelope(request, recipientEmail);

    envelopeId = created.id;

    const distributeResponse = await request.post(`${API}/envelope/distribute`, {
      headers: authHeaders(),
      data: { envelopeId: created.id },
    });

    expect(distributeResponse.status(), await distributeResponse.text()).toBe(200);

    const distributed = await distributeResponse.json();
    const [recipient] = distributed.recipients;

    expect(recipient?.signingUrl, 'distribute must return a signing URL').toBeTruthy();

    const envelope = await (await request.get(`${API}/envelope/${created.id}`, { headers: authHeaders() })).json();

    expect(envelope.status, 'a sent document should be waiting on its recipient').toBe('PENDING');
    expect(envelope.fields, 'the signature field should have been attached to the upload').toHaveLength(1);
    expect(envelope.fields[0].type).toBe('SIGNATURE');
    expect(envelope.fields[0].envelopeItemId).toBe(envelope.envelopeItems[0].id);
    expect(envelope.recipients[0].sendStatus).toBe('SENT');

    // The counterparty's view. This is the page that has to work for anyone
    // outside the company, and it is served without a session.
    await page.goto(recipient.signingUrl);

    await expect(page.getByRole('heading', { name: envelope.title })).toBeVisible();
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible();

    // The uploaded PDF has to reach the browser, or there is nothing to sign.
    const pdfPage = page.locator('.react-pdf__Page[data-page-number="1"]');

    await expect(pdfPage).toBeVisible({ timeout: PDF_RENDER_TIMEOUT_MS });

    // V2 draws its fields onto a Konva canvas rather than as DOM elements, so
    // there is no per-field selector to click. The field's stored position is a
    // percentage of the page, which is enough to aim at its middle. Clicking a
    // `#field-<id>` element is the V1 interaction and finds nothing here.
    await page.waitForTimeout(FIELD_PAINT_SETTLE_MS);

    const pageBox = await pdfPage.boundingBox();

    expect(pageBox, 'the rendered page must have a box to aim at').toBeTruthy();

    const field = envelope.fields[0];

    await page.mouse.click(
      pageBox!.x + pageBox!.width * ((Number(field.positionX) + Number(field.width) / 2) / 100),
      pageBox!.y + pageBox!.height * ((Number(field.positionY) + Number(field.height) / 2) / 100),
    );

    const signatureDialog = page.getByRole('dialog');

    await expect(signatureDialog).toBeVisible();

    await signatureDialog.getByRole('tab', { name: 'Type' }).click();
    await signatureDialog.getByTestId('signature-pad-type-input').fill('Remote Signer');
    await signatureDialog.getByRole('button', { name: 'Sign', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Complete' }).first()).toBeEnabled();

    await page.getByRole('button', { name: 'Complete' }).first().click();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();

    await page.waitForURL(/\/complete$/, { timeout: COMPLETION_TIMEOUT_MS });

    // Sealing is a background job on a deployed instance, so poll for it.
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API}/envelope/${created.id}`, { headers: authHeaders() });

          return response.ok() ? (await response.json()).status : `http ${response.status()}`;
        },
        {
          message: 'the envelope should reach COMPLETED once the sealing job has run',
          timeout: SEALING_TIMEOUT_MS,
          intervals: [1000, 2000, 5000],
        },
      )
      .toBe('COMPLETED');

    const downloadResponse = await request.get(`${API}/envelope/item/${envelope.envelopeItems[0].id}/download`, {
      headers: authHeaders(),
    });

    expect(downloadResponse.status()).toBe(200);

    // The endpoint answers with the bytes themselves rather than a link to them.
    const pdf = Buffer.from(await downloadResponse.body()).toString('latin1');

    expect(pdf.startsWith('%PDF-'), 'the download should be a PDF').toBe(true);

    // The assertion the whole product rests on. A COMPLETED status only says the
    // workflow finished. These say the bytes carry a CMS signature covering the
    // file, which is what makes the document evidence rather than a picture of a
    // signature.
    expect(pdf, 'the sealed PDF must carry a signature dictionary').toContain('/ByteRange');
    expect(pdf, 'the signature must be a detached CMS signature').toMatch(
      /\/SubFilter\s*\/(ETSI\.CAdES\.detached|adbe\.pkcs7\.detached)/,
    );
  } finally {
    // A production envelope left behind keeps its recipient's signing link
    // live, so a cleanup that fails fails the test, and e2e_staging then
    // publishes nothing from the run. The message names the envelope so it
    // can be deleted by hand. It leaves out the request error, whose call log
    // can carry the Authorization header.
    if (envelopeId) {
      const problem = await request
        .post(`${API}/envelope/delete`, { headers: authHeaders(), data: { envelopeId } })
        .then(
          (response) => (response.ok() ? null : `HTTP ${response.status()}`),
          () => 'the request failed',
        );

      expect.soft(problem, `envelope ${envelopeId} was not deleted; delete it by hand`).toBeNull();
    }
  }
});
