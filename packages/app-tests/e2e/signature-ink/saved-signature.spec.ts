/**
 * A saved invalid signature is never offered (G4 spec section 4.3).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the signature pad, the signing providers or
 * the profile and signup writers. The pages are driven in a real browser; the
 * only state written directly is the seed: users, envelopes, Signature rows and
 * sessions through Prisma (fixtures/signature-ink.ts).
 *
 * "Blank" is the transparent-1000x438 fixture (a fully transparent PNG at the
 * pad's 16:7 aspect). C30 also runs with ink-0p9-1000x438 (0.9% ink, refused by
 * C2), because a transparent image reads as empty on a canvas whether or not it
 * was seeded there; the sparse image makes "Draw and Upload are empty" an
 * assertion that can fail.
 *
 * | Criterion | Test                                                                                    |
 * | --------- | --------------------------------------------------------------------------------------- |
 * | C29       | C29 a blank Signature row on the envelope is not offered for the next field (V2)        |
 * | C29       | C29 control: a valid Signature row on the envelope is offered on one click (V2)         |
 * | C30       | C30 V2 signing page: a saved blank (and a saved 0.9%) signature is not inserted on click |
 * | C31       | C31 <page>: the saved blank signature is not shown, not selectable, Next waits (7 pages) |
 * | C32       | C32 <page>: a saved valid signature is pre-filled and used as today (7 pages)           |
 * | C33       | C33 profile.updateProfile refuses every value C1-C8 refuse; '' still clears             |
 * | C34       | C34 signup refuses a blank signature and creates no user                                |
 * | C31       | C31 profile page: a name-only save succeeds with a legacy blank saved signature (amendment A) |
 * | C31b      | C31b profile double save: draw and save, then a name-only save keeps the drawn signature (amendment C) |
 * | C31c      | C31c <page>: a legacy blank typed saved signature is not offered (amendment C)          |
 * | C101      | C101 <page>: a legacy blank image saved as DATA: or with leading whitespace is not offered |
 * | C101      | C101 <page>: a valid image saved with an upper-case DATA: prefix is offered as the lower-case one |
 *
 * C29 and C31 run with both the blank and the sparse image, so the "Draw and
 * Upload are empty" checks can fail on pixels. The network checks of C29-C31
 * decode every image a signing request carries and fail on any whose D1
 * coverage is at or below 0.01, as well as on the raw saved payload, so a
 * client that re-exports a blank canvas is caught too.
 *
 * C34 spends the signup rate limit (3 per IP per 3 hours): it makes exactly two
 * signup requests per run, so it can be run only once per three hours from one
 * IP. A 429 from it is a test defect (the run came too soon), never a result.
 * Rerun the file with --grep-invert C34 inside that window.
 *
 * Runs in the `ui` project.
 */
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { keepRecord } from '../fixtures/reject-seal';
import {
  auditValueOf,
  coverageOf,
  decodePng,
  errorOf,
  fieldAuditRowsOf,
  imageBytes,
  imageDataUrl,
  P,
  pixelMismatch,
  seedG4DirectTemplate,
  seedG4Envelope,
  seedInserted,
  seedSession,
  seedSessionCookie,
  trpcAsUser,
  uniqueStamp,
  validInkedDataUrl,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';
import { drawStroke } from '../fixtures/signature-ink-pad';

test.describe.configure({ mode: 'default', timeout: 120_000 });

const PDF_PAGE_SELECTOR = 'img[data-page-number]';
const BLANK = 'transparent-1000x438';
const SPARSE = 'ink-0p9-1000x438';

/** The base64 payload of a data URL; what a request body would have to contain to carry it. */
const payloadOf = (dataUrl: string) => dataUrl.slice(P.length);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** A user whose saved profile signature is `signature`, read back as the premise. */
const seedUserWithSignature = async (signature: string) => {
  const { user } = await seedUser();

  await prisma.user.update({ where: { id: user.id }, data: { signature } });

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  expect(stored.signature, 'premise: the saved signature is seeded on the user').toBe(signature);

  return stored;
};

/** A PENDING envelope whose one signer is `email`, with `count` SIGNATURE fields. */
const seedForSigner = async (internalVersion: 1 | 2, email: string, count = 1) =>
  await seedG4Envelope({
    internalVersion,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        email,
        name: 'Saved Signer',
        fields: Array.from({ length: count }, (_, index) => ({ key: `sig${index + 1}`, type: FieldType.SIGNATURE })),
      },
    ],
  });

const fieldBox = async (fieldId: number) => await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

type Scope = Page | Frame;

/** Every body sent to a signing route, to check none carries the saved invalid value. */
const recordSignRequests = (page: Page) => {
  const bodies: string[] = [];

  page.on('request', (request) => {
    const url = request.url();

    if (url.includes('envelope.field.sign') || url.includes('field.signFieldWithToken')) {
      bodies.push(request.postData() ?? '');
    }
  });

  return bodies;
};

const expectSessionValid = async (page: Page) => {
  const res = await page.context().request.get(`${WEBAPP_BASE_URL}/api/auth/session`);
  const session = (await res.json()) as { isAuthenticated?: boolean };

  expect(session.isAuthenticated, 'premise: the seeded session is accepted').toBe(true);
};

/** Opens a page, checks it answered 200 and rendered the document. */
const openPage = async (page: Page, path: string) => {
  const response = await page.goto(path);

  expect(response?.status(), `premise: GET ${path} answers 200`).toBe(200);
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
};

const konvaCanvas = (scope: Scope) => scope.locator('.konva-container canvas').first();

/** Clicks the middle of a field painted on the V2 Konva canvas. */
const clickV2Field = async (scope: Scope, fieldId: number) => {
  const canvas = konvaCanvas(scope);

  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  const field = await fieldBox(fieldId);
  const x = ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width;
  const y = ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height;

  await canvas.click({ position: { x, y } });
};

/** Pixels with alpha above zero on the canvas with `testId`, or null when the canvas is not rendered. */
const opaquePixels = async (scope: Scope, testId: string) =>
  await scope.evaluate((id) => {
    const canvas = document.querySelector(`[data-testid="${id}"]`) as HTMLCanvasElement | null;
    const context = canvas?.getContext('2d');

    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) {
      return null;
    }

    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;

    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        count++;
      }
    }

    return count;
  }, testId);

/**
 * The SignatureRender canvas the pad button shows when it holds a value
 * (signature-pad-dialog.tsx renders it only for a value), or null when none is shown.
 */
const shownSignaturePixels = async (scope: Scope) =>
  await scope.evaluate(() => {
    const button = document.querySelector('[data-testid="signature-pad-dialog-button"]');
    const canvas = button?.parentElement?.querySelector('canvas') as HTMLCanvasElement | null;
    const context = canvas?.getContext('2d');

    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) {
      return null;
    }

    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;

    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        count++;
      }
    }

    return count;
  });

/**
 * In an open signature dialog: Draw and Upload hold nothing, switching to
 * Upload and back to Draw does not enable the confirm button, and typing a
 * name does (the control that the button can be enabled at all).
 */
const expectDialogOffersNothing = async (scope: Scope, confirmName: 'Next' | 'Sign', label: string) => {
  const dialog = scope.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: confirmName, exact: true });

  await dialog.getByRole('tab', { name: 'Draw' }).click();
  await expect(scope.getByTestId('signature-pad-draw')).toBeVisible();
  expect.soft(await opaquePixels(scope, 'signature-pad-draw'), `${label}: the Draw pad is empty`).toBe(0);
  await expect.soft(confirm, `${label}: ${confirmName} is disabled on Draw`).toBeDisabled();

  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await expect(scope.getByTestId('signature-pad-upload')).toBeVisible();
  expect.soft(await opaquePixels(scope, 'signature-pad-upload'), `${label}: the Upload pad is empty`).toBe(0);
  await expect.soft(confirm, `${label}: ${confirmName} is disabled on Upload`).toBeDisabled();

  await dialog.getByRole('tab', { name: 'Draw' }).click();
  await expect.soft(confirm, `${label}: switching Upload and back does not enable ${confirmName}`).toBeDisabled();

  await dialog.getByRole('tab', { name: 'Type' }).click();
  await scope.getByTestId('signature-pad-type-input').fill('Typed Name');
  await expect(confirm, `control (${label}): typing a name enables ${confirmName}`).toBeEnabled();
};

/** Every string in a parsed request body that claims to be an image (starts with `data:` in any case). */
const imageClaimsIn = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return /^\s*data:/i.test(value) ? [value] : [];
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(imageClaimsIn);
  }

  return [];
};

/** D1 coverage of an image claim, or 0 when it does not decode as a PNG at all. */
const claimCoverage = (claim: string) => {
  try {
    return coverageOf(decodePng(Buffer.from(claim.slice(claim.indexOf(',') + 1), 'base64')));
  } catch {
    return 0;
  }
};

/**
 * No signing request carries the saved invalid value: neither its raw payload,
 * nor any image (however re-encoded) whose D1 coverage is at or below 0.01.
 */
const expectNoRequestCarries = (bodies: string[], value: string, label: string) => {
  const carrying = bodies.filter((body) => body.includes(payloadOf(value)));

  expect.soft(carrying.length, `${label}: no signing request carries the saved invalid value`).toBe(0);

  const blankImages = bodies.flatMap((body) => {
    let parsed: unknown = null;

    try {
      parsed = JSON.parse(body);
    } catch {
      return [];
    }

    return imageClaimsIn(parsed)
      .map(claimCoverage)
      .filter((coverage) => coverage <= 0.01);
  });

  expect.soft(blankImages, `${label}: no signing request carries an image at or below 1% D1 coverage`).toEqual([]);
};

// ---------------------------------------------------------------------------
// C29
// ---------------------------------------------------------------------------

for (const name of [BLANK, SPARSE]) {
  test(`C29 a ${name} Signature row on the envelope is not offered for the next field (V2)`, async ({ page }) => {
    const blank = imageDataUrl(name);
    const seeded = await seedForSigner(2, `g4-c29-${uniqueStamp()}@test.documenso.com`, 2);

    await seedInserted(seeded, 's1', 'sig1', { image: blank });

    const bodies = recordSignRequests(page);

    await openPage(page, `/sign/${seeded.r.s1.token}`);
    await expect(page.getByText('1 Field Remaining').first(), 'premise: only the second field is open').toBeVisible();
    await page.waitForTimeout(1_500);

    await clickV2Field(page, seeded.r.s1.fields.sig2.id);

    await expect(page.getByRole('dialog'), 'clicking the second field opens the dialog').toBeVisible({
      timeout: 5_000,
    });

    await expectDialogOffersNothing(page, 'Sign', `C29 ${name}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    const field = await prisma.field.findUniqueOrThrow({
      where: { id: seeded.r.s1.fields.sig2.id },
      include: { signature: true },
    });

    expect.soft(field.inserted, 'C29: the second field is not inserted').toBe(false);
    expect.soft(field.signature, 'C29: the second field has no Signature row').toBeNull();
    expectNoRequestCarries(bodies, blank, `C29 ${name}`);
  });
}

test('C29 control: a valid Signature row on the envelope is offered on one click (V2)', async ({ page }) => {
  const valid = validInkedDataUrl();
  const seeded = await seedForSigner(2, `g4-c29c-${uniqueStamp()}@test.documenso.com`, 2);

  await seedInserted(seeded, 's1', 'sig1', { image: valid });

  await openPage(page, `/sign/${seeded.r.s1.token}`);
  await expect(page.getByText('1 Field Remaining').first()).toBeVisible();
  await page.waitForTimeout(1_500);

  await clickV2Field(page, seeded.r.s1.fields.sig2.id);

  await expect
    .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: seeded.r.s1.fields.sig2.id } })).inserted, {
      message: 'the stored valid signature is inserted on one click',
      timeout: 10_000,
    })
    .toBe(true);

  const signature = await prisma.signature.findUnique({ where: { fieldId: seeded.r.s1.fields.sig2.id } });

  // Rule 3 re-encodes a stored image as an 8-bit RGBA PNG, so compare decoded size and pixels, not bytes.
  const stored = signature?.signatureImageAsBase64 ?? '';

  expect(stored.startsWith(P), 'the second field holds an image').toBe(true);

  const storedPng = decodePng(Buffer.from(stored.slice(P.length), 'base64'));
  const sourcePng = decodePng(imageBytes('valid-inked'));

  expect([storedPng.width, storedPng.height], 'the stored image has the seeded image size').toEqual([
    sourcePng.width,
    sourcePng.height,
  ]);
  expect(pixelMismatch(storedPng, sourcePng), 'the stored image has the seeded image pixels').toBeNull();

  const inserts = await fieldAuditRowsOf(seeded.envelopeId, seeded.r.s1.fields.sig2.secondaryId, [
    'DOCUMENT_FIELD_INSERTED',
  ]);

  expect(inserts.length, 'exactly one insert audit row for the second field').toBe(1);
  expect(auditValueOf(inserts[0]), 'the audit row records the stored value').toBe(stored);
});

// ---------------------------------------------------------------------------
// C30
// ---------------------------------------------------------------------------

for (const name of [BLANK, SPARSE]) {
  test(`C30 V2 signing page: a saved ${name} profile signature is not inserted on click`, async ({ page }) => {
    const saved = imageDataUrl(name);
    const user = await seedUserWithSignature(saved);
    const seeded = await seedForSigner(2, user.email);

    await seedSession(page.context(), user.id);
    await expectSessionValid(page);

    const bodies = recordSignRequests(page);

    await openPage(page, `/sign/${seeded.r.s1.token}`);
    await expect(page.getByText('1 Field Remaining').first()).toBeVisible();
    // The same wait C32 gives the valid signature before its one click.
    await page.waitForTimeout(1_500);

    await clickV2Field(page, seeded.r.s1.fields.sig1.id);

    const opened = await page
      .getByRole('dialog')
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    expect.soft(opened, 'C30: clicking the field opens the dialog instead of inserting').toBe(true);

    if (opened) {
      await expectDialogOffersNothing(page, 'Sign', `C30 ${name}`);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    }

    // Let any insert the click started land before reading the database.
    await page.waitForTimeout(1_000);

    const field = await prisma.field.findUniqueOrThrow({
      where: { id: seeded.r.s1.fields.sig1.id },
      include: { signature: true },
    });

    expect.soft(field.inserted, 'C30: the field is not inserted').toBe(false);
    expect.soft(field.signature, 'C30: no Signature row is written').toBeNull();
    expectNoRequestCarries(bodies, saved, 'C30');
  });
}

// ---------------------------------------------------------------------------
// C31 and C32: the other pages that pass the saved signature on
// ---------------------------------------------------------------------------

type Surface = {
  name: string;
  /** Seeds what the page needs for the signed-in user; returns the path and the field to click. */
  open: (email: string) => Promise<{ path: string; fieldId: number | null; v2: boolean; dbInsert: boolean }>;
};

const directPath = async (internalVersion: 1 | 2, embed: boolean) => {
  const template = await seedG4DirectTemplate(internalVersion);

  return {
    path: `${embed ? '/embed/direct' : '/d'}/${template.directToken}`,
    fieldId: template.sigFieldId,
    v2: internalVersion === 2,
    dbInsert: false,
  };
};

const SURFACES: Surface[] = [
  {
    name: 'V1 signing page',
    open: async (email) => {
      const seeded = await seedForSigner(1, email);

      return { path: `/sign/${seeded.r.s1.token}`, fieldId: seeded.r.s1.fields.sig1.id, v2: false, dbInsert: true };
    },
  },
  {
    name: 'profile page',
    open: async () => await Promise.resolve({ path: '/settings/profile', fieldId: null, v2: false, dbInsert: false }),
  },
  { name: 'V1 direct template page', open: async () => await directPath(1, false) },
  { name: 'V2 direct template page', open: async () => await directPath(2, false) },
  {
    name: 'V0 embed, V1 envelope',
    open: async (email) => {
      const seeded = await seedForSigner(1, email);

      return {
        path: `/embed/sign/${seeded.r.s1.token}`,
        fieldId: seeded.r.s1.fields.sig1.id,
        v2: false,
        dbInsert: true,
      };
    },
  },
  {
    name: 'V0 embed, V2 envelope',
    open: async (email) => {
      const seeded = await seedForSigner(2, email);

      return {
        path: `/embed/sign/${seeded.r.s1.token}`,
        fieldId: seeded.r.s1.fields.sig1.id,
        v2: true,
        dbInsert: true,
      };
    },
  },
  { name: 'V0 embed, V1 direct template', open: async () => await directPath(1, true) },
  { name: 'V0 embed, V2 direct template', open: async () => await directPath(2, true) },
];

const openSurface = async (page: Page, surface: Surface, signature: string) => {
  const user = await seedUserWithSignature(signature);
  const target = await surface.open(user.email);

  await seedSession(page.context(), user.id);
  await expectSessionValid(page);

  const response = await page.goto(target.path);

  expect(response?.status(), `premise: GET ${target.path} answers 200`).toBe(200);

  if (target.fieldId === null) {
    await expect(page.getByTestId('signature-pad-dialog-button')).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });
  }

  await continuePastDetailsStep(page);
  await page.waitForTimeout(1_500);

  return { ...target, user };
};

/**
 * The V1 direct-link page opens on a details step (heading "General") and shows
 * the fields after Continue; other pages have no such step.
 */
const continuePastDetailsStep = async (page: Page) => {
  const general = page.getByRole('heading', { name: 'General' });

  if (!(await general.isVisible().catch(() => false))) {
    return;
  }

  const email = page.getByPlaceholder('name@example.com');

  if ((await email.isEditable().catch(() => false)) && (await email.inputValue()) === '') {
    await email.fill(`g4-direct-${uniqueStamp()}@test.documenso.com`);
  }

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('signature-pad-dialog-button')).toBeVisible({ timeout: 15_000 });
};

/** Whether the field shows as filled on the page: the V1 field's data-inserted, or V2's remaining count. */
const fieldFilledOnPage = async (page: Page, target: { fieldId: number | null; v2: boolean }) => {
  if (target.v2) {
    return await page
      .getByText('0 Fields Remaining')
      .first()
      .isVisible()
      .catch(() => false);
  }

  return (await page.locator(`#field-${target.fieldId}`).getAttribute('data-inserted')) === 'true';
};

const clickField = async (page: Page, target: { fieldId: number | null; v2: boolean }) => {
  if (target.fieldId === null) {
    return;
  }

  if (target.v2) {
    await clickV2Field(page, target.fieldId);
  } else {
    await page.locator(`#field-${target.fieldId}`).getByRole('button').click();
  }

  await page.waitForTimeout(1_500);
};

for (const surface of SURFACES) {
  for (const name of [BLANK, SPARSE]) {
    test(`C31 ${surface.name}: the saved ${name} signature is not shown, not selectable, and Next waits`, async ({
      page,
    }) => {
      const blank = imageDataUrl(name);
      const label = `C31 ${surface.name} ${name}`;
      const bodies = recordSignRequests(page);
      const target = await openSurface(page, surface, blank);

      expect.soft(await shownSignaturePixels(page), `${label}: the pad button shows no saved signature`).toBeNull();

      await page.getByTestId('signature-pad-dialog-button').first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectDialogOffersNothing(page, 'Next', label);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      if (target.fieldId !== null) {
        await clickField(page, target);

        expect.soft(await fieldFilledOnPage(page, target), `${label}: the field is not filled`).toBe(false);

        // The field's own dialog (the V1 dialog on V1 pages) must offer nothing either.
        const fieldDialog = page.getByRole('dialog');
        const opened = await fieldDialog.isVisible().catch(() => false);

        expect.soft(opened, `${label}: clicking the field opens its signature dialog`).toBe(true);

        if (opened) {
          await expectDialogOffersNothing(page, 'Sign', `${label} field dialog`);
          await fieldDialog.getByRole('button', { name: 'Cancel' }).click();
        }

        if (target.dbInsert) {
          const field = await prisma.field.findUniqueOrThrow({ where: { id: target.fieldId } });

          expect.soft(field.inserted, `${label}: the field is not inserted`).toBe(false);
        }
      }

      expectNoRequestCarries(bodies, blank, label);
    });
  }
}

for (const surface of [...SURFACES, { name: 'V2 signing page', open: SURFACES[0].open, v2Page: true }]) {
  test(`C32 ${surface.name}: a saved valid signature is pre-filled and used as today`, async ({ page }) => {
    const valid = validInkedDataUrl();
    const isV2Page = 'v2Page' in surface;
    const effective: Surface = isV2Page
      ? {
          name: surface.name,
          open: async (email) => {
            const seeded = await seedForSigner(2, email);

            return {
              path: `/sign/${seeded.r.s1.token}`,
              fieldId: seeded.r.s1.fields.sig1.id,
              v2: true,
              dbInsert: true,
            };
          },
        }
      : surface;
    const target = await openSurface(page, effective, valid);

    expect
      .soft(await shownSignaturePixels(page), `C32 ${surface.name}: the pad button shows the saved signature`)
      .toBeGreaterThan(0);

    if (target.fieldId === null) {
      return;
    }

    await clickField(page, target);

    expect.soft(await fieldFilledOnPage(page, target), `C32 ${surface.name}: one click fills the field`).toBe(true);

    if (target.dbInsert) {
      await expect
        .poll(async () => (await prisma.field.findUniqueOrThrow({ where: { id: target.fieldId ?? 0 } })).inserted, {
          message: `C32 ${surface.name}: the field is inserted`,
          timeout: 10_000,
        })
        .toBe(true);
    }
  });
}

// ---------------------------------------------------------------------------
// C31, amendment after area A: a name-only profile save with a legacy blank saved signature
// ---------------------------------------------------------------------------

/**
 * Spec, "Amendments after implementation area A": a legacy invalid saved signature is kept (D2), and the
 * profile form must withhold it (send no signature or '') so that changing only the name succeeds. Red until
 * area C makes the form withhold it.
 */
for (const name of [BLANK, SPARSE]) {
  test(`C31 profile page: a name-only save succeeds for a user whose saved signature is a legacy ${name}`, async ({
    page,
  }) => {
    const legacy = imageDataUrl(name);
    const user = await seedUserWithSignature(legacy);
    const newName = `G4 Renamed ${uniqueStamp()}`;
    const bodies: string[] = [];

    page.on('request', (sent) => {
      if (sent.url().includes('profile.updateProfile')) {
        bodies.push(sent.postData() ?? '');
      }
    });

    await seedSession(page.context(), user.id);

    const response = await page.goto('/settings/profile');

    expect(response?.status(), 'premise: GET /settings/profile answers 200').toBe(200);

    const nameInput = page.locator('input[name="name"]');

    await expect(nameInput, 'premise: the profile form shows the name field').toBeVisible({ timeout: 30_000 });
    await nameInput.fill(newName);

    const saved = page.waitForResponse((reply) => reply.url().includes('profile.updateProfile'), { timeout: 15_000 });

    await page.getByRole('button', { name: 'Update profile' }).click();

    const reply = await saved.catch(() => null);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await keepRecord(`C31-name-only-${name}.json`, {
      replyStatus: reply?.status() ?? null,
      requestCarriesLegacy: bodies.map((body) => body.includes(legacy.slice(P.length, P.length + 200))),
      storedName: stored.name,
      storedSignatureIsLegacy: stored.signature === legacy,
      storedSignatureLength: stored.signature?.length ?? null,
    });

    expect.soft(reply?.status(), 'the name-only save answers 200').toBe(200);
    expect(stored.name, 'the new name is stored').toBe(newName);
    expect(
      bodies.some((body) => body.includes(legacy.slice(P.length, P.length + 200))),
      'the save request does not carry the legacy blank signature',
    ).toBe(false);
    expect(
      stored.signature === legacy || stored.signature === '' || stored.signature === null,
      'the saved signature is kept or cleared, never replaced by another value',
    ).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// C33
// ---------------------------------------------------------------------------

const valid = () => validInkedDataUrl();

/** The C6 encodings of a valid PNG data URL (spec section 2 rows C6 lists). */
const encodings = (dataUrl: string) => {
  const payload = payloadOf(dataUrl);

  return {
    'newline inside the payload': `${P}${payload.slice(0, 10)}\n${payload.slice(10)}`,
    'space inside the payload': `${P}${payload.slice(0, 10)} ${payload.slice(10)}`,
    'URL-safe alphabet': `${P}${payload.replace(/\+/g, '-').replace(/\//g, '_')}`,
    'padding removed': `${P}${payload.replace(/=+$/, '')}`,
    'percent-encoded payload': `${P}${encodeURIComponent(payload)}`,
    'DATA: upper-case scheme': `DATA:image/png;base64,${payload}`,
    'extra ;charset=utf-8 parameter': `data:image/png;charset=utf-8;base64,${payload}`,
    'data:image/png, without ;base64': `data:image/png,${payload}`,
    'data:image/jpeg;base64, around PNG bytes': `data:image/jpeg;base64,${payload}`,
  };
};

const underPrefix = (name: string) => () => `${P}${imageBytes(name).toString('base64')}`;

/** Values C1-C8 refuse, every case those criteria name. */
const REFUSED_VALUES: Array<{ label: string; value: () => string }> = [
  { label: 'C1 transparent PNG', value: () => imageDataUrl(BLANK) },
  { label: 'C2 0.9% ink', value: () => imageDataUrl(SPARSE) },
  { label: 'C3 F02 junk payload', value: () => 'data:image/png;base64,bm90LWFuLWltYWdl' },
  { label: 'C4 JPEG under the PNG prefix', value: underPrefix('jpeg-bytes') },
  { label: 'C4 SVG under the PNG prefix', value: underPrefix('svg-bytes') },
  { label: 'C4 GIF under the PNG prefix', value: underPrefix('gif-bytes') },
  { label: 'C4 WebP under the PNG prefix', value: underPrefix('webp-bytes') },
  ...[
    ['spaces only', '   '],
    ['U+00A0', '\u00A0'],
    ['U+3000', '\u3000'],
    ['U+200B', '\u200B'],
    ['U+FEFF', '\uFEFF'],
    ['tab and newline', '\t\n'],
  ].map(([label, text]) => ({ label: `C5 ${label}`, value: () => text })),
  ...Object.keys(encodings(P)).map((label) => ({
    label: `C6 ${label}`,
    value: () => encodings(valid())[label as keyof ReturnType<typeof encodings>],
  })),
  { label: 'C8 truncated inside IDAT', value: underPrefix('truncated-idat') },
];

test('C33 profile.updateProfile refuses every value C1-C8 refuse and an empty string still clears', async ({
  request,
}) => {
  const saved = valid();
  const user = await seedUserWithSignature(saved);
  const cookie = await seedSessionCookie(user.id);
  const update = async (signature: string) =>
    await trpcAsUser(request, 'profile.updateProfile', { name: 'G4 Profile', signature }, { cookie });

  // Premise: the route accepts a valid image from this session.
  const control = await update(saved);

  expect(control.status, `control: a valid signature is saved (${control.body.slice(0, 200)})`).toBe(200);
  expect(payloadOf(valid()).endsWith('='), 'premise: the payload is padded for the padding case to change').toBe(true);

  // What the route stored for the valid value (it may normalise it, rule 3); refusals must leave exactly this.
  const stored = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).signature;

  expect(stored, 'control: the valid signature is stored').toBeTruthy();

  for (const { label, value } of REFUSED_VALUES) {
    const reply = await update(value());
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect.soft(reply.status, `${label}: not rate-limited`).not.toBe(429);
    expect.soft(reply.status, `${label}: refused with 400 (${reply.body.slice(0, 200)})`).toBe(400);
    expect.soft(errorOf(reply).code, `${label}: data.code INVALID_REQUEST`).toBe('INVALID_REQUEST');
    expect.soft(after.signature, `${label}: User.signature unchanged`).toBe(stored);
  }

  const cleared = await update('');
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  expect(cleared.status, `an empty string is accepted (${cleared.body.slice(0, 200)})`).toBe(200);
  expect(after.signature ?? '', 'an empty string clears the saved signature').toBe('');
});

// ---------------------------------------------------------------------------
// C34
// ---------------------------------------------------------------------------

test('C34 signup refuses a blank signature and creates no user', async ({ request }) => {
  const signup = async (email: string, signature: string) =>
    await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/signup`, {
      headers: { 'content-type': 'application/json' },
      data: { name: 'G4 Signup', email, password: 'G4-signup-Password-1!', signature },
    });

  // Control first: proves signup is enabled here, so a refusal below is not "signup disabled".
  const controlEmail = `g4-c34-ok-${uniqueStamp()}@test.documenso.com`;
  const control = await signup(controlEmail, validInkedDataUrl());

  expect(
    control.status(),
    'test defect, not a result: signup answered 429 (3 per IP per 3 hours); C34 ran too soon after a previous run',
  ).not.toBe(429);
  // The signup route answers 201 Created (observed in the first run of this test).
  expect(control.status(), `control: signup with a valid signature succeeds (${await control.text()})`).toBe(201);
  expect(await prisma.user.count({ where: { email: controlEmail } }), 'control: the user exists').toBe(1);

  const blankEmail = `g4-c34-blank-${uniqueStamp()}@test.documenso.com`;
  const refused = await signup(blankEmail, imageDataUrl(BLANK));

  const refusedBody = await refused.text();

  expect(refused.status(), 'test defect, not a result: the blank signup answered 429 (signup rate limit)').not.toBe(
    429,
  );
  expect.soft(refused.status(), `the blank signature is refused (${refusedBody.slice(0, 200)})`).toBe(400);
  expect
    .soft(
      (() => {
        try {
          return JSON.stringify(JSON.parse(refusedBody));
        } catch {
          return refusedBody;
        }
      })(),
      'the refusal names INVALID_REQUEST',
    )
    .toContain('INVALID_REQUEST');
  expect(await prisma.user.count({ where: { email: blankEmail } }), 'no user is created for the blank signup').toBe(0);
});

// ---------------------------------------------------------------------------
// C31b and C31c (spec, "Amendments after implementation area C")
// ---------------------------------------------------------------------------

/** Clicks Update profile and returns the profile.updateProfile response status (null when none is sent). */
const saveProfile = async (page: Page) => {
  const saved = page.waitForResponse((reply) => reply.url().includes('profile.updateProfile'), { timeout: 15_000 });

  await page.getByRole('button', { name: 'Update profile' }).click();

  const reply = await saved.catch(() => null);

  return reply?.status() ?? null;
};

const storedUser = async (userId: number) => await prisma.user.findUniqueOrThrow({ where: { id: userId } });

for (const start of [
  { label: 'a valid saved signature', value: () => validInkedDataUrl() },
  { label: `a legacy ${BLANK} saved signature`, value: () => imageDataUrl(BLANK) },
]) {
  test(`C31b profile double save, starting from ${start.label}: a name-only save keeps the drawn signature`, async ({
    page,
  }) => {
    const initial = start.value();
    const user = await seedUserWithSignature(initial);

    await seedSession(page.context(), user.id);

    const response = await page.goto('/settings/profile');

    expect(response?.status(), 'premise: GET /settings/profile answers 200').toBe(200);
    await expect(page.getByTestId('signature-pad-dialog-button')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);

    // First save: draw a new signature and save it.
    await page.getByTestId('signature-pad-dialog-button').click();

    const dialog = page.getByRole('dialog');

    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Draw' }).click();
    await drawStroke(page, page.getByTestId('signature-pad-draw'));

    const next = dialog.getByRole('button', { name: 'Next', exact: true });

    await expect(next, 'premise: the drawn stroke enables Next').toBeEnabled();
    await next.click();
    await expect(dialog).toBeHidden();

    const firstStatus = await saveProfile(page);
    const afterFirst = await storedUser(user.id);
    const drawn = afterFirst.signature ?? '';

    expect(firstStatus, 'the first save (the drawn signature) answers 200').toBe(200);
    expect(drawn.startsWith(P), 'the first save stores an image').toBe(true);
    expect(drawn, 'the first save replaces the starting signature').not.toBe(initial);
    expect(
      coverageOf(decodePng(Buffer.from(payloadOf(drawn), 'base64'))),
      'the stored drawing has ink above 1%',
    ).toBeGreaterThan(0.01);

    // Second save: change only the name, on the same page.
    const newName = `G4 Twice ${uniqueStamp()}`;

    await page.locator('input[name="name"]').fill(newName);

    const secondStatus = await saveProfile(page);
    const afterSecond = await storedUser(user.id);

    await keepRecord(`C31b-${start.label.replace(/[^a-z0-9]+/gi, '-')}.json`, {
      firstStatus,
      secondStatus,
      drawnLength: drawn.length,
      secondSignatureIsDrawn: afterSecond.signature === drawn,
      secondSignatureIsInitial: afterSecond.signature === initial,
      secondSignatureLength: afterSecond.signature?.length ?? null,
      storedName: afterSecond.name,
    });

    expect(secondStatus, 'the name-only save answers 200').toBe(200);
    expect(afterSecond.name, 'the new name is stored').toBe(newName);
    expect(afterSecond.signature, 'the name-only save keeps the drawn signature').toBe(drawn);
  });
}

/** Legacy typed saved signatures with no letter, number, punctuation or symbol (whitespace and control only). */
const BLANK_TYPED = [
  { label: 'three spaces', value: '   ' },
  { label: 'tab, newline and BEL', value: '\t\n\u0007' },
];

/**
 * In an open signature dialog, the Type tab does not hold the saved value. It may hold the upstream full-name
 * prefill, as it does for a user with no saved signature (spec, C31c correction), so the confirm button is not
 * checked before typing.
 */
const expectTypedNotOffered = async (scope: Scope, confirmName: 'Next' | 'Sign', label: string, saved: string) => {
  const dialog = scope.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: confirmName, exact: true });

  await dialog.getByRole('tab', { name: 'Type' }).click();

  const input = scope.getByTestId('signature-pad-type-input');

  await expect(input).toBeVisible();
  expect.soft(await input.inputValue(), `${label}: the Type tab does not hold the saved value`).not.toBe(saved);

  await input.fill('Typed Name');
  await expect(confirm, `control (${label}): typing a name enables ${confirmName}`).toBeEnabled();
};

/** No signing request carries the saved typed value as the value sent. */
const expectNoRequestCarriesTyped = (bodies: string[], value: string, label: string) => {
  const needle = JSON.stringify(value);
  const carrying = bodies.filter((body) => body.includes(`"value":${needle}`));

  expect.soft(carrying.length, `${label}: no signing request carries the saved blank typed value`).toBe(0);
};

const C31C_SURFACES: Surface[] = [
  ...SURFACES,
  {
    name: 'V2 signing page',
    open: async (email) => {
      const seeded = await seedForSigner(2, email);

      return { path: `/sign/${seeded.r.s1.token}`, fieldId: seeded.r.s1.fields.sig1.id, v2: true, dbInsert: true };
    },
  },
];

for (const surface of C31C_SURFACES) {
  for (const typed of BLANK_TYPED) {
    test(`C31c ${surface.name}: a legacy typed signature of ${typed.label} is not offered`, async ({ page }) => {
      const label = `C31c ${surface.name} ${typed.label}`;
      const bodies = recordSignRequests(page);
      const target = await openSurface(page, surface, typed.value);

      if (target.fieldId === null) {
        // The profile page: the pad dialog must not hold the saved value.
        await page.getByTestId('signature-pad-dialog-button').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectTypedNotOffered(page, 'Next', label, typed.value);

        return;
      }

      await clickField(page, target);

      const fieldDialog = page.getByRole('dialog');
      const opened = await fieldDialog
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      expect.soft(opened, `${label}: clicking the field opens the dialog instead of inserting`).toBe(true);
      expect.soft(await fieldFilledOnPage(page, target), `${label}: the field is not filled`).toBe(false);

      if (opened) {
        await expectTypedNotOffered(page, 'Sign', `${label} field dialog`, typed.value);
        await fieldDialog.getByRole('button', { name: 'Cancel' }).click();
      }

      // Let any insert the click started land before reading the database.
      await page.waitForTimeout(1_000);

      if (target.dbInsert) {
        const field = await prisma.field.findUniqueOrThrow({
          where: { id: target.fieldId },
          include: { signature: true },
        });

        expect.soft(field.inserted, `${label}: the field is not inserted`).toBe(false);
        expect.soft(field.signature, `${label}: no Signature row is written`).toBeNull();
      }

      expectNoRequestCarriesTyped(bodies, typed.value, label);
    });
  }
}

// ---------------------------------------------------------------------------
// C101 (spec, "Round after Codex r1"): the page classifies a saved value as the server does
// ---------------------------------------------------------------------------

/** The saved value with its `data:` prefix written in upper case. */
const upperCasePrefix = (dataUrl: string) => `DATA:${dataUrl.slice('data:'.length)}`;

/** The legacy transparent image in the two spellings the server reads as an image and a strict prefix check misses. */
const C101_BLANK_SPELLINGS = [
  { label: 'DATA: upper-case prefix', value: () => upperCasePrefix(imageDataUrl(BLANK)) },
  { label: 'leading whitespace', value: () => `  \n${imageDataUrl(BLANK)}` },
];

/** What the Type tab of the pad dialog holds when opened from the pad button, then the dialog is closed. */
const typeTabValue = async (page: Page) => {
  await page.getByTestId('signature-pad-dialog-button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('tab', { name: 'Type' }).click();

  const value = await page.getByTestId('signature-pad-type-input').inputValue();

  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  return value;
};

for (const surface of C31C_SURFACES) {
  for (const spelling of C101_BLANK_SPELLINGS) {
    test(`C101 ${surface.name}: a legacy blank image saved with ${spelling.label} is not offered`, async ({ page }) => {
      const saved = spelling.value();
      const label = `C101 ${surface.name} ${spelling.label}`;
      const bodies = recordSignRequests(page);
      const target = await openSurface(page, surface, saved);

      expect.soft(await shownSignaturePixels(page), `${label}: the pad button shows no saved signature`).toBeNull();

      await page.getByTestId('signature-pad-dialog-button').first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('tab', { name: 'Type' }).click();
      expect
        .soft(
          await page.getByTestId('signature-pad-type-input').inputValue(),
          `${label}: the Type tab does not hold the saved value as text`,
        )
        .not.toContain('base64');
      await expectDialogOffersNothing(page, 'Next', label);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      if (target.fieldId !== null) {
        await clickField(page, target);

        expect.soft(await fieldFilledOnPage(page, target), `${label}: the field is not filled`).toBe(false);

        const fieldDialog = page.getByRole('dialog');
        const opened = await fieldDialog
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);

        expect.soft(opened, `${label}: clicking the field opens an empty signature dialog`).toBe(true);

        if (opened) {
          await expectDialogOffersNothing(page, 'Sign', `${label} field dialog`);
          await fieldDialog.getByRole('button', { name: 'Cancel' }).click();
        }

        await page.waitForTimeout(1_000);

        if (target.dbInsert) {
          const field = await prisma.field.findUniqueOrThrow({ where: { id: target.fieldId } });

          expect.soft(field.inserted, `${label}: the field is not inserted`).toBe(false);
        }
      }

      const payload = imageDataUrl(BLANK).slice(P.length);

      expect
        .soft(
          bodies.filter((body) => body.includes(payload.slice(0, 200))).length,
          `${label}: no signing request carries the saved value`,
        )
        .toBe(0);
      expectNoRequestCarries(bodies, imageDataUrl(BLANK), label);
    });
  }

  test(`C101 ${surface.name}: a valid image saved with an upper-case DATA: prefix is offered as the lower-case one is`, async ({
    page,
  }) => {
    const label = `C101 ${surface.name} upper-case valid`;

    // The lower-case spelling first: what the page offers for the same image under the strict prefix.
    const lowerUser = (await openSurface(page, surface, validInkedDataUrl())).user;

    const lowerPixels = await shownSignaturePixels(page);
    const lowerTyped = await typeTabValue(page);

    expect(lowerPixels ?? 0, `premise (${label}): the lower-case image is shown on the pad button`).toBeGreaterThan(0);

    const upperUser = (await openSurface(page, surface, upperCasePrefix(validInkedDataUrl()))).user;

    const upperPixels = await shownSignaturePixels(page);
    const upperTyped = await typeTabValue(page);

    await keepRecord(`C101-${surface.name.replace(/[^a-z0-9]+/gi, '-')}-upper.json`, {
      lowerPixels,
      upperPixels,
      lowerTyped,
      lowerName: lowerUser.name,
      upperTyped: upperTyped.slice(0, 60),
      upperName: upperUser.name,
    });

    // Each user is seeded with a random name, which pre-fills the Type tab (C31c), so each tab is compared with its
    // own user's name rather than with the other's (spec, "Amendments after the Codex r1 green run").
    expect.soft(lowerTyped, `premise (${label}): the Type tab holds the lower-case user's name`).toBe(lowerUser.name);
    expect.soft(upperTyped, `${label}: the Type tab does not hold the saved value as text`).not.toContain('base64');
    expect.soft(upperTyped, `${label}: the Type tab holds the upper-case user's own name`).toBe(upperUser.name);
    expect
      .soft(
        Math.abs((upperPixels ?? 0) - (lowerPixels ?? 0)) / (lowerPixels ?? 1),
        `${label}: the pad button shows the image as it does for the lower-case spelling (${upperPixels} vs ${lowerPixels} pixels)`,
      )
      .toBeLessThanOrEqual(0.05);
  });
}
